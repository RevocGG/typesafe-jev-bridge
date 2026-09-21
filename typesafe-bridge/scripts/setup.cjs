#!/usr/bin/env node
"use strict";
/*
 * scripts/setup.cjs — one-command guided setup for typesafe-jev-bridge.
 *
 * COMPATIBILITY: the first lines of this file are intentionally written in
 * old-syntax JavaScript (var, no ?. ?? or template literals) so that on
 * Node < 18 we can print a friendly "upgrade Node" message instead of a
 * SyntaxError. Do not modernize the top-of-file code.
 *
 * Usage:  npm run setup [-- flags]
 * Flags:  --dry-run   print planned actions, change nothing
 *         --yes       accept defaults, never prompt
 *         --key-stdin read the API key from stdin (one line)
 *         --background start the bridge detached (.bridge.pid + bridge.log)
 *         --with-python also set up the optional Python demo (.venv + pip)
 *         --live-check send ONE short typed question to the real API
 *         --port N    bridge port (default 8399 / TYPESAFE_BRIDGE_PORT)
 *         --no-color  disable ANSI colors
 *         --help
 *
 * Exit codes: 0 ok, 1 failure, 2 usage.
 *
 * Hard rules: zero dependencies, cross-platform, no remote scripts, no sudo,
 * no global installs, no PATH changes, no telemetry, idempotent, and the API
 * key is never printed or written anywhere except typesafe-bridge/.env.
 */

// ---- old-syntax-safe Node check (must run before any modern syntax) --------
var NODE_MAJOR = parseInt(String(process.versions && process.versions.node ? process.versions.node.split(".")[0] : "0"), 10) || 0;
if (NODE_MAJOR < 18) {
  process.stderr.write(
    "Node 18+ required, you have " + (process.versions.node || "unknown") +
    ". Install a current LTS from https://nodejs.org and re-run this setup.\n"
  );
  process.exit(1);
}

var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var http = require("node:http");
var net = require("node:net");
var child = require("node:child_process");
var ui = require("../lib/ui.cjs");

var BRIDGE_DIR = path.join(__dirname, "..");
var ROOT = path.join(BRIDGE_DIR, "..");
var ENV_FILE = path.join(BRIDGE_DIR, ".env");
var PID_FILE = path.join(BRIDGE_DIR, ".bridge.pid");
var LOG_FILE = path.join(BRIDGE_DIR, "bridge.log");
var KEY_RE = /^ts_(live|test)_[A-Za-z0-9]+$/;
var PLACEHOLDER_KEY = "sk-typesafe-bridge";

function usage(code) {
  var out = code === 0 ? process.stdout : process.stderr;
  out.write(
    "usage: node scripts/setup.cjs [--dry-run] [--yes] [--key-stdin] [--background]\n" +
    "                              [--with-python] [--live-check] [--port N]\n" +
    "                              [--no-color] [--help]\n" +
    "\n" +
    "One-command setup: checks prerequisites, stores your TypeSafe API key in\n" +
    "typesafe-bridge/.env, starts the bridge and smoke-tests it (all offline\n" +
    "unless --live-check is passed).\n"
  );
  process.exit(code);
}

function parseArgs(argv) {
  var args = {
    dryRun: false, yes: false, keyStdin: false, background: false,
    withPython: false, liveCheck: false, port: null, noColor: false, help: false,
  };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--key-stdin") args.keyStdin = true;
    else if (a === "--background") args.background = true;
    else if (a === "--with-python") args.withPython = true;
    else if (a === "--live-check") args.liveCheck = true;
    else if (a === "--port") { args.port = Number(argv[++i]); if (!Number.isFinite(args.port)) return usage(2); }
    else if (a === "--no-color") args.noColor = true;
    else if (a === "--help" || a === "-h") { usage(0); }
    else { process.stderr.write("usage error: unknown flag \"" + a + "\"\n"); usage(2); }
  }
  return args;
}

var ARGS = parseArgs(process.argv);
if (ARGS.noColor) process.argv.push("--no-color"); // ui reads it at require time

var failHint = "";
function step(name, fn) {
  var stream = process.stderr;
  if (ARGS.dryRun) {
    stream.write(ui.dim("[dry-run] would run: " + name) + "\n");
    return Promise.resolve();
  }
  stream.write(ui.dim(name + " ... ") + "\r");
  var p;
  try { p = Promise.resolve().then(fn); } catch (e) { p = Promise.reject(e); }
  return p.then(
    function (r) { stream.write(ui.dim(name + " ... ") + ui.ok("done") + "        "); stream.write("\n"); return r; },
    function (e) {
      stream.write(ui.dim(name + " ... ") + ui.fail("FAILED") + "\n");
      if (e && e.message) stream.write(ui.red("  " + e.message) + "\n");
      if (failHint) stream.write(ui.yellow("  hint: " + failHint) + "\n");
      throw e;
    }
  );
}

function httpGet(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs || 4000 }, function (res) {
      var data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

function portFree(port) {
  return new Promise(function (resolve) {
    var srv = net.createServer();
    srv.once("error", function () { resolve(false); });
    srv.listen(port, "127.0.0.1", function () {
      srv.close(function () { resolve(true); });
    });
  });
}

function nextFreePort(start) {
  return portFree(start).then(function (free) {
    if (free) return start;
    return nextFreePort(start + 1 <= 65535 ? start + 1 : start);
  });
}

/** Detect which process class holds a TCP port (best effort, no output). */
function whoHoldsPort(port) {
  return new Promise(function (resolve) {
    try {
      var out = child.execSync(
        process.platform === "win32"
          ? "netstat -ano | findstr LISTENING | findstr :" + port
          : "lsof -nP -iTCP:" + port + " -sTCP:LISTEN 2>/dev/null || true",
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
      );
      if (!out || !out.trim()) return resolve(null);
      if (/node/i.test(out)) return resolve("a node process");
      if (process.platform !== "win32" && /PID/.test(out)) {
        var m = /\w+\s+(\d+)/.exec(out);
        if (m) {
          var cmd = child.execSync("ps -p " + m[1] + " -o comm= 2>/dev/null || true", { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
          return resolve(cmd ? "a " + cmd.trim() + " process" : "another process");
        }
      }
      return resolve("another process");
    } catch (e) { resolve(null); }
  });
}

function gitTracked(file) {
  try {
    child.execSync("git ls-files --error-unmatch -- \"" + file + "\"", {
      cwd: ROOT, stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (e) { return false; }
}

/** Poll /health until healthy. Returns final health object or throws. */
function waitHealthy(port, timeoutMs, logFile) {
  var deadline = Date.now() + timeoutMs;
  var delay = 200;
  function attempt() {
    return httpGet("http://127.0.0.1:" + port + "/health", 2000).then(function (r) {
      if (r.status === 200) return JSON.parse(r.body);
      throw new Error("/health answered " + r.status);
    });
  }
  function loop() {
    return attempt().catch(function (e) {
      if (Date.now() > deadline) {
        var tail = "";
        try { tail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-20).join("\n"); } catch (e2) {}
        throw new Error("bridge did not become healthy: " + e.message + (tail ? "\n--- last log lines ---\n" + tail : ""));
      }
      return new Promise(function (res) { setTimeout(res, delay); }).then(function () {
        delay = Math.min(delay * 2, 1500);
        return loop();
      });
    });
  }
  return loop();
}

// ----------------------------------------------------------------- steps ----

var PORT = ARGS.port || Number(process.env.TYPESAFE_BRIDGE_PORT) || 8399;
var chosenPort = PORT;

function preflight() {
  return Promise.all([portFree(PORT), nextFreePort(PORT)]).then(function (r) {
    if (!r[0]) {
      return whoHoldsPort(PORT).then(function (who) {
        process.stderr.write(
          ui.warn("port " + PORT + " is busy (" + (who || "unknown process") + ") — will use port " + r[1]) + "\n"
        );
        chosenPort = r[1];
      });
    }
  }).then(function () {
    if (gitTracked(path.relative(ROOT, ENV_FILE).replace(/\\/g, "/"))) {
      process.stderr.write(ui.warn(ENV_FILE + " is tracked by git — run `git rm --cached typesafe-bridge/.env` so your key is never committed") + "\n");
    }
  });
}

function readKeyFromEnvFile() {
  try {
    var txt = fs.readFileSync(ENV_FILE, "utf8");
    var m = /^TYPESAFE_API_KEY=(.*)$/m.exec(txt);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function ensureKey() {
  var existing = process.env.TYPESAFE_API_KEY || readKeyFromEnvFile();
  if (existing && KEY_RE.test(existing)) {
    process.stderr.write(ui.dim("API key: using existing " + (process.env.TYPESAFE_API_KEY ? "environment" : ".env") + " key (never displayed)") + "\n");
    return Promise.resolve({ key: existing, from: process.env.TYPESAFE_API_KEY ? "environment" : ".env" });
  }
  if (existing && !KEY_RE.test(existing)) {
    process.stderr.write(ui.warn("existing key has an unexpected shape (expected ts_live_…/ts_test_…) — please re-enter it") + "\n");
  }

  var readPromise;
  if (ARGS.keyStdin) {
    readPromise = ui.readHidden("");
  } else if (ARGS.yes && !process.stdin.isTTY) {
    return Promise.reject(new Error("no API key available. Set TYPESAFE_API_KEY, use --key-stdin, or run interactively."));
  } else {
    failHint = "get a key at console.typesafe.ai/settings/keys (starts with ts_live_ or ts_test_)";
    process.stdout.write(
      "\nA TypeSafe API key is required (get one at console.typesafe.ai/settings/keys).\n" +
      "It will be written to typesafe-bridge/.env and is never displayed or logged.\n"
    );
    readPromise = ui.readHidden("Paste your key (input hidden): ");
  }

  return readPromise.then(function (key) {
    key = String(key || "").trim();
    if (!KEY_RE.test(key)) {
      return Promise.reject(new Error("that does not look like a TypeSafe key (expected ts_live_… or ts_test_…). Get one at console.typesafe.ai/settings/keys"));
    }
    if (!ARGS.dryRun) {
      // Never destroy an existing .env: back it up first (git-ignored).
      if (fs.existsSync(ENV_FILE)) {
        try { fs.copyFileSync(ENV_FILE, ENV_FILE + ".bak-setup"); } catch (e) { /* best effort */ }
      }
      var body = "# Created by npm run setup — do not commit.\nTYPESAFE_API_KEY=" + key + "\n";
      fs.writeFileSync(ENV_FILE, body, { encoding: "utf8" }); // UTF-8, LF by default
      // POSIX only: on Windows chmodSync merely toggles a read-only flag that
      // breaks later deletes/edits; ACLs already scope the file to the user.
      if (process.platform !== "win32") {
        try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { /* best effort */ }
      }
      if (process.platform === "win32") {
        process.stderr.write(ui.dim("note (Windows): file permissions are handled by your user profile ACLs; keep .env out of any sync/backup share") + "\n");
      }
    }
    return { key: key, from: "setup" };
  });
}

function detectPython() {
  var candidates = ["python3", "python", "py"];
  function probe(cmd) {
    try {
      var out = child.execSync(cmd + " --version 2>&1", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
      var m = /(\d+)\.(\d+)/.exec(String(out));
      return m ? { cmd: cmd, major: Number(m[1]), minor: Number(m[2]) } : null;
    } catch (e) { return null; }
  }
  for (var i = 0; i < candidates.length; i++) {
    var found = probe(candidates[i]);
    if (found && (found.major > 3 || (found.major === 3 && found.minor >= 9))) return found;
  }
  return null;
}

function optionalPython() {
  if (!ARGS.withPython) {
    process.stderr.write(ui.dim("optional Python demo skipped (pass --with-python to set up demo.py)") + "\n");
    return Promise.resolve();
  }
  var py = detectPython();
  if (!py) return Promise.reject(new Error("Python 3.9+ not found (tried python3, python, py). Install it from python.org, then re-run with --with-python."));
  process.stderr.write(ui.dim("using " + py.cmd + " " + py.major + "." + py.minor) + "\n");
  if (ARGS.dryRun) return Promise.resolve();
  var venv = path.join(BRIDGE_DIR, ".venv");
  if (!fs.existsSync(venv)) {
    child.execSync(py.cmd + " -m venv .venv", { cwd: BRIDGE_DIR, stdio: "inherit" });
  }
  var pip = process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
  child.execSync('"' + pip + '" -m pip install -r requirements.txt', { cwd: BRIDGE_DIR, stdio: "inherit" });
  return Promise.resolve();
}

function optionalRouter() {
  return httpGet("http://127.0.0.1:20128/", 1500).then(function (r) {
    process.stdout.write(
      ui.ok("9Router detected at http://127.0.0.1:20128") + "\n" +
      "  In its dashboard add a Custom / OpenAI-compatible provider:\n" +
      "    Base URL   http://127.0.0.1:" + chosenPort + "/v1\n" +
      "    API key    " + PLACEHOLDER_KEY + "\n" +
      "    Models     typesafe/jev-latest, typesafe/jev-preview\n"
    );
  }).catch(function () {
    process.stdout.write(ui.dim("9Router not detected on :20128 — fine if you do not use it.") + "\n");
  });
}

function startBridge() {
  if (ARGS.dryRun) return Promise.resolve();
  var childEnv = Object.assign({}, process.env, { TYPESAFE_BRIDGE_PORT: String(chosenPort) });
  if (ARGS.background) {
    var out = fs.openSync(LOG_FILE, "a");
    var c = child.spawn(process.execPath, [path.join(BRIDGE_DIR, "bridge.js")], {
      env: childEnv, detached: true, stdio: ["ignore", out, out],
    });
    c.unref();
    fs.writeFileSync(PID_FILE, String(c.pid) + "\n");
  }
  // Foreground starts are handled by the caller (npm start prints the banner
  // itself); here we only wait when we spawned something.
  if (!ARGS.background) return Promise.resolve();
  return waitHealthy(chosenPort, 10000, LOG_FILE).then(function () {});
}

function smokeTest() {
  return httpGet("http://127.0.0.1:" + chosenPort + "/health", 1500).then(function (h) {
    var health = JSON.parse(h.body);
    if (!health.hasEnvKey) throw new Error(".env key not loaded by the bridge (hasEnvKey: false)");
    return httpGet("http://127.0.0.1:" + chosenPort + "/v1/models", 3000).then(function (m) {
      var models = JSON.parse(m.body);
      var ids = (models.data || []).map(function (x) { return x.id; });
      if (ids.indexOf("typesafe/jev-latest") === -1) throw new Error("model list does not contain typesafe/jev-latest");
      process.stderr.write(ui.dim("smoke test: hasEnvKey=true, models OK") + "\n");
    });
  }).catch(function (e) {
    if (!ARGS.background) {
      process.stderr.write(ui.dim("bridge not started by setup (foreground mode) — run `npm start` and it will greet you with a banner") + "\n");
      return;
    }
    throw new Error("smoke test failed: " + e.message + " (see typesafe-bridge/bridge.log)");
  });
}

function liveCheck() {
  if (!ARGS.liveCheck) return Promise.resolve();
  process.stdout.write(
    "\n" + ui.yellow("--live-check: sends ONE short fixed sentence to api.typesafe.ai and uses a few tokens. No files are sent.") + "\n"
  );
  var confirm = ARGS.yes
    ? Promise.resolve("y")
    : ui.readLine("Proceed? [y/N] ");
  return confirm.then(function (answer) {
    if (String(answer).toLowerCase() !== "y" && String(answer).toLowerCase() !== "yes") {
      process.stdout.write("skipped live check.\n");
      return;
    }
    var body = JSON.stringify({
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "The server is down." }],
      questions: { answer: { type: "noul", instructions: "Is this urgent?" } },
    });
    return new Promise(function (resolve, reject) {
      var u = new URL("http://127.0.0.1:" + chosenPort + "/v1/chat/completions");
      var req = http.request({
        host: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 30000,
      }, function (res) {
        var data = "";
        res.on("data", function (c) { data += c; });
        res.on("end", function () { resolve({ status: res.statusCode, body: data }); });
      });
      req.on("timeout", function () { req.destroy(new Error("timeout")); });
      req.on("error", reject);
      req.write(body);
      req.end();
    }).then(function (r) {
      if (r.status !== 200) throw new Error("live check failed: HTTP " + r.status + " " + r.body.slice(0, 200));
      var d = JSON.parse(r.body);
      var ts = d.typesafe || {};
      var ans = (ts.answers && ts.answers.answer) || {};
      process.stdout.write(ui.ok("live check: noul=" + ans.noul + " (Jev answered)") + "\n");
    });
  });
}

function summary() {
  var bg = ARGS.background && !ARGS.dryRun;
  process.stdout.write(
    "\n" + ui.bold("  Setup complete") + "\n" +
    "  Bridge:  http://127.0.0.1:" + chosenPort + "/v1" + (bg ? "  (running in background, pid in .bridge.pid)" : "  (start it with: npm start)") + "\n" +
    "  Try it:  node typesafe-bridge/ask-jev.cjs --text \"Server is down\" --q \"Is this urgent?\"\n" +
    "  Doctor:  npm run doctor" + (bg ? "      Stop:  npm run stop" : "") + "\n\n"
  );
}

function main() {
  return step("preflight (node, os, permissions, port, git tracking)", preflight)
    .then(function () { return step("API key (hidden input, written to typesafe-bridge/.env)", ensureKey); })
    .then(function () { return step("optional Python demo", optionalPython); })
    .then(function () { return step("optional 9Router detection", optionalRouter); })
    .then(function () { return step("start bridge" + (ARGS.background ? " (background)" : " (skipped — run `npm start` for the foreground banner)"), startBridge); })
    .then(function () { return step("smoke test (/health + /v1/models, offline)", smokeTest); })
    .then(function () { return step("optional live check", liveCheck); })
    .then(summary)
    .then(function () { process.exit(0); })
    .catch(function () { process.exit(1); });
}

main();
