#!/usr/bin/env node
/**
 * TypeSafe Jev ↔ OpenAI-compatible bridge
 * ---------------------------------------
 * Lets 9Router (or any OpenAI client) talk to the TypeSafe "System One" API.
 *
 *   OpenAI client → POST /v1/chat/completions → this bridge → POST <TYPESAFE_API_BASE>/v1/systemone
 *
 * The answer is rendered back as chat text. When the caller does not provide
 * TypeSafe `questions`, they are inferred (see GUIDE.md for the full algorithm):
 *   1. An explicit `questions` map in the JSON body (verbatim).
 *   2. A JSON object with string values in the system / first user message
 *      becomes a `choice` question (labels = its keys).
 *   3. A yes/no phrasing in the LAST user message (then the system message)
 *      becomes a `noul` question.
 *   4. Otherwise a yes/no choice question is used.
 *
 * Auth:
 *   - Set TYPESAFE_API_KEY (env or .env). Clients then use the placeholder
 *     key "sk-typesafe-bridge".
 *   - Optional BRIDGE_TOKEN: when set, requests must send
 *     `Authorization: Bearer <BRIDGE_TOKEN>` exactly (timing-safe compare).
 *     The placeholder is only accepted while BRIDGE_TOKEN is unset.
 *   - A client Bearer token is forwarded upstream ONLY if it matches
 *     ^ts_(live|test)_ — any other value is ignored (the env key is used).
 *
 * Security model (see README "Security model"):
 *   - Binds to 127.0.0.1 only. Non-loopback Host headers are rejected 403.
 *   - Browser origins are rejected 403 unless listed in BRIDGE_ALLOWED_ORIGINS
 *     (comma-separated); allow-listed origins get CORS preflight + headers.
 *   - No request may crash the process: malformed targets, huge bodies and
 *     handler errors all answer 4xx and the bridge keeps serving.
 *
 * Run:  node bridge.js          (port: TYPESAFE_BRIDGE_PORT, default 8399)
 * Test: curl http://localhost:8399/health
 */

"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/env.cjs");
const { redact } = require("./lib/redact.cjs");

// ------------------------------------------------------------ environment ---

const envInfo = (() => {
  try {
    const r = loadEnvFile(path.join(__dirname, ".env"));
    return { from: r.loaded.includes("TYPESAFE_API_KEY") ? ".env" : "environment", encoding: r.encoding };
  } catch {
    return { from: "environment", encoding: null };
  }
})();

const VERSION = (() => {
  try {
    return require("../package.json").version;
  } catch {
    return "0.0.0";
  }
})();

const PORT = Number(process.env.TYPESAFE_BRIDGE_PORT || 8399);
const LOG_LEVEL = String(process.env.BRIDGE_LOG_LEVEL || "info").toLowerCase();
const PLACEHOLDER_KEY = "sk-typesafe-bridge";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const BRIDGE_REDACT = process.env.BRIDGE_REDACT === "1";
const MAX_BODY_BYTES = Number(process.env.BRIDGE_MAX_BODY_BYTES || 2 * 1024 * 1024);
const MAX_STATE_CHARS = Number(process.env.BRIDGE_MAX_STATE_CHARS || 200_000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 60_000);
const ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const UPSTREAM = (() => {
  try {
    const u = new URL(process.env.TYPESAFE_API_BASE || "https://api.typesafe.ai");
    return {
      protocol: u.protocol, // "https:" | "http:"
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? "80" : "443"),
      basePath: u.pathname.replace(/\/+$/, ""), // supports a base path
    };
  } catch {
    return { protocol: "https:", hostname: "api.typesafe.ai", port: "443", basePath: "" };
  }
})();

const MODELS_LIST = {
  object: "list",
  data: [
    { id: "typesafe/jev-latest", object: "model", owned_by: "typesafe" },
    { id: "typesafe/jev-preview", object: "model", owned_by: "typesafe" },
    { id: "jev-latest", object: "model", owned_by: "typesafe" },
  ],
};

// ---------------------------------------------------------------- helpers ---

const ui = require("./lib/ui.cjs");

function log(...args) {
  if (LOG_LEVEL === "error") return;
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

/** One line per request: method, path, status, latency, tokens — nothing else. */
function logRequest(req, route, status, startedMs, usage) {
  if (LOG_LEVEL === "error") return;
  if (route === "/health") return; // health polls would drown the log
  const ms = Date.now() - startedMs;
  const tokens = usage && (usage.input_tokens || usage.output_tokens)
    ? `  in ${usage.input_tokens || 0} / out ${usage.output_tokens || 0} tokens`
    : "";
  const line = `${new Date().toLocaleTimeString()}  ${req.method} ${route}  ${status}  ${ms}ms${tokens}`;
  if (status >= 500) console.error(ui.red(line));
  else if (status >= 400) console.log(ui.yellow(line));
  else console.log(line);
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function openAiError(res, status, message, code, extraHeaders) {
  sendJson(
    res,
    status,
    { error: { message, type: "invalid_request_error", code: code || null } },
    extraHeaders
  );
}

/** Extract a bearer token from the Authorization header, or null. */
function bearerToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Constant-time string equality. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Returns null when the request is authorized, otherwise an error status.
 *  - BRIDGE_TOKEN set  → exact Bearer match required (placeholder rejected).
 *  - BRIDGE_TOKEN unset → placeholder or any token accepted (compat mode).
 */
function checkBridgeAuth(req) {
  if (!BRIDGE_TOKEN) return null;
  const token = bearerToken(req);
  if (token && safeEqual(token, BRIDGE_TOKEN)) return null;
  return 401;
}

/**
 * Resolve the upstream (TypeSafe) API key for this request.
 * Only real TypeSafe keys (ts_live_/ts_test_) are forwarded from the client.
 */
function resolveApiKey(req) {
  const token = bearerToken(req);
  const envKey = process.env.TYPESAFE_API_KEY;
  if (token && /^ts_(live|test)_/.test(token)) return token;
  if (token && token !== PLACEHOLDER_KEY) {
    log("client token ignored (not a TypeSafe key) — using env key");
  }
  if (envKey) return envKey;
  return null;
}

/** Loopback Host check (DNS-rebinding guard). */
function hostIsLoopback(host) {
  if (!host) return false;
  return /^(\[::1\]|127\.0\.0\.1|localhost|.*\.localhost)(:\d+)?$/i.test(host.trim());
}

/**
 * Origin policy: reject every request with an Origin header unless it is
 * explicitly allow-listed in BRIDGE_ALLOWED_ORIGINS. Returns true when OK.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

/** Flatten OpenAI `messages` into a TypeSafe `state` value. */
function messagesToState(messages) {
  const parts = [];
  for (const m of messages || []) {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && p.type === "text") return p.text;
          return `[${(p && p.type) || "content"} omitted]`;
        })
        .join("\n");
    }
    if (content == null || content === "") continue;
    const role = m.role || "user";
    if (role === "system" && parts.length === 0) {
      parts.push(content); // bare instructions first, no label
    } else {
      parts.push(`${role}: ${content}`);
    }
  }
  return parts.join("\n\n");
}

function firstString(value, maxLen) {
  const limit = maxLen || 300;
  if (typeof value === "string") return value.length ? value.slice(0, limit) : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstString(v, limit);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = firstString(v, limit);
      if (found) return found;
    }
  }
  return null;
}

/** Pull a likely question text out of a JSON spec object. */
function pickQuestionText(value) {
  const hit = /"(?:answer|answers?|question|instructions?|prompt|output|result|label|choice|category|classification|intent|sentiment|rating|score|decision|verdict|response|fields?)"\s*:\s*"([^"]{3,300})"/.exec(
    JSON.stringify(value)
  );
  if (hit) return hit[1];
  return firstString(value);
}

const YES_NO_RE = /(^|\W)(yes|no)\s*(?:\/|or)\s*(no|yes)(\W|$)/i;
const IS_IT_RE = /^(is|are|was|were|do|does|did|can|could|should|will|would|has|have|contains?|includes?)\b/i;

function looksLikeYesNo(text) {
  return YES_NO_RE.test(text) || IS_IT_RE.test(text);
}

function specObjectIn(content) {
  if (typeof content !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]+?)```/.exec(content);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    /* not JSON */
  }
  return null;
}

/** Last user message text. */
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

function systemText(messages) {
  const sys = (messages || []).find((m) => m && m.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : null;
}

/**
 * Infer TypeSafe questions from the conversation when the caller did not
 * provide an explicit `questions` map. Detection order (documented in GUIDE):
 *   1. JSON object spec (system or first user message) → choice question.
 *   2. Yes/no phrasing in the LAST user message → noul.
 *   3. Yes/no phrasing in the system message → noul.
 *   4. Default yes/no choice.
 */
function inferQuestions(messages) {
  const specSource =
    (messages || []).find((m) => m && m.role === "system") ||
    (messages || []).find((m) => m && m.role === "user");

  if (specSource && typeof specSource.content === "string") {
    const obj = specObjectIn(specSource.content);
    if (obj) {
      const keys = Object.keys(obj).filter((k) => k.length <= 80 && typeof obj[k] === "string");
      if (keys.length >= 2) {
        const text = pickQuestionText(obj) || "Decide the best answer for the state";
        return { answer: { type: "choice", instructions: text, criteria: obj } };
      }
      if (keys.length === 1) {
        const text = firstString(obj[keys[0]], 500) || "Evaluate the state";
        return {
          [keys[0]]: {
            type: "choice",
            instructions: text,
            criteria: { yes: "The answer is yes / positive", no: "The answer is no / negative" },
          },
        };
      }
      // Non-string or unusable spec → fall through to phrasing detection.
    }
  }

  const lastUser = lastUserText(messages);
  if (lastUser && looksLikeYesNo(firstString(lastUser, 500) || "")) {
    return { answer: { type: "noul", instructions: firstString(lastUser, 500) } };
  }
  const sys = systemText(messages);
  if (sys && looksLikeYesNo(firstString(sys, 500) || "")) {
    return { answer: { type: "noul", instructions: firstString(sys, 500) } };
  }
  const instruction = lastUser
    ? firstString(lastUser, 500)
    : sys
      ? firstString(sys, 500)
      : null;
  return {
    answer: {
      type: "choice",
      instructions: instruction || "Evaluate the state",
      criteria: { yes: "The answer is yes / positive", no: "The answer is no / negative" },
    },
  };
}

/** Validate an explicit `questions` map. Returns an error message or null. */
function validateQuestions(questions) {
  if (questions === undefined) return null;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return "questions must be a plain object";
  }
  const keys = Object.keys(questions);
  if (keys.length === 0) return "questions must not be empty";
  if (keys.length > 20) return "questions must contain at most 20 entries";
  for (const id of keys) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      return `invalid question id "${id.slice(0, 70)}" (allowed: A-Z a-z 0-9 _ . - , max 64 chars)`;
    }
    const q = questions[id];
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      return `question "${id}" must be an object`;
    }
    if (!["noul", "choice", "score"].includes(q.type)) {
      return `question "${id}" has invalid type "${q.type}" (expected noul|choice|score)`;
    }
  }
  return null;
}

function answersToText(answers) {
  const lines = [];
  for (const [key, ans] of Object.entries(answers || {})) {
    const suffix = ans.confidence != null ? ` (confidence: ${ans.confidence})` : "";
    if (ans.type === "noul") lines.push(`${key}: ${ans.noul}${suffix}`);
    else if (ans.type === "choice") lines.push(`${key}: ${ans.choice}${suffix}`);
    else if (ans.type === "score") lines.push(`${key}: ${ans.score}${suffix}`);
    else lines.push(`${key}: ${JSON.stringify(ans)}`);
  }
  return lines.join("\n") || "{}";
}

/**
 * Call the upstream TypeSafe API. Supports http(s), base paths, retries on
 * 429/529, response size caps and utf8-safe chunk handling.
 */
function callTypeSafe(apiKey, payload, opts = {}) {
  const retries = opts.retries == null ? 2 : opts.retries;
  const timeoutMs = opts.timeoutMs || UPSTREAM_TIMEOUT_MS;
  const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

  function attempt(n) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const transport = UPSTREAM.protocol === "http:" ? http : https;
      const req = transport.request(
        {
          protocol: UPSTREAM.protocol,
          hostname: UPSTREAM.hostname,
          port: UPSTREAM.port,
          path: `${UPSTREAM.basePath}/v1/systemone`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.setEncoding("utf8");
          let data = "";
          let bytes = 0;
          res.on("data", (c) => {
            bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("upstream response too large"));
              return;
            }
            data += c;
          });
          res.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch {
              if (res.statusCode >= 400) {
                const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
                err.status = res.statusCode;
                return reject(err);
              }
              const err = new Error("upstream returned an invalid response");
              err.status = 502;
              return reject(err);
            }
            if (res.statusCode >= 400) {
              const msg =
                (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
                (parsed && parsed.detail) ||
                data.slice(0, 500) ||
                `HTTP ${res.statusCode}`;
              const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
              err.status = res.statusCode;
              err.retryAfter = res.headers["retry-after"] || null;
              return reject(err);
            }
            resolve(parsed);
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`upstream timeout (${timeoutMs}ms)`)));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  return (async () => {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        let wait = 500 * 2 ** (i - 1);
        const ra = Number(lastErr && lastErr.retryAfter);
        if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, 10_000);
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        return await attempt(i);
      } catch (err) {
        lastErr = err;
        const status = err.status || 0;
        const retryable = status === 429 || status === 529 || status === 0 || status >= 500;
        if (!retryable || i === retries) throw err;
      }
    }
    throw lastErr;
  })();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        // Pause the socket (do NOT destroy here): the caller must first flush
        // the 413 response, otherwise the client sees ECONNRESET instead.
        req.pause();
        const err = new Error(`Request body too large (limit ${limit} bytes)`);
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

/** Map any incoming model id to a real TypeSafe model (routers need this). */
function resolveUpstreamModel(rawModel) {
  let m = rawModel || "jev-latest";
  if (m.includes("/")) m = m.split("/").pop();
  if (!m || !/^jev/i.test(m)) return { model: "jev-latest", mapped: true };
  return { model: m, mapped: false };
}

/** Convert a Responses-API request body into the `messages` array shape. */
function responsesInputToMessages(body) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const role = item.role || "user";
      let content = item.content;
      if (Array.isArray(content)) {
        content = content
          .map((p) => {
            if (typeof p === "string") return p;
            if (p && typeof p.text === "string") return p.text;
            return "";
          })
          .join("\n");
      }
      if (typeof content === "string" && content.trim()) {
        messages.push({ role, content });
      }
    }
  }
  return messages;
}

/** Best-effort route for the request log — never throws. */
function safeRoute(req) {
  try {
    return new URL(req.url, `http://localhost:${PORT}`).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "<bad-target>";
  }
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  res.on("finish", () => logRequest(req, safeRoute(req), res.statusCode, startedAt, res.locals && res.locals.usage));
  // NOTE: `route` (not `path`) — the old code shadowed the path module.
  let route;
  try {
    route = new URL(req.url, `http://localhost:${PORT}`).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return openAiError(res, 400, "Malformed request target");
  }

  // Guards run before anything else can fail the process.
  if (!hostIsLoopback(req.headers.host)) {
    return openAiError(
      res,
      403,
      `Host header "${String(req.headers.host).slice(0, 80)}" is not a loopback address. This bridge only serves local requests.`
    );
  }
  if (!originAllowed(req)) {
    return openAiError(
      res,
      403,
      `Cross-origin request rejected (Origin not in BRIDGE_ALLOWED_ORIGINS). This bridge is for local tools only.`
    );
  }
  const origin = req.headers.origin;
  const cors = origin && ALLOWED_ORIGINS.includes(origin) ? corsHeaders(origin) : undefined;

  if (req.method === "OPTIONS") {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return openAiError(res, 403, "Origin not allowed", null, cors);
    }
    return sendJson(res, 204, {}, cors);
  }

  const authFail = route === "/health" && req.method === "GET" ? null : checkBridgeAuth(req);
  if (authFail) {
    return openAiError(
      res,
      authFail,
      BRIDGE_TOKEN
        ? "Unauthorized: missing or wrong Authorization Bearer token (BRIDGE_TOKEN is set)"
        : "Unauthorized",
      null,
      cors
    );
  }

  try {
    if (route === "/health" && req.method === "GET") {
      return sendJson(
        res,
        200,
        {
          status: "ok",
          version: VERSION,
          upstream: `${UPSTREAM.hostname}`,
          hasEnvKey: Boolean(process.env.TYPESAFE_API_KEY),
        },
        cors
      );
    }

    if (route === "/v1/models" && req.method === "GET") {
      return sendJson(res, 200, MODELS_LIST, cors);
    }

    if (route === "/v1/chat/completions" && req.method === "POST") {
      return await handleChatCompletions(req, res, cors);
    }

    if ((route === "/v1/responses" || route === "/responses") && req.method === "POST") {
      return await handleResponses(req, res, cors);
    }

    return openAiError(
      res,
      404,
      `Unknown route: ${req.method} ${route}. Supported: GET /health, GET /v1/models, POST /v1/chat/completions, POST /v1/responses`,
      null,
      cors
    );
  } catch (err) {
    logError("handler error:", err && err.message);
    if (!res.headersSent) {
      return openAiError(res, err.status || 500, err.message || "Internal error", null, cors);
    }
    res.end();
  }
}

async function handleChatCompletions(req, res, cors) {
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    return openAiError(
      res,
      401,
      `No TypeSafe API key. Set TYPESAFE_API_KEY (env or typesafe-bridge/.env), or pass your real ts_live_/ts_test_ key as the Bearer token.`,
      null,
      cors
    );
  }

  let raw;
  let body;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err.status === 413) {
      res.setHeader("Connection", "close");
      const r = openAiError(res, 413, err.message, null, cors);
      // The response is queued; drop the rest of the oversized body now.
      res.on("finish", () => {
        try {
          req.destroy();
        } catch {}
      });
      return r;
    }
    return openAiError(res, 400, "Failed to read request body", null, cors);
  }
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return openAiError(res, 400, "Invalid JSON body", null, cors);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openAiError(res, 400, "messages must be a non-empty array", null, cors);
  }
  const qErr = validateQuestions(body.questions);
  if (qErr) return openAiError(res, 400, qErr, null, cors);

  const rawModel = typeof body.model === "string" ? body.model : "jev-latest";
  const { model, mapped } = resolveUpstreamModel(rawModel);
  if (mapped) log(`model "${rawModel}" mapped to jev-latest`);

  let state = messagesToState(body.messages);
  if (!state) return openAiError(res, 400, "No message content to evaluate", null, cors);
  if (state.length > MAX_STATE_CHARS) {
    res.setHeader("Connection", "close");
    return openAiError(res, 413, `state too large (${state.length} > ${MAX_STATE_CHARS} chars)`, null, cors);
  }
  if (BRIDGE_REDACT) state = redact(state).text;

  const questions = body.questions && typeof body.questions === "object" ? body.questions : inferQuestions(body.messages);
  const stream = Boolean(body.stream);
  const extra = { ...(cors || {}) };
  if (mapped) extra["x-typesafe-model-mapped"] = "jev-latest";

  let result;
  try {
    result = await callTypeSafe(apiKey, { state, model, questions });
  } catch (err) {
    logError("upstream error:", err.message);
    const status = err.status || 502;
    // Nothing has been streamed yet → return a REAL error status.
    return openAiError(res, status, `upstream: ${err.message}`, null, extra);
  }

  const text = answersToText(result && result.answers);
  const id = `chatcmpl-typesafe-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...extra,
    });
    const first = {
      id,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(first)}\n\n`);
    const final = {
      id,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    if (body.stream_options && body.stream_options.include_usage) {
      const usage = (result && result.usage) || {};
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [],
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          },
        })}\n\n`
      );
    }
    return res.end("data: [DONE]\n\n");
  }

  const usage = (result && result.usage) || {};
  res.locals = { ...(res.locals || {}), usage };
  return sendJson(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: rawModel,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      },
      typesafe: result || null,
    },
    extra
  );
}

async function handleResponses(req, res, cors) {
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    return openAiError(res, 401, "No TypeSafe API key (set TYPESAFE_API_KEY or pass a ts_ Bearer token).", null, cors);
  }

  let raw;
  let body;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err.status === 413) {
      res.setHeader("Connection", "close");
      return openAiError(res, 413, err.message, null, cors);
    }
    return openAiError(res, 400, "Failed to read request body", null, cors);
  }
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return openAiError(res, 400, "Invalid JSON body", null, cors);
  }

  const rawModel = typeof body.model === "string" ? body.model : "jev-latest";
  const { model, mapped } = resolveUpstreamModel(rawModel);
  const messages = responsesInputToMessages(body);
  const state = messagesToState(messages);
  if (!state) return openAiError(res, 400, "No input content to evaluate", null, cors);
  if (state.length > MAX_STATE_CHARS) {
    res.setHeader("Connection", "close");
    return openAiError(res, 413, `state too large (${state.length} > ${MAX_STATE_CHARS} chars)`, null, cors);
  }
  if (BRIDGE_REDACT) {
    var stateOut = redact(state).text;
  }
  const qErr = validateQuestions(body.questions);
  if (qErr) return openAiError(res, 400, qErr, null, cors);

  const questions = body.questions && typeof body.questions === "object" ? body.questions : inferQuestions(messages);
  const stream = Boolean(body.stream);
  const extra = { ...(cors || {}) };
  if (mapped) extra["x-typesafe-model-mapped"] = "jev-latest";

  let result;
  try {
    result = await callTypeSafe(apiKey, { state: stateOut || state, model, questions });
  } catch (err) {
    logError("upstream error:", err.message);
    const status = err.status || 502;
    if (res.headersSent) {
      // Already streaming → signal failure in-band.
      const event = { type: "response.failed", response: { status: "failed", error: { code: String(status), message: err.message } } };
      res.write(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
      return res.end();
    }
    return openAiError(res, status, `upstream: ${err.message}`, null, extra);
  }

  const text = answersToText(result && result.answers);
  const created = Math.floor(Date.now() / 1000);
  const respId = `resp_typesafe-${Date.now()}`;
  const msgId = `msg_typesafe-${Date.now()}`;
  const base = { id: respId, object: "response", created_at: created, model: rawModel };
  const outputItem = {
    type: "message",
    id: msgId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const usage = {
    input_tokens: (result && result.usage && result.usage.input_tokens) || 0,
    output_tokens: (result && result.usage && result.usage.output_tokens) || 0,
  };
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
  const full = { ...base, status: "completed", output: [outputItem], usage, typesafe: result || null };

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...extra,
    });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", { response: { ...base, status: "in_progress", output: [] } });
    send("response.output_item.added", {
      output_index: 0,
      item: { ...outputItem, status: "in_progress", content: [] },
    });
    send("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: text });
    send("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text });
    send("response.output_item.done", { output_index: 0, item: outputItem });
    send("response.completed", { response: full });
    return res.end();
  }

  res.locals = { ...(res.locals || {}), usage };
  return sendJson(res, 200, full, extra);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    // Last-resort guard: a request must NEVER take the process down.
    logError("unhandled request error:", err && err.message);
    try {
      if (!res.headersSent) {
        openAiError(res, 500, "Internal bridge error");
      } else {
        res.end();
      }
    } catch {
      /* socket already gone */
    }
  });
});

server.on("clientError", (err, socket) => {
  // Malformed HTTP (e.g. a raw garbage request line) → answer 400, keep alive.
  if (socket.writable && !socket.destroyed) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  } else if (socket && !socket.destroyed) {
    socket.destroy();
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    logError(`port ${PORT} is already in use — another bridge may be running.`);
    logError("set TYPESAFE_BRIDGE_PORT to another port, or stop the other process.");
  } else if (err && err.code === "EACCES") {
    logError(`no permission to bind port ${PORT}.`);
  } else {
    logError("server error:", err && err.message);
  }
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logError("unhandledRejection (bridge keeps serving):", err && (err.stack || err.message || err));
});

function shutdown(signal) {
  log(`${signal} received — shutting down…`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`typesafe-jev-bridge ${VERSION}`);
  process.exit(0);
}

server.requestTimeout = 120_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 30_000;

server.listen(PORT, "127.0.0.1", () => {
  log(`typesafe-jev-bridge v${VERSION} listening on http://127.0.0.1:${PORT}`);
  log(`Routes: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /health`);
  log(`Upstream: ${UPSTREAM.protocol}//${UPSTREAM.hostname}:${UPSTREAM.port}${UPSTREAM.basePath}/v1/systemone`);
  log(`Env key: ${process.env.TYPESAFE_API_KEY ? `set (from ${envInfo.from}${envInfo.encoding === "utf16le" ? ", .env was UTF-16LE — converted" : ""})` : "NOT set (pass a ts_live_/ts_test_ key as Bearer token)"}`);
  log(`Auth: ${BRIDGE_TOKEN ? "BRIDGE_TOKEN required" : "open (set BRIDGE_TOKEN to require a token)"}, redact=${BRIDGE_REDACT ? "on" : "off"}, origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "none (browser origins rejected)"}`);

  // ---- human-facing startup banner (plain when not a TTY / NO_COLOR) ------
  const keyLoaded = Boolean(process.env.TYPESAFE_API_KEY);
  const out = [];
  out.push("");
  out.push(`  ${ui.bold(`typesafe-jev-bridge v${VERSION}`)}`);
  out.push(`  ${ui.ok(`Bridge running     http://127.0.0.1:${PORT}/v1`)}`);
  out.push(
    keyLoaded
      ? `  ${ui.ok(`TypeSafe API key   loaded from ${envInfo.from}`)}`
      : `  ${ui.fail("TypeSafe API key   NOT set — calls will fail until you add one to .env")}`
  );
  out.push(`  ${ui.dim(`Upstream           ${UPSTREAM.protocol}//${UPSTREAM.hostname}${UPSTREAM.basePath}`)}`);
  out.push(`  ${ui.dim(`Models             ${MODELS_LIST.data.map((m) => m.id).join(", ")}`)}`);
  out.push("");
  out.push("  Use it from any OpenAI-compatible tool:");
  out.push(`    Base URL   http://127.0.0.1:${PORT}/v1`);
  out.push(`    API key    ${PLACEHOLDER_KEY}${BRIDGE_TOKEN ? "  (or your BRIDGE_TOKEN)" : ""}`);
  out.push("    Model      typesafe/jev-latest");
  out.push("");
  out.push(`  Try it:   node typesafe-bridge/ask-jev.cjs --text "Server is down" --q "Is this urgent?"`);
  out.push("  Check:    npm run doctor        Stop:  Ctrl+C  (or npm run stop if in background)");
  out.push("");
  console.log(out.join("\n"));
});
