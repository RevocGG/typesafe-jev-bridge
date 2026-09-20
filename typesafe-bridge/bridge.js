#!/usr/bin/env node
/**
 * TypeSafe Jev ↔ OpenAI-compatible bridge
 * ---------------------------------------
 * Lets 9Router (or any OpenAI client) talk to the TypeSafe "System One" API.
 *
 *   OpenAI client → POST /v1/chat/completions → this bridge → POST api.typesafe.ai/v1/systemone
 *
 * The answer is rendered back as chat text. When the caller does not provide
 * TypeSafe `questions`, they are inferred:
 *   1. A JSON object with string values in the system (or first user) message
 *      becomes a `choice` question (labels = its keys).
 *   2. A yes/no phrasing (or yes/no criteria) becomes a `noul` question.
 *   3. Otherwise a yes/no choice question is used.
 *
 * Auth: set TYPESAFE_API_KEY in the environment, or pass your real TypeSafe key
 * as the Bearer token per request. Any OpenAI client can use the placeholder
 * key "sk-typesafe-bridge" when the env var is set.
 *
 * Security: binds to 127.0.0.1 only, and rejects requests whose Host header is
 * not loopback or whose Origin header is a non-local browser origin
 * (DNS-rebinding / cross-origin protection for the user's paid API key).
 *
 * Run:  node bridge.js          (port: TYPESAFE_BRIDGE_PORT, default 8399)
 * Test: curl http://localhost:8399/health
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env from the bridge directory (KEY=VALUE lines, no dependency).
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^"|"$/g, "");
      }
    }
  }
} catch {
  /* ignore missing/invalid .env */
}

const PORT = Number(process.env.TYPESAFE_BRIDGE_PORT || 8399);
const UPSTREAM_HOST = process.env.TYPESAFE_API_BASE
  ? new URL(process.env.TYPESAFE_API_BASE).host
  : "api.typesafe.ai";
const PLACEHOLDER_KEY = "sk-typesafe-bridge";
const BRIDGE_MODEL_PREFIX = "typesafe/";

const MODELS_LIST = {
  object: "list",
  data: [
    { id: "typesafe/jev-latest", object: "model", owned_by: "typesafe" },
    { id: "typesafe/jev-preview", object: "model", owned_by: "typesafe" },
    { id: "jev-latest", object: "model", owned_by: "typesafe" },
  ],
};

// ---------------------------------------------------------------- helpers ---

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function openAiError(res, status, message, code) {
  sendJson(res, status, {
    error: { message, type: "invalid_request_error", code: code || null },
  });
}

/** Extract a bearer token from the Authorization header, or null. */
function bearerToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the TypeSafe API key for this request. */
function resolveApiKey(req) {
  const token = bearerToken(req);
  const envKey = process.env.TYPESAFE_API_KEY;
  if (token && token !== PLACEHOLDER_KEY) return token;
  if (envKey) return envKey;
  return null;
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

/**
 * Infer TypeSafe questions from the conversation when the caller did not
 * provide an explicit `questions` map.
 */
function inferQuestions(messages) {
  const systemMsg = (messages || []).find((m) => m && m.role === "system");
  const firstUser = (messages || []).find((m) => m && m.role === "user");
  const specSource = systemMsg || firstUser;

  // 1) JSON object spec → choice question with the object keys as options.
  if (specSource && typeof specSource.content === "string") {
    const fenced = /```(?:json)?\s*([\s\S]+?)```/.exec(specSource.content);
    const candidate = fenced ? fenced[1] : specSource.content;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(candidate.slice(start, end + 1));
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const keys = Object.keys(obj).filter((k) => k.length <= 80);
          if (keys.length >= 2) {
            const text = pickQuestionText(obj) || "Decide the best answer for the state";
            return {
              answer: { type: "choice", instructions: text, criteria: obj },
            };
          }
          if (keys.length === 1) {
            // Single-key spec: keep the key as the answer id, ask yes/no.
            const text =
              firstString(obj[keys[0]], 500) || "Evaluate the state";
            return {
              [keys[0]]: {
                type: "choice",
                instructions: text,
                criteria: {
                  yes: "The answer is yes / positive",
                  no: "The answer is no / negative",
                },
              },
            };
          }
        }
      } catch {
        /* not JSON — fall through */
      }
    }
  }

  const instruction = specSource
    ? firstString(specSource.content, 500) || "Evaluate the state"
    : "Evaluate the state";

  // 2) Explicit yes/no phrasing → noul.
  if (looksLikeYesNo(instruction)) {
    return { answer: { type: "noul", instructions: instruction } };
  }

  // 3) Default: yes/no choice so structured consumers stay predictable.
  return {
    answer: {
      type: "choice",
      instructions: instruction,
      criteria: { yes: "The answer is yes / positive", no: "The answer is no / negative" },
    },
  };
}

/** Map the TypeSafe answers map back to readable chat text. */
function answersToText(answers) {
  const lines = [];
  for (const [key, ans] of Object.entries(answers || {})) {
    const suffix =
      ans.confidence != null ? ` (confidence: ${ans.confidence})` : "";
    if (ans.type === "noul") {
      lines.push(`${key}: ${ans.noul}${suffix}`);
    } else if (ans.type === "choice") {
      lines.push(`${key}: ${ans.choice}${suffix}`);
    } else if (ans.type === "score") {
      lines.push(`${key}: ${ans.score}${suffix}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(ans)}`);
    }
  }
  return lines.join("\n") || "{}";
}

function callTypeSafe(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        host: UPSTREAM_HOST,
        path: "/v1/systemone",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* keep raw text */
          }
          if (res.statusCode >= 400) {
            const msg =
              (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
              (parsed && parsed.detail) ||
              data.slice(0, 500) ||
              `HTTP ${res.statusCode}`;
            const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
            err.status = res.statusCode;
            reject(err);
          } else {
            resolve(parsed);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Upstream timeout (60s)")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > (limit || 10 * 1024 * 1024)) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Map any incoming model id to a real TypeSafe model:
 *   "typesafe/jev-latest"          -> jev-latest
 *   "jev-latest/typesafe/jev-latest" -> jev-latest   (9Router node prefix)
 *   "jev-latest/model-id"          -> jev-latest   (combo placeholder)
 */
function resolveUpstreamModel(rawModel) {
  let m = rawModel || "jev-latest";
  if (m.includes("/")) m = m.split("/").pop();
  // Only genuine TypeSafe models pass through; anything else (combo names like
  // "claude-sonnet-4-5", placeholders like "model-id") maps to the flagship.
  if (!m || !/^jev([-/]|$)/i.test(m)) m = "jev-latest";
  return m;
}

/**
 * Convert an OpenAI Responses-API request body ({model, instructions, input})
 * into the `messages` array shape used by the rest of the bridge.
 */
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

// ----------------------------------------------------------------- server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  log(req.method, path);

  try {
    // DNS-rebinding / cross-origin protection: this bridge is a localhost tool.
    const host = (req.headers.host || "").trim();
    if (!/^(\[::1\]|127\.0\.0\.1|localhost|.*\.localhost)(:\d+)?$/i.test(host)) {
      return openAiError(
        res,
        403,
        `Host header "${host}" is not a loopback address. This bridge only serves local requests.`
      );
    }
    const origin = req.headers.origin;
    if (origin) {
      let o = null;
      try {
        o = new URL(origin);
      } catch {
        /* malformed origin */
      }
      const localOrigin =
        o &&
        (o.hostname === "127.0.0.1" ||
          o.hostname === "localhost" ||
          o.hostname.endsWith(".localhost"));
      if (!localOrigin) {
        return openAiError(
          res,
          403,
          `Cross-origin request rejected (Origin: ${origin}). This bridge is for local tools only.`
        );
      }
    }

    if (path === "/health" && req.method === "GET") {
      return sendJson(res, 200, {
        status: "ok",
        upstream: UPSTREAM_HOST,
        hasEnvKey: Boolean(process.env.TYPESAFE_API_KEY),
      });
    }

    if (path === "/v1/models" && req.method === "GET") {
      return sendJson(res, 200, MODELS_LIST);
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const apiKey = resolveApiKey(req);
      if (!apiKey) {
        return openAiError(
          res,
          401,
          `No TypeSafe API key. Set the TYPESAFE_API_KEY environment variable for the bridge, or pass your real key as the Bearer token (placeholder "${PLACEHOLDER_KEY}" is only accepted when the env var is set).`
        );
      }

      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return openAiError(res, 400, "Invalid JSON body");
      }

      const rawModel = typeof body.model === "string" ? body.model : "jev-latest";
      const model = resolveUpstreamModel(rawModel);
      const state = messagesToState(body.messages);
      if (!state) return openAiError(res, 400, "No message content to evaluate");
      const questions =
        body.questions && typeof body.questions === "object"
          ? body.questions
          : inferQuestions(body.messages);
      const stream = Boolean(body.stream);

      let result;
      try {
        result = await callTypeSafe(apiKey, { state, model, questions });
      } catch (err) {
        log("upstream error:", err.message);
        const status = err.status || 502;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const chunk = {
            id: "chatcmpl-typesafe-error",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: rawModel,
            choices: [{ index: 0, delta: { content: `Error: ${err.message}` }, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          return res.end("data: [DONE]\n\n");
        }
        return openAiError(res, status, err.message);
      }

      const text = answersToText(result && result.answers);
      const id = `chatcmpl-typesafe-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const final = {
          id,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        res.write(`data: ${JSON.stringify(final)}\n\n`);
        return res.end("data: [DONE]\n\n");
      }

      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: rawModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: (result && result.usage && result.usage.input_tokens) || 0,
          completion_tokens: (result && result.usage && result.usage.output_tokens) || 0,
          total_tokens:
            ((result && result.usage && result.usage.input_tokens) || 0) +
            ((result && result.usage && result.usage.output_tokens) || 0),
        },
        typesafe: result || null,
      });
    }

    // OpenAI Responses API (apiType: "responses" nodes in 9Router)
    if (
      (path === "/v1/responses" || path === "/responses") &&
      req.method === "POST"
    ) {
      const apiKey = resolveApiKey(req);
      if (!apiKey) {
        return openAiError(
          res,
          401,
          `No TypeSafe API key. Set the TYPESAFE_API_KEY environment variable for the bridge, or pass your real key as the Bearer token (placeholder "${PLACEHOLDER_KEY}" is only accepted when the env var is set).`
        );
      }

      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return openAiError(res, 400, "Invalid JSON body");
      }

      const rawModel = typeof body.model === "string" ? body.model : "jev-latest";
      const model = resolveUpstreamModel(rawModel);
      const messages = responsesInputToMessages(body);
      const state = messagesToState(messages);
      if (!state) return openAiError(res, 400, "No input content to evaluate");
      const questions =
        body.questions && typeof body.questions === "object"
          ? body.questions
          : inferQuestions(messages);
      const stream = Boolean(body.stream);

      let result;
      try {
        result = await callTypeSafe(apiKey, { state, model, questions });
      } catch (err) {
        log("upstream error:", err.message);
        const status = err.status || 502;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const event = {
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: String(status), message: err.message },
            },
          };
          res.write(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
          return res.end();
        }
        return openAiError(res, status, err.message);
      }

      const text = answersToText(result && result.answers);
      const created = Math.floor(Date.now() / 1000);
      const respId = `resp_typesafe-${Date.now()}`;
      const msgId = `msg_typesafe-${Date.now()}`;
      const base = {
        id: respId,
        object: "response",
        created_at: created,
        model: rawModel,
      };
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
      const full = {
        ...base,
        status: "completed",
        output: [outputItem],
        usage,
        typesafe: result || null,
      };

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (type, data) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
          );
        send("response.created", {
          response: { ...base, status: "in_progress", output: [] },
        });
        send("response.output_item.added", {
          output_index: 0,
          item: { ...outputItem, status: "in_progress", content: [] },
        });
        send("response.output_text.delta", {
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        send("response.output_text.done", {
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          text,
        });
        send("response.output_item.done", { output_index: 0, item: outputItem });
        send("response.completed", { response: full });
        return res.end();
      }

      return sendJson(res, 200, full);
    }

    return openAiError(
      res,
      404,
      `Unknown route: ${req.method} ${path}. Supported: GET /health, GET /v1/models, POST /v1/chat/completions, POST /v1/responses`
    );
  } catch (err) {
    log("bridge error:", err.message);
    if (!res.headersSent) {
      return openAiError(res, err.status || 500, err.message);
    }
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`TypeSafe bridge listening on http://127.0.0.1:${PORT}`);
  log(`Routes: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /health`);
  log(`Upstream: https://${UPSTREAM_HOST}/v1/systemone`);
  log(`Env API key: ${process.env.TYPESAFE_API_KEY ? "set" : "not set (pass real key as Bearer token)"}`);
});
