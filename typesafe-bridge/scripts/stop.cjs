#!/usr/bin/env node
"use strict";
/**
 * scripts/stop.cjs — stop a background bridge started by `npm run setup -- --background`.
 *
 * Reads typesafe-bridge/.bridge.pid, verifies the recorded port's /health
 * still answers (so we never kill an unrelated process that reused the PID),
 * terminates gracefully (SIGTERM / taskkill without /F first), removes the
 * pid file and reports clearly when nothing is running.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const child = require("node:child_process");

const BRIDGE_DIR = path.join(__dirname, "..");
const PID_FILE = path.join(BRIDGE_DIR, ".bridge.pid");

function readPidFile() {
  try {
    const txt = fs.readFileSync(PID_FILE, "utf8").trim();
    const m = /^(\d+)(?::(\d+))?$/.exec(txt); // "12345" or legacy "12345:8399"
    if (!m) return null;
    return { pid: parseInt(m[1], 10), port: m[2] ? parseInt(m[2], 10) : null };
  } catch {
    return null;
  }
}

function healthOk(port, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    try {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs || 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function killPid(pid, force) {
  if (process.platform === "win32") {
    child.execSync(`taskkill ${force ? "/F" : ""} /PID ${pid}`, { stdio: "ignore" });
  } else {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  }
}

async function main() {
  const rec = readPidFile();
  if (!rec) {
    console.log("No background bridge recorded (.bridge.pid missing) — nothing to stop.");
    console.log("If it runs in a foreground terminal, stop it there with Ctrl+C.");
    process.exit(0);
  }

  // Verify the PID really is our bridge: its port (recorded or discovered)
  // must answer /health before we signal anything.
  let port = rec.port;
  if (!port) {
    // Legacy pid file without a port: probe the default.
    for (const p of [Number(process.env.TYPESAFE_BRIDGE_PORT) || 8399, 8400, 8401]) {
      if (await healthOk(p, 1000)) { port = p; break; }
    }
  }
  const isBridge = await healthOk(port, 2000);
  if (!isBridge) {
    console.log(`The recorded bridge (pid ${rec.pid}) is no longer answering on port ${port || "?"} — cleaning up the stale pid file.`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }

  console.log(`Stopping bridge (pid ${rec.pid}, port ${port}) …`);
  try {
    killPid(rec.pid, false);
  } catch (e) {
    // Already gone or no permission.
  }
  // Wait up to 5 s for /health to stop answering.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await healthOk(port, 800))) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (await healthOk(port, 800)) {
    console.log("Still answering — forcing.");
    try { killPid(rec.pid, true); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log("Bridge stopped.");
  process.exit(0);
}

main();
