"use strict";
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { startMockUpstream } = require("./helpers/mock-upstream.cjs");
const { startBridge, stopBridge, request, get } = require("./helpers/bridge-process.cjs");

const PLACEHOLDER = "sk-typesafe-bridge";

function chat(base, body, headers = {}) {
  return request(`${base}/v1/chat/completions`, { body, headers });
}

test("bridge + mock upstream: happy path", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await chat(bridge.base, {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "state text" }],
      questions: { q1: { type: "noul", instructions: "Is this urgent?" } },
    });
    assert.strictEqual(r.status, 200);
    const data = JSON.parse(r.body);
    assert.strictEqual(data.choices[0].message.role, "assistant");
    assert.match(data.choices[0].message.content, /q1: 0\.9/);
    assert.ok(data.typesafe);
    // The mock upstream received the state and the env (fake) key.
    assert.strictEqual(up.requests.length, 1);
    assert.match(up.requests[0].auth, /^Bearer ts_test_/);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("regression item 1: malformed request targets never kill the bridge", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const rawSend = (payload) =>
      new Promise((resolve) => {
        const s = net.connect(bridge.port, "127.0.0.1", () => {
          s.write(payload);
          s.end();
        });
        let data = "";
        s.on("data", (c) => (data += c));
        s.on("close", () => resolve(data));
        s.on("error", () => resolve(data));
      });

    for (const target of ["GET // HTTP/1.1\r\nHost: 127.0.0.1:8399\r\n\r\n", "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n", "GET /% HTTP/1.1\r\nHost: 127.0.0.1:8399\r\n\r\n"]) {
      const resp = await rawSend(target);
      assert.ok(/400|404/.test(resp), `expected 400/404 for ${JSON.stringify(target)}, got: ${resp.slice(0, 40)}`);
    }
    // 100 KB request line must be answered, not crash.
    const huge = `GET /${"a".repeat(100_000)} HTTP/1.1\r\nHost: 127.0.0.1:8399\r\n\r\n`;
    const resp = await rawSend(huge);
    assert.ok(/400|404/.test(resp) || resp === "", `huge request line answered: ${resp.slice(0, 40)}`);

    // The bridge is still alive and serving.
    const health = await get(`${bridge.base}/health`);
    assert.strictEqual(health.status, 200);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("BRIDGE_TOKEN auth: exact match required, placeholder rejected, ts_ tokens forwarded upstream", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url, BRIDGE_TOKEN: "sekrit-token-123" });
  try {
    const body = {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    };
    const noAuth = await chat(bridge.base, body);
    assert.strictEqual(noAuth.status, 401);
    const placeholder = await chat(bridge.base, body, { Authorization: `Bearer ${PLACEHOLDER}` });
    assert.strictEqual(placeholder.status, 401);
    const wrong = await chat(bridge.base, body, { Authorization: "Bearer wrong" });
    assert.strictEqual(wrong.status, 401);
    const good = await chat(bridge.base, body, { Authorization: "Bearer sekrit-token-123" });
    assert.strictEqual(good.status, 200);

    // NOTE: upstream-forwarding behaviour is asserted in the second bridge
    // below (this bridge's client token is the bridge token, not a ts_ key).
  } finally {
    await stopBridge(bridge);
    await up.close();
  }

  // Separate bridge: DEFAULT is NO passthrough — a client Bearer token is never
  // relayed upstream; the env key is always used.
  const up2 = await startMockUpstream();
  const bridge2 = await startBridge({ TYPESAFE_API_BASE: up2.url }); // no bridge token; passthrough off (default)
  try {
    const body = {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    };
    // Even a real-looking TypeSafe client key is NOT forwarded by default.
    await chat(bridge2.base, body, { Authorization: "Bearer ts_live_clientkey123456" });
    assert.strictEqual(up2.requests.length, 1);
    assert.strictEqual(up2.requests[0].auth, "Bearer ts_test_fake_key_for_offline_tests", "default must use env key, not client token");
    // …nor an apikey_-shaped one.
    await chat(bridge2.base, body, { Authorization: "Bearer apikey_clientfake12345678" });
    assert.strictEqual(up2.requests[1].auth, "Bearer ts_test_fake_key_for_offline_tests");
  } finally {
    await stopBridge(bridge2);
    await up2.close();
  }

  // Opt-in bridge: BRIDGE_ALLOW_KEY_PASSTHROUGH=1 forwards TypeSafe-shaped
  // client keys (apikey_… and legacy ts_live_/ts_test_) verbatim; anything
  // else still falls back to the env key.
  const up3 = await startMockUpstream();
  const bridge3 = await startBridge({
    TYPESAFE_API_BASE: up3.url,
    BRIDGE_ALLOW_KEY_PASSTHROUGH: "1",
  });
  try {
    const body = {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    };
    await chat(bridge3.base, body, { Authorization: "Bearer apikey_clientfake12345678" });
    assert.strictEqual(up3.requests[0].auth, "Bearer apikey_clientfake12345678", "apikey_ client key must be relayed when passthrough=1");
    await chat(bridge3.base, body, { Authorization: "Bearer ts_live_clientkey123456" });
    assert.strictEqual(up3.requests[1].auth, "Bearer ts_live_clientkey123456", "legacy ts_live_ client key must be relayed when passthrough=1");
    await chat(bridge3.base, body, { Authorization: "Bearer sk-not-a-typesafe-key" });
    assert.strictEqual(up3.requests[2].auth, "Bearer ts_test_fake_key_for_offline_tests", "non-TypeSafe token must never be relayed");
  } finally {
    await stopBridge(bridge3);
    await up3.close();
  }
});

test("origin policy: browser origins rejected unless allow-listed; allowed origin gets CORS", async (t) => {
  const up = await startMockUpstream();
  const allowed = "http://localhost:3000";
  const bridge = await startBridge({
    TYPESAFE_API_BASE: up.url,
    BRIDGE_ALLOWED_ORIGINS: allowed,
  });
  try {
    const body = {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    };
    const evil = await chat(bridge.base, body, { Origin: "https://evil.example.com" });
    assert.strictEqual(evil.status, 403);
    const ok = await chat(bridge.base, body, { Origin: allowed });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers["access-control-allow-origin"], allowed);
    const preflight = await request(`${bridge.base}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { Origin: allowed, "Access-Control-Request-Method": "POST" },
    });
    assert.strictEqual(preflight.status, 204);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("regression item 6: oversized body answers 413 (not ECONNRESET/400)", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const big = "x".repeat(3 * 1024 * 1024); // > 2 MB default
    const r = await chat(bridge.base, {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: big }],
    });
    assert.strictEqual(r.status, 413);
    const health = await get(`${bridge.base}/health`);
    assert.strictEqual(health.status, 200);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("input validation: questions matrix, empty messages, invalid JSON, unknown route, state cap", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const base = { model: "typesafe/jev-latest", messages: [{ role: "user", content: "s" }] };
    const expect = async (body, status, label) => {
      const r = await chat(bridge.base, body);
      assert.strictEqual(r.status, status, `${label}: expected ${status}, got ${r.status} ${r.body.slice(0, 120)}`);
      return r;
    };
    await expect({ ...base, questions: [] }, 400, "array questions");
    await expect({ ...base, questions: {} }, 400, "empty questions");
    await expect({ ...base, questions: { "bad id!": { type: "noul", instructions: "x" } } }, 400, "bad id");
    await expect({ ...base, questions: { ok: { type: "bogus", instructions: "x" } } }, 400, "bad type");
    const twentyOne = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }]));
    await expect({ ...base, questions: twentyOne }, 400, "21 entries");
    await expect({ ...base, questions: { ok: { type: "noul", instructions: "x" } } }, 200, "valid 1 question");
    await expect({ model: "x", messages: "not an array" }, 400, "messages not array");
    await expect({ model: "x", messages: [] }, 400, "empty messages");

    const raw = await request(`${bridge.base}/v1/chat/completions`, {
      body: undefined,
      headers: { "Content-Type": "application/json" },
    });
    assert.strictEqual(raw.status, 400); // invalid JSON body

    const nf = await get(`${bridge.base}/nope`);
    assert.strictEqual(nf.status, 404);

    // state cap: > 200000 chars → 413
    const long = "y".repeat(210_000);
    await expect({ ...base, messages: [{ role: "user", content: long }] }, 413, "state cap");
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("regression item 10: yes/no inference uses the LAST user message", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    await chat(bridge.base, {
      model: "typesafe/jev-latest",
      // Generic system prompt + a yes/no user question → the QUESTION text
      // must come from the user message (old code used the system prompt).
      messages: [
        { role: "system", content: "You are a helpful classifier daemon." },
        { role: "user", content: "Is this urgent: the database is down?" },
      ],
    });
    const sent = up.requests[0].body.questions;
    assert.strictEqual(sent.answer.type, "noul");
    assert.match(sent.answer.instructions, /Is this urgent/);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("upstream failures surface as real HTTP statuses", async (t) => {
  const up = await startMockUpstream({ status: 500 });
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await chat(bridge.base, {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    });
    assert.strictEqual(r.status, 500);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }

  const up429 = await startMockUpstream({ status: 429 });
  const bridge429 = await startBridge({ TYPESAFE_API_BASE: up429.url });
  try {
    const r = await chat(bridge429.base, {
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    });
    assert.strictEqual(r.status, 429);
  } finally {
    await stopBridge(bridge429);
    await up429.close();
  }
});

test("streaming shape: role in first delta, usage chunk, [DONE], event order (responses)", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await request(`${bridge.base}/v1/chat/completions`, {
      body: {
        model: "typesafe/jev-latest",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "s" }],
        questions: { a: { type: "noul", instructions: "urgent?" } },
      },
    });
    assert.strictEqual(r.status, 200);
    const events = r.body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.strictEqual(chunks[0].choices[0].delta.role, "assistant");
    assert.strictEqual(chunks[1].choices[0].finish_reason, "stop");
    assert.ok(chunks[2].usage.total_tokens > 0);
    assert.strictEqual(events[events.length - 1], "[DONE]");

    const r2 = await request(`${bridge.base}/v1/responses`, {
      body: {
        model: "typesafe/jev-latest",
        stream: true,
        input: "s",
        questions: { a: { type: "noul", instructions: "urgent?" } },
      },
    });
    const order = r2.body.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    assert.deepStrictEqual(order, [
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("unknown model ids are mapped with a warning header (kept for routers)", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await chat(bridge.base, {
      model: "gpt-4-totally-unknown",
      messages: [{ role: "user", content: "s" }],
      questions: { a: { type: "noul", instructions: "urgent?" } },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["x-typesafe-model-mapped"], "jev-latest");
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});

test("health endpoint returns only whitelisted fields", async (t) => {
  const up = await startMockUpstream();
  const bridge = await startBridge({ TYPESAFE_API_BASE: up.url });
  try {
    const r = await get(`${bridge.base}/health`);
    const data = JSON.parse(r.body);
    for (const k of Object.keys(data)) {
      assert.ok(["status", "version", "upstream", "hasEnvKey"].includes(k), `unexpected health field: ${k}`);
    }
  } finally {
    await stopBridge(bridge);
    await up.close();
  }
});
