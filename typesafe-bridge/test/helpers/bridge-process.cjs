"use strict";
/**
 * Start the REAL bridge (bridge.js) as a child process on a random port with
 * env overrides, wait for /health, and provide a clean shutdown helper.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const BRIDGE_JS = path.join(__dirname, "..", "..", "bridge.js");

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

function request(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {object} opts { TYPESAFE_API_BASE, BRIDGE_TOKEN, BRIDGE_ALLOWED_ORIGINS, TYPESAFE_API_KEY }
 */
async function startBridge(opts = {}) {
  const port = 18000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    TYPESAFE_BRIDGE_PORT: String(port),
    TYPESAFE_API_KEY: opts.TYPESAFE_API_KEY || "ts_test_fake_key_for_offline_tests",
    BRIDGE_TOKEN: opts.BRIDGE_TOKEN || "",
    BRIDGE_ALLOWED_ORIGINS: opts.BRIDGE_ALLOWED_ORIGINS || "",
    BRIDGE_LOG_LEVEL: "error",
    TYPESAFE_API_BASE: opts.TYPESAFE_API_BASE || "",
    // never read the developer's real .env in tests
    TYPESAFE_TEST_NO_DOTENV: "1",
  };
  const child = spawn(process.execPath, [BRIDGE_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
   child.stdout && child.stdout.on('data', d => console.log('[child-stdout]', String(d).slice(0, 300)));
   child.stderr && child.stderr.on('data', d => console.log('[child-stderr]', String(d).slice(0, 300)));
   child.on('exit', (c, s) => console.log('[child-exit]', c, s));
  const base = `http://127.0.0.1:${port}`;
  const started = await waitForHealth(base);
  return { child, base, port, started };
}

async function waitForHealth(base, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get(`${base}/health`);
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not start");
}

async function stopBridge(handle) {
  if (!handle) return;
  await new Promise((resolve) => {
    handle.child.once("exit", resolve);
    handle.child.kill("SIGTERM");
    setTimeout(() => {
      try {
        handle.child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 3000);
  });
}

module.exports = { startBridge, stopBridge, get, request, waitForHealth };
