"use strict";
/**
 * lib/client.cjs — shared HTTP plumbing for every consumer of the bridge.
 * Zero dependencies; node: built-ins only.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyFetchError(err, url) {
  const msg = String((err && err.message) || err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|UND_ERR|socket hang up/i.test(msg)) {
    return new Error(
      `cannot reach the bridge at ${url} — is \`node bridge.js\` running? (${msg})`
    );
  }
  return err;
}

function parseRetryAfter(res) {
  const v = res.headers && res.headers.get && res.headers.get("retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 10_000);
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.min(Math.max(t - Date.now(), 0), 10_000);
  return null;
}

const RETRYABLE_STATUS = new Set([429, 529]);

/**
 * Fetch with timeout + retry. Retries up to 2 times with exponential backoff
 * (honoring Retry-After) on 429 / 529 / network errors.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number, retries?:number}} [opts]
 * @returns {Promise<Response>}
 */
async function bridgeFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60_000;
  const retries = opts.retries == null ? 2 : opts.retries;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = lastErr && lastErr.retryAfterMs != null
        ? lastErr.retryAfterMs
        : Math.min(500 * 2 ** (attempt - 1), 4_000);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        const err = new Error(`upstream busy (${res.status})`);
        err.retryable = true;
        err.retryAfterMs = parseRetryAfter(res);
        lastErr = err;
        continue;
      }
      return res;
    } catch (err) {
      const isTimeout = /aborted|timeout/i.test(String(err && err.message));
      lastErr = err;
      if ((isTimeout || err.name === "AbortError") && attempt < retries) {
        continue;
      }
      if (attempt >= retries) throw friendlyFetchError(err, url);
      // network error → retry
    }
  }
  throw friendlyFetchError(lastErr, url);
}

/**
 * Parse the first JSON object out of a possibly SSE-suffixed body.
 * Tolerant of `data: [DONE]` trailers that some routers append.
 */
function firstJson(raw) {
  const text = String(raw == null ? "" : raw);
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON in response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON in response");
}

module.exports = { bridgeFetch, firstJson, sleep };
