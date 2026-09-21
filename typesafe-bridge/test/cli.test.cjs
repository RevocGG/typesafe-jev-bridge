"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startMockUpstream } = require("./helpers/mock-upstream.cjs");
const { startBridge, stopBridge } = require("./helpers/bridge-process.cjs");

const ASK = path.join(__dirname, "..", "ask-jev.cjs");
const AUDIT = path.join(__dirname, "..", "audit.cjs");
const AUTOFIX = path.join(__dirname, "..", "autofix.cjs");
// The real .env lives at <repo>/typesafe-bridge/.env; node --test may run with
// either the repo root or typesafe-bridge as cwd, so always pass an ABSOLUTE
// path for sensitive-file refusal tests.
const DOTENV = path.join(__dirname, "..", ".env");
// audit/autofix only accept explicit paths inside the repo root, so fixture
// files for those tools must be created under the repo (git-ignored patterns
// do not match "jev-audit*", and the tests clean up after themselves).
const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Run a CLI script asynchronously and collect stdout/stderr.
 *
 * NOTE: this MUST NOT be spawnSync. spawnSync blocks the parent event loop,
 * so any server owned by this process (the mock upstream, the test bridge)
 * cannot answer the child's requests — the child deadlocks until the timeout.
 */
function runCli(script, args, opts = {}) {
  const timeoutMs = opts.timeout || 20000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: err });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, error: signal === "SIGKILL" ? new Error("timed out") : null });
    });
  });
}

const runAsk = (args, opts = {}) => runCli(ASK, args, opts);
const runAudit = (args, opts = {}) => runCli(AUDIT, args, opts);

test("ask-jev --help exits 0 and documents flags", async () => {
  const r = await runAsk(["--help"]);
  assert.strictEqual(r.status, 0);
  for (const token of ["--type", "--criteria", "--min-conf", "--json", "--text-file", "--allow-remote", "EXIT CODES"]) {
    assert.ok(r.stdout.includes(token), `help mentions ${token}`);
  }
  assert.ok(!r.stdout.includes("ask-jev.mjs"), "no stale .mjs filename");
});

test("ask-jev usage errors exit 2", async () => {
  assert.strictEqual((await runAsk(["--bogus"])).status, 2);
  assert.strictEqual((await runAsk(["--q", "x", "--type", "bogus"])).status, 2);
  assert.strictEqual((await runAsk(["--q", "x", "--min-conf", "abc"])).status, 2);
  assert.strictEqual((await runAsk(["--file", DOTENV, "--q", "x"])).status, 2); // sensitive (exists)
  assert.strictEqual((await runAsk(["--q", "x", "--min-conf", "abc", "--text", "y"])).status, 2);
  assert.strictEqual((await runAsk(["--text", "y"])).status, 2); // missing --q
});

test("ask-jev refuses sensitive files with a reason (no --allow-sensitive)", async () => {
  const r = await runAsk(["--file", DOTENV, "--q", "x"]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /refusing to read/);
  assert.match(r.stderr, /sensitive file/);
});

test("ask-jev requires --allow-remote for non-loopback --url", async () => {
  const r = await runAsk(["--text", "hi", "--q", "x?", "--url", "http://evil.example.com"]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /allow-remote/);
});

test("ask-jev redacts by default and masks the preview (regression item 2)", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-cli-"));
    const f = path.join(dir, "leaky.txt");
    fs.writeFileSync(f, "TYPESAFE_API_KEY=ts_live_abcdef1234567890\nnormal prose line\n");
    const r = await runAsk(["--file", f, "--q", "Does this config look safe?", "--url", bridge.base]);
    try {
      // stderr shows kinds only — never the value.
      assert.match(r.stderr, /masked [0-9]+ potential secret/);
      assert.ok(!r.stderr.includes("ts_live_abcdef1234567890"), "value leaked to stderr");
      // The bridge received the redacted state.
      assert.strictEqual(up.requests.length, 1);
      assert.ok(!up.requests[0].body.state.includes("ts_live_abcdef1234567890"), "value sent upstream");
      assert.ok(up.requests[0].body.state.includes("[REDACTED"));
      assert.strictEqual(r.status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("ask-jev --no-redact warns and sends raw; --json is machine-readable; uncertain exits 3", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await runAsk(["--text", "plain hello", "--q", "Is this urgent?", "--url", bridge.base, "--no-redact"]);
    assert.match(r.stderr, /--no-redact/);
    assert.strictEqual(up.requests[0].body.state.includes("plain hello"), true);

    // noul 0.9 → confident exit 0
    const ok = await runAsk(["--text", "x", "--q", "Is this urgent?", "--url", bridge.base]);
    assert.strictEqual(ok.status, 0);

    // noul 0.2 (mock answers 0.2 for non-urgent) → NO confident, exit 0
    const no = await runAsk(["--text", "x", "--q", "Is this calm?", "--url", bridge.base]);
    assert.strictEqual(no.status, 0);

    // score confidence 0.8 > 0.55 → exit 0; low-confidence path: use --min-conf 0.95 → exit 3
    const unc = await runAsk([
      "--text", "x", "--q", "How severe?", "--type", "score",
      "--criteria", "Minor, Moderate, Major, Critical",
      "--min-conf", "0.95", "--url", bridge.base,
    ]);
    assert.strictEqual(unc.status, 3);

    const js = await runAsk(["--text", "x", "--q", "Is this urgent?", "--url", bridge.base, "--json"]);
    const parsed = JSON.parse(js.stdout);
    assert.ok(parsed.answers.answer);
    assert.ok(typeof parsed.answers.answer.value === "number");
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("audit flag parsing works in any order; missing file exits 2 (regression)", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    // audit refuses explicit paths outside the repo root, so the fixture must
    // live INSIDE the repo for the in-bounds assertion.
    const dir = fs.mkdtempSync(path.join(REPO_ROOT, "jev-audit-fixture-"));
    const f = path.join(dir, "app.js");
    fs.writeFileSync(f, "const x = 1;\n");
    try {
      // flags BEFORE the file — the old parser ignored the file in this order
      const r = await runAudit(["--min-score", "3.5", f, "--concurrency", "2"], {
        env: { TYPESAFE_BRIDGE_URL: bridge.base },
      });
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes("app.js"), `audited the explicit file (stdout: ${r.stdout.slice(0, 200)})`);
      assert.ok(!r.stdout.includes("bridge.js"), "did not fall back to whole-repo audit");

      // explicit sensitive path is refused
      const envAudit = await runAudit([DOTENV], { env: { TYPESAFE_BRIDGE_URL: bridge.base } });
      assert.match(envAudit.stderr || envAudit.stdout, /refusing|sensitive/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("audit --fail-on error exits 1 when the bridge is down", async () => {
  // The fixture is outside the repo root, but --fail-on error must exit 1 for
  // the READ error before any path check matters; audit reads via absolute path.
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, "jev-audit2-fixture-"));
  const f = path.join(dir, "a.js");
  fs.writeFileSync(f, "const x = 1;\n");
  try {
    const r = await runAudit([f, "--fail-on", "error"], {
      env: { TYPESAFE_BRIDGE_URL: "http://127.0.0.1:1" },
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /error/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("autofix --plan-only judges without calling the fix model; dry-run writes nothing", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const dir = fs.mkdtempSync(path.join(REPO_ROOT, "jev-autofix-fixture-"));
    const f = path.join(dir, "sample.js");
    const original = "const x = 1;\nconst y = 2;\n";
    fs.writeFileSync(f, original);
    const mtimeBefore = fs.statSync(f).mtimeMs;
    try {
      // No AUTOFIX_FALLBACK_MODELS configured: plan-only must still work (Jev only).
      const r = await runCli(AUTOFIX, [f, "--plan-only"], {
        env: { TYPESAFE_BRIDGE_URL: bridge.base, AUTOFIX_FALLBACK_MODELS: "" },
      });
      assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes("sample.js"), `planned the file (stdout: ${r.stdout.slice(0, 300)})`);
      // plan-only must not call any fix model: only the Jev judgement hit the bridge.
      assert.strictEqual(fs.readFileSync(f, "utf8"), original, "file content unchanged");
      assert.ok(fs.statSync(f).mtimeMs >= mtimeBefore - 1, "file not rewritten");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("autofix without any fix-model config refuses with setup help and exits 2", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const dir = fs.mkdtempSync(path.join(REPO_ROOT, "jev-autofix2-fixture-"));
    const f = path.join(dir, "sample.js");
    fs.writeFileSync(f, "const x = 1;\n");
    try {
      const r = await runCli(AUTOFIX, [f], {
        env: {
          TYPESAFE_BRIDGE_URL: bridge.base,
          AUTOFIX_FALLBACK_MODELS: "",
          ROUTER_9_API_KEY: "",
          AUTOFIX_MODEL: "",
        },
      });
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr || r.stdout, /AUTOFIX_FALLBACK_MODELS|No fix-model/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});
