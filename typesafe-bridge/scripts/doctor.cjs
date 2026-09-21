#!/usr/bin/env node
"use strict";
/**
 * scripts/doctor.cjs — read-only health checklist for typesafe-jev-bridge.
 *
 * Checks: Node version; .env presence/readability/encoding/key shape/
 * permissions/git-tracking; port state; bridge /health + /v1/models; version
 * match between the running bridge and package.json; BRIDGE_TOKEN /
 * BRIDGE_ALLOWED_ORIGINS sanity; optional 9Router + Python detection;
 * .gitignore coverage for .env and backups.
 *
 * Exit codes: 0 all good (warnings allowed), 1 any ✗, 2 usage.
 * Flags: --json (machine-readable), --no-color, --help
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const child = require("node:child_process");
const ui = require("../lib/ui.cjs");
const { keyHardProblem, keyHint } = require("../lib/env.cjs");

const BRIDGE_DIR = path.join(__dirname, "..");
const ROOT = path.join(BRIDGE_DIR, "..");
const ENV_FILE = path.join(BRIDGE_DIR, ".env");
const PID_FILE = path.join(BRIDGE_DIR, ".bridge.pid");
// (key-shape checks moved to lib/env.cjs: KEY_HINT_RE / keyHardProblem / keyHint)

function usage(code) {
  (code === 0 ? process.stdout : process.stderr).write(
    "usage: node scripts/doctor.cjs [--json] [--no-color]\n" +
      "Read-only checklist. Exit 1 when any check fails, 0 otherwise.\n"
  );
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage(0);
if (args.includes("--no-color")) process.argv.push("--no-color");
const AS_JSON = args.includes("--json");

const results = [];
function record(name, status, detail, hint) {
  // status: "ok" | "warn" | "fail"
  results.push({ name, status, detail: detail || "", hint: hint || "" });
  if (!AS_JSON) {
    const mark = status === "ok" ? ui.ok(name) : status === "warn" ? ui.warn(name) : ui.fail(name);
    let line = `  ${mark}`;
    if (detail) line += ui.dim(`  ${detail}`);
    console.log(line);
    if (hint && status !== "ok") console.log(`      ${ui.yellow("hint: " + hint)}`);
  }
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs || 3000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    } catch (e) {
      resolve({ status: 0, body: "", error: e.message });
    }
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function gitTracked(rel) {
  try {
    child.execSync(`git ls-files --error-unmatch -- "${rel}"`, { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

async function main() {
  // 1. Node version
  const major = parseInt(process.versions.node.split(".")[0], 10);
  record(
    "Node >= 18",
    major >= 18 ? "ok" : "fail",
    `v${process.versions.node}`,
    major >= 18 ? "" : "install an LTS from nodejs.org"
  );

  // 2. .env file
  let envText = null;
  if (!fs.existsSync(ENV_FILE)) {
    record(".env present", "fail", "typesafe-bridge/.env not found", "run `npm run setup` or copy .env.example");
  } else {
    record(".env present", "ok");
    const buf = fs.readFileSync(ENV_FILE);
    const bom = buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : buf[0] === 0xef && buf[1] === 0xbb ? "utf8-bom" : "utf8";
    record(
      ".env encoding is UTF-8",
      bom === "utf8" || bom === "utf8-bom" ? "ok" : "fail",
      bom,
      bom === "utf16le" ? "re-save as UTF-8 (run `npm run setup` to rewrite it)" : ""
    );
    envText = buf.toString("utf8");
    const m = /^TYPESAFE_API_KEY=(.*)$/m.exec(envText);
    const key = m ? m[1].trim() : "";
    if (!key) {
      record("key usable", "fail", "TYPESAFE_API_KEY missing", "run `npm run setup`");
    } else if (keyHardProblem(key)) {
      record("key usable", "fail", keyHardProblem(key), "run `npm run setup` and re-enter the key");
    } else {
      const hint = keyHint(key);
      // Shape is informational only — a non-matching prefix is a note, never a fail.
      record("key usable", "ok", hint || `prefix ${key.slice(0, key.indexOf("_") + 1)}… (shape only, value never shown)`, hint || "");
    }
    if (process.platform !== "win32") {
      let mode = null;
      try {
        mode = fs.statSync(ENV_FILE).mode & 0o777;
      } catch {}
      record(
        ".env permissions 600",
        mode === null ? "warn" : (mode & 0o077) === 0 ? "ok" : "warn",
        mode === null ? "stat failed" : `mode ${mode.toString(8)}`,
        mode !== null && (mode & 0o077) !== 0 ? "run: chmod 600 typesafe-bridge/.env" : ""
      );
    }
    record(
      ".env not tracked by git",
      gitTracked("typesafe-bridge/.env") ? "fail" : "ok",
      "",
      gitTracked("typesafe-bridge/.env") ? "git rm --cached typesafe-bridge/.env" : ""
    );
  }

  // 3. Port state
  const PORT = Number(process.env.TYPESAFE_BRIDGE_PORT) || 8399;
  const free = await portFree(PORT);
  record(
    `port ${PORT}`,
    free ? "warn" : "ok",
    free ? "free (bridge not running)" : "in use (bridge appears to be running)",
    ""
  );

  // 4. Bridge /health and /v1/models
  const health = await httpGet(`http://127.0.0.1:${PORT}/health`);
  if (health.status === 200) {
    let h = {};
    try { h = JSON.parse(health.body); } catch {}
    record("bridge /health", "ok", `v${h.version}, hasEnvKey=${h.hasEnvKey}`);
    if (!h.hasEnvKey) {
      record("bridge loaded the key", "fail", "hasEnvKey=false", "restart the bridge after fixing .env");
    }
    const models = await httpGet(`http://127.0.0.1:${PORT}/v1/models`);
    const okModels = models.status === 200 && models.body.includes("typesafe/jev-latest");
    record("bridge /v1/models", okModels ? "ok" : "fail", okModels ? "typesafe/jev-latest listed" : `status ${models.status}`);
    // 5. Version match
    let pkgVersion = "0.0.0";
    try { pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch {}
    if (h.version && h.version !== pkgVersion) {
      record(
        "version match (running vs files)",
        "warn",
        `bridge v${h.version} vs package.json ${pkgVersion}`,
        "restart the bridge to pick up the current files"
      );
    } else {
      record("version match (running vs files)", "ok", `v${pkgVersion}`);
    }
  } else {
    record(
      "bridge /health",
      "fail",
      health.error ? health.error : `status ${health.status}`,
      "start it with `npm start` (or `npm run setup -- --background`)"
    );
  }

  // 6. BRIDGE_TOKEN / BRIDGE_ALLOWED_ORIGINS sanity
  const token = process.env.BRIDGE_TOKEN || "";
  record(
    "BRIDGE_TOKEN",
    token ? "ok" : "warn",
    token ? `set (length ${token.length})` : "not set — any local process can use the bridge",
    token ? "" : "recommended: set BRIDGE_TOKEN and give it to your tools"
  );
  const origins = (process.env.BRIDGE_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const badOrigin = origins.find((o) => !/^https?:\/\//.test(o));
  record(
    "BRIDGE_ALLOWED_ORIGINS",
    badOrigin ? "fail" : "ok",
    origins.length ? origins.join(", ") : "empty (browser origins rejected)",
    badOrigin ? `not a valid origin: ${badOrigin} (use https://host[:port])` : ""
  );

  // 7. Background pid sanity
  const pid = readPid();
  if (pid) {
    record(".bridge.pid", "ok", `pid ${pid} recorded (npm run stop can stop it)`);
  }

  // 8. Optional: 9Router
  const router = await httpGet("http://127.0.0.1:20128/", 1200);
  record(
    "9Router (optional)",
    router.status > 0 ? "ok" : "warn",
    router.status > 0 ? "detected on :20128" : "not detected",
    ""
  );

  // 9. Optional: Python
  let py = null;
  for (const cmd of ["python3", "python", "py"]) {
    try {
      const out = child.execSync(`${cmd} --version 2>&1`, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] });
      const m = /(\d+)\.(\d+)/.exec(String(out));
      if (m) { py = { cmd, v: `${m[1]}.${m[2]}`, major: Number(m[1]), minor: Number(m[2]) }; break; }
    } catch {}
  }
  record(
    "Python demo (optional)",
    py && (py.major > 3 || (py.major === 3 && py.minor >= 9)) ? "ok" : "warn",
    py ? `${py.cmd} ${py.v}` : "no Python 3.9+ found",
    ""
  );

  // 10. .gitignore coverage
  let gi = "";
  try { gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"); } catch {}
  const envIgnored = /\.env\b/m.test(gi) || /^\.env$/m.test(gi);
  const bakIgnored = /bak-autofix/m.test(gi);
  record(
    ".gitignore covers .env and backups",
    envIgnored && bakIgnored ? "ok" : "fail",
    `env:${envIgnored ? "yes" : "no"} backups:${bakIgnored ? "yes" : "no"}`,
    envIgnored && bakIgnored ? "" : "restore the repo's .gitignore"
  );

  const failed = results.filter((r) => r.status === "fail");
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else {
    console.log(
      failed.length
        ? `\n${ui.fail(`${failed.length} check(s) failed`)} — fix the ✗ lines above and re-run \`npm run doctor\`.`
        : `\n${ui.ok("All checks passed")}${results.some((r) => r.status === "warn") ? ui.dim(" (with warnings)") : ""}.`
    );
  }
  process.exit(failed.length ? 1 : 0);
}

main();
