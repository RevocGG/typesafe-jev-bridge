#!/usr/bin/env node
/**
 * e2e-live.cjs — end-to-end tests for the TypeSafe bridge (LIVE API).
 *
 * Unlike the offline suite (npm test), this script talks to the REAL TypeSafe
 * API through a running bridge, and optionally through 9Router. It spends
 * credits — run it intentionally.
 *
 * Covers:
 *   1. Bridge health + models
 *   2. Direct bridge: chat/completions with explicit questions map
 *   3. Direct bridge: chat/completions with JSON-spec inference (choice)
 *   4. Direct bridge: yes/no inference (noul)
 *   5. Direct bridge: responses API (non-stream + stream)
 *   6. Error handling: unknown route → 404, missing input → 400
 *   7. ask-jev.cjs CLI: file noul, choice, stdin score, --help
 *   8. 9Router path (optional): chat/completions + responses through :20128
 *
 * Usage: node e2e-live.cjs [--skip-9router]
 * Env:   TYPESAFE_BRIDGE_URL (default http://127.0.0.1:8399)
 *        TYPESAFE_BRIDGE_PORT (default 8399, used only if URL unset)
 *        ROUTER_9_BASE_URL (default http://127.0.0.1:20128)
 *        ROUTER_9_API_KEY   (required for section 8; skipped with a warning otherwise)
 *        ROUTER_9_MODEL     (model name used through the router; no private default)
 */

"use strict";

const { execFile } = require("node:child_process");
const http = require("node:http");

const BRIDGE =
  process.env.TYPESAFE_BRIDGE_URL ||
  `http://127.0.0.1:${process.env.TYPESAFE_BRIDGE_PORT || 8399}`;
const ROUTER = (process.env.ROUTER_9_BASE_URL || "http://127.0.0.1:20128").replace(/\/+$/, "");
const ROUTER_MODEL = process.env.ROUTER_9_MODEL || "";
const SKIP_ROUTER = process.argv.includes("--skip-9router");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function request(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: payload ? "POST" : "GET",
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
        timeout: 90000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, raw: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Parse the first JSON object from a possibly SSE-suffixed body. */
function firstJson(raw) {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no JSON in response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON in response");
}

function extractText(data) {
  // chat/completions shape
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    return (c.message && c.message.content) || (c.delta && c.delta.content) || "";
  }
  // responses shape
  if (data.output) {
    for (const item of data.output) {
      for (const part of item.content || []) {
        if (part.type === "output_text") return part.text;
      }
    }
  }
  return "";
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

const NODE = process.execPath;

async function main() {
  console.log("\n== 1. Bridge health & models ==");
  try {
    const h = await request(`${BRIDGE}/health`);
    const health = JSON.parse(h.raw);
    check("GET /health returns ok", health.status === "ok", h.raw.slice(0, 120));
    check("health reports env key loaded", health.hasEnvKey === true);
    const m = await request(`${BRIDGE}/v1/models`);
    const models = JSON.parse(m.raw);
    check(
      "GET /v1/models lists typesafe/jev-latest",
      m.status === 200 &&
        (models.data || []).some((x) => x.id === "typesafe/jev-latest")
    );
  } catch (e) {
    check("bridge reachable", false, e.message);
    console.log("\nBridge is not running. Start it first:  node bridge.js");
    process.exit(1);
  }

  console.log("\n== 2. chat/completions with explicit questions map ==");
  {
    const r = await request(`${BRIDGE}/v1/chat/completions`, {
      model: "typesafe/jev-latest",
      messages: [
        {
          role: "user",
          content:
            "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. I'm losing sales. Please help ASAP.",
        },
      ],
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: {
            billing: "Payment or subscription issues",
            technical: "Bugs or integration problems",
            sales: "Pricing or account questions",
          },
        },
        is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
      },
    });
    const data = firstJson(r.raw);
    const ts = data.typesafe || {};
    const ans = ts.answers || {};
    check("HTTP 200", r.status === 200, `status=${r.status}`);
    check("choice answered under same id", ans.department && ans.department.choice, JSON.stringify(ans).slice(0, 150));
    check("noul answered under same id", ans.is_urgent && typeof ans.is_urgent.noul === "number");
    check("usage reported", ts.usage && ts.usage.input_tokens > 0);
    check(
      "text rendering contains answers",
      extractText(data).includes("department") && extractText(data).includes("is_urgent"),
      extractText(data).slice(0, 120)
    );
  }

  console.log("\n== 3. chat/completions with JSON-spec inference (choice) ==");
  {
    const r = await request(`${BRIDGE}/v1/chat/completions`, {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: '{"department": "Which team should handle this support ticket?"}' },
        { role: "user", content: "Server is down, all customers affected." },
      ],
    });
    const data = firstJson(r.raw);
    const text = extractText(data);
    check("HTTP 200", r.status === 200);
    check("answer id is 'department'", text.startsWith("department"), text.slice(0, 120));
    check("raw typesafe answers present", !!(data.typesafe && data.typesafe.answers && data.typesafe.answers.department));
  }

  console.log("\n== 4. chat/completions yes/no inference (noul) ==");
  {
    const r = await request(`${BRIDGE}/v1/chat/completions`, {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "Is this message urgent: production is on fire, revenue dropping" }],
    });
    const data = firstJson(r.raw);
    const ans = (data.typesafe && data.typesafe.answers && data.typesafe.answers.answer) || {};
    check("HTTP 200", r.status === 200);
    check(
      "noul is a number in [0,1] (urgent text scored)",
      typeof ans.noul === "number" && ans.noul >= 0 && ans.noul <= 1,
      `noul=${ans.noul}`
    );
  }

  console.log("\n== 5. responses API (non-stream + stream) ==");
  {
    const r = await request(`${BRIDGE}/v1/responses`, {
      model: "model-id",
      instructions: "Does this message express urgency?",
      input: "Payouts failing for 3 days, losing sales.",
    });
    const data = firstJson(r.raw);
    check("HTTP 200", r.status === 200);
    check("object=response, status=completed", data.object === "response" && data.status === "completed");
    check("output_text present", extractText(data).length > 0, extractText(data).slice(0, 100));

    const s = await request(`${BRIDGE}/v1/responses`, {
      model: "model-id",
      instructions: "Is this urgent?",
      input: "Production outage right now.",
      stream: true,
    });
    check("stream HTTP 200 with event-stream", s.status === 200 && (s.raw.includes("event:") || s.raw.includes("data:")));
    check("stream contains output_text.delta", s.raw.includes("output_text.delta"));
    check("stream ends with response.completed", s.raw.includes("response.completed"));
  }

  console.log("\n== 6. error handling ==");
  {
    const r = await request(`${BRIDGE}/v1/nope`, { foo: 1 });
    check("unknown route → 404", r.status === 404);
    const b = await request(`${BRIDGE}/v1/chat/completions`, { model: "jev-latest", messages: [] });
    check("empty messages → 400", b.status === 400);
  }

  console.log("\n== 7. ask-jev.cjs CLI ==");
  {
    const path = require("path");
    const cli = path.join(__dirname, "ask-jev.cjs");
    const t1 = await run(NODE, [cli, "--file", path.join(__dirname, "bridge.js"), "--q", "Does this file implement an HTTP server?"]);
    const noul = Number((t1.stdout.match(/:\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/m) || [])[1]);
    check(
      "file noul runs & prints a 0..1 probability",
      t1.err === null && Number.isFinite(noul) && noul >= 0 && noul <= 1,
      (t1.stderr || t1.stdout).slice(0, 150)
    );

    const t2 = await run(NODE, [cli, "--file", path.join(__dirname, "bridge.js"), "--q", "Primary role?", "--type", "choice", "--criteria", "proxy=HTTP proxying,storage=Persistence,ui=Interface"]);
    check("file choice returns an option", t2.err === null && /proxy|storage|ui/.test(t2.stdout), (t2.stderr || t2.stdout).slice(0, 150));

    const t3 = await run(NODE, [cli, "--q", "How severe?", "--type", "score", "--criteria", "Minor, Moderate, Major, Critical"], "server crashed, revenue dropping");
    const score = Number((t3.stdout.match(/:\s*(\d+(?:\.\d+)?)/) || [])[1]);
    check(
      "stdin score runs & prints a numeric score",
      t3.err === null && Number.isFinite(score) && score >= 0 && score <= 4,
      (t3.stderr || t3.stdout).slice(0, 150)
    );

    const t4 = await run(NODE, [cli, "--help"]);
    check("--help shows usage", t4.err === null && t4.stdout.includes("--file"));
  }

  if (!SKIP_ROUTER) {
    console.log("\n== 8. through 9Router (:20128) ==");
    const key = process.env.ROUTER_9_API_KEY || null;
    if (!ROUTER_MODEL) {
      console.log("  -- skipped: set ROUTER_9_MODEL to run the 9Router section (no provider-specific default ships) --");
    } else if (!key) {
      console.log("  -- skipped: set ROUTER_9_API_KEY to run these (or use --skip-9router) --");
    } else {
      // The router must be reachable before we count anything as a failure.
      let routerUp = false;
      try {
        const ping = await new Promise((resolve, reject) => {
          const u = new URL(ROUTER);
          const req = http.get({ host: u.hostname, port: u.port, path: "/", timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.on("error", reject);
        });
        routerUp = Number(ping) > 0;
      } catch {
        routerUp = false;
      }
      if (!routerUp) {
        console.log(`  -- skipped: 9Router is not reachable at ${ROUTER} --`);
      } else {
      const auth = { Authorization: `Bearer ${key}` };
      const r1 = await request(`${ROUTER}/v1/responses`, {
        model: ROUTER_MODEL,
        instructions: "Does this message express urgency?",
        input: "Stripe failing 3 days, losing sales, help ASAP.",
      }, auth);
      try {
        const d1 = firstJson(r1.raw);
        check("9Router /v1/responses → HTTP 200", r1.status === 200, `status=${r1.status}`);
        check("9Router responses returns text", extractText(d1).length > 0, extractText(d1).slice(0, 100));
      } catch (e) {
        check("9Router /v1/responses parseable", false, `${r1.status} ${r1.raw.slice(0, 150)}`);
      }

      const r2 = await request(`${ROUTER}/v1/chat/completions`, {
        model: ROUTER_MODEL,
        messages: [{ role: "user", content: "Is this urgent: database is down" }],
      }, auth);
      try {
        const d2 = firstJson(r2.raw);
        check("9Router /v1/chat/completions → HTTP 200", r2.status === 200, `status=${r2.status}`);
        check("9Router chat returns answer text", extractText(d2).length > 0, extractText(d2).slice(0, 100));
      } catch (e) {
        check("9Router /v1/chat/completions parseable", false, `${r2.status} ${r2.raw.slice(0, 150)}`);
      }
      }
    }
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  if (failures.length) {
    console.log("Failed:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
