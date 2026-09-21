"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startMockUpstream } = require("./helpers/mock-upstream.cjs");
const { startBridge, stopBridge, waitForHealth } = require("./helpers/bridge-process.cjs");

const SETUP = path.join(__dirname, "..", "scripts", "setup.cjs");
const DOCTOR = path.join(__dirname, "..", "scripts", "doctor.cjs");
const BRIDGE_JS = path.join(__dirname, "..", "bridge.js");
const TEST_KEY = "ts_test_fake123456789012";

/** Async spawn helper (spawnSync would deadlock against our own servers). */
function runCli(script, args, opts = {}) {
  return new Promise((resolve) => {
    // stdin must be a writable pipe so --key-stdin can be fed; when no input
    // is given we end it immediately (an empty stream, not /dev/null).
    const child = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(opts.input !== undefined ? opts.input : "");
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout || 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** rmSync that survives Windows read-only/locked leftovers. */
function rmRf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Last resort on Windows: clear read-only bits then retry once.
    try {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else fs.chmodSync(p, 0o666);
        }
      };
      walk(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* leave the tmp dir; the OS cleans tmp eventually */ }
  }
}

function tempBridgeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-setup-"));
  // setup.cjs derives paths from __dirname, so a full copy is needed for an
  // isolated run. Copy the scripts + lib + a stub bridge (lightweight).
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(SETUP, path.join(dir, "scripts", "setup.cjs"));
  fs.copyFileSync(DOCTOR, path.join(dir, "scripts", "doctor.cjs"));
  fs.copyFileSync(path.join(__dirname, "..", "lib", "ui.cjs"), path.join(dir, "lib", "ui.cjs"));
  fs.copyFileSync(BRIDGE_JS, path.join(dir, "bridge.js"));
  fs.writeFileSync(path.join(dir, "requirements.txt"), "typesafe-sdk>=0.1\n");
  return dir;
}

test("setup --dry-run changes nothing and never needs a key", async () => {
  const dir = tempBridgeDir();
  try {
    const r = await runCli(path.join(dir, "scripts", "setup.cjs"), ["--dry-run", "--yes"], {
      cwd: dir,
      input: `${TEST_KEY}\n`,
      env: { TYPESAFE_BRIDGE_PORT: "18499" },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok((r.stdout + r.stderr).includes("[dry-run]"), "dry-run prints its plan");
    assert.ok(!r.stdout.includes(TEST_KEY) && !r.stderr.includes(TEST_KEY), "key leaked in dry-run output");
    assert.ok(!fs.existsSync(path.join(dir, ".env")), "dry-run must not write .env");
  } finally {
    rmRf(dir);
  }
});

test("setup writes a UTF-8/LF .env, key never in output, idempotent second run", async () => {
  const dir = tempBridgeDir();
  try {
    // No bridge started (foreground default) — the smoke step must degrade
    // gracefully, not fail. Use an unreachable live-check-less run.
    const r1 = await runCli(path.join(dir, "scripts", "setup.cjs"), ["--yes", "--key-stdin"], {
      cwd: dir,
      input: `${TEST_KEY}\n`,
      env: { TYPESAFE_BRIDGE_PORT: "18499" },
    });
    assert.strictEqual(r1.status, 0, `stderr: ${r1.stderr}`);
    assert.ok(!r1.stdout.includes(TEST_KEY) && !r1.stderr.includes(TEST_KEY), "key leaked to stdout/stderr");

    const envBytes = fs.readFileSync(path.join(dir, ".env"));
    assert.ok(!envBytes.includes(13), ".env contains CR (not LF-only)");
    assert.ok(envBytes[0] !== 0xef, ".env must not have a BOM");
    assert.ok(envBytes.toString("utf8").includes(`TYPESAFE_API_KEY=${TEST_KEY}`), "key written");

    // Second run: existing key is picked up, no prompt, still exit 0.
    const r2 = await runCli(path.join(dir, "scripts", "setup.cjs"), ["--yes", "--key-stdin"], {
      cwd: dir,
      input: "",
      env: { TYPESAFE_BRIDGE_PORT: "18499" },
    });
    assert.strictEqual(r2.status, 0, `second run stderr: ${r2.stderr}`);
    assert.ok(r2.stderr.includes("using existing"), "second run reuses the .env key");
    assert.strictEqual(
      fs.readFileSync(path.join(dir, ".env"), "utf8").includes(TEST_KEY),
      true,
      "key still present"
    );
  } finally {
    rmRf(dir);
  }
});

test("setup rejects a malformed key with a hint and writes nothing", async () => {
  const dir = tempBridgeDir();
  try {
    const r = await runCli(path.join(dir, "scripts", "setup.cjs"), ["--yes", "--key-stdin"], {
      cwd: dir,
      input: "sk-not-a-typesafe-key\n",
      env: { TYPESAFE_BRIDGE_PORT: "18499" },
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /does not look like a TypeSafe key/);
    assert.ok(!fs.existsSync(path.join(dir, ".env")));
    assert.ok(!r.stderr.includes("sk-not-a-typesafe-key"), "rejected value echoed back");
  } finally {
    rmRf(dir);
  }
});

test("setup handles a busy port by moving to the next free one", async () => {
  const up = await startMockUpstream(); // occupies a port
  const busyPort = Number(new URL(up.url).port);
  const dir = tempBridgeDir();
  try {
    const r = await runCli(path.join(dir, "scripts", "setup.cjs"), ["--dry-run", "--yes", "--port", String(busyPort)], {
      cwd: dir,
      input: `${TEST_KEY}\n`,
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!r.stderr.includes("FAILED"), `preflight failed: ${r.stderr}`);
  } finally {
    rmRf(dir);
    await up.close();
  }
});

test("doctor exits 1 and names the problem when the key is missing or malformed", async () => {
  const dir = tempBridgeDir();
  try {
    // missing .env
    const r1 = await runCli(path.join(dir, "scripts", "doctor.cjs"), [], { cwd: dir });
    assert.strictEqual(r1.status, 1);
    assert.match(r1.stdout, /\.env present/);

    // malformed key
    fs.writeFileSync(path.join(dir, ".env"), "TYPESAFE_API_KEY=oops\n");
    const r2 = await runCli(path.join(dir, "scripts", "doctor.cjs"), [], { cwd: dir });
    assert.strictEqual(r2.status, 1);
    assert.match(r2.stdout, /key shape valid/);
    assert.ok(!r2.stdout.includes("oops"), "malformed value echoed");

    // --json works (the JSON object is printed after the checklist lines —
    // slice from the first line that opens the object to the end).
    const r3 = await runCli(path.join(dir, "scripts", "doctor.cjs"), ["--json"], { cwd: dir });
    const lines = r3.stdout.split("\n");
    const start = lines.findIndex((l) => l.trim() === "{");
    assert.ok(start !== -1, `no JSON block in output: ${r3.stdout.slice(0, 200)}`);
    const parsed = JSON.parse(lines.slice(start).join("\n"));
    assert.strictEqual(parsed.ok, false);
    assert.ok(Array.isArray(parsed.results));
  } finally {
    rmRf(dir);
  }
});

test("banner (colors disabled) is plain, greppable and hides no required line", async () => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url, NO_COLOR: "1" });
  try {
    // Fetch the banner from the child's captured output via a fresh child:
    // startBridge captures only health; spawn one more with output capture.
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [BRIDGE_JS], {
      env: { ...process.env, TYPESAFE_BRIDGE_PORT: "18601", TYPESAFE_API_BASE: up.url, NO_COLOR: "1", TYPESAFE_API_KEY: "ts_test_fake123456789012" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    await waitForHealth("http://127.0.0.1:18601");
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(out.includes("typesafe-jev-bridge v"), "banner shows name+version");
    assert.ok(out.includes("Bridge running"), "banner shows running line");
    assert.ok(out.includes("Base URL"), "banner shows Base URL");
    assert.ok(out.includes("sk-typesafe-bridge"), "banner shows placeholder key");
    assert.ok(!out.includes("ts_test_fake123456789012"), "banner must never show the real key");
    assert.ok(!out.includes("\x1b["), "NO_COLOR must disable ANSI escapes");
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});
