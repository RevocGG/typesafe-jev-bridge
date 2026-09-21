"use strict";
/**
 * lib/redact.cjs — shared secret detection + redaction.
 *
 * Used by ask-jev.cjs, audit.cjs, autofix.cjs and (opt-in, BRIDGE_REDACT=1)
 * by bridge.js. Design goals:
 *   - Patterns are compiled ONCE with the flags they need (never rebuilt via
 *     `new RegExp(re.source)`, which silently dropped the `i` flag before).
 *   - PEM private keys are redacted as a WHOLE block (body + END line). A
 *     missing END marker redacts to the end of the text.
 *   - Token formats with underscores (ghp_, github_pat_, ts_live_, sk_live_,
 *     npm_, hf_, glpat_, xapp_, AIza…, JWTs, Bearer headers, URL credentials)
 *     are recognized, in upper and lower case.
 *   - Assignment-style secrets keep the KEY name visible (so Jev can still
 *     flag "hardcoded credential") but the VALUE is fully replaced — no
 *     prefix of the secret is ever kept.
 *   - Findings carry a line number and a kind, never any part of the value.
 */

// Whole PEM block. The `(?:…|$)` tail redacts to end-of-text when the END
// marker is missing (truncated paste).
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

// Token formats (case-insensitive so UPPERCASE .env values are caught too).
const TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:sk|ts|npm|hf)_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{16,}|xapp-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}/gi;

// JWTs (three dot-separated base64url segments; header always starts "eyJ").
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

// Bearer header values (keep the scheme, redact the value).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

// scheme://user:password@host — redact the password, keep scheme://user@.
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\/:\s@]+):([^@\/\s]{4,})@/gi;

// identifier-with-secret-keyword = value  (value >= 8 non-space chars).
// Accepts bare (KEY=value) and quoted JSON-style ("api_key": "...") forms.
// Redacts the VALUE only and keeps the key name.
const ASSIGN_RE = /("?)([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_.-]*)("?)\s*[:=]\s*(?:"([^"]{8,})"|'([^']{8,})'|([^\s"']{8,}))/gi;

function isAlreadyRedacted(value) {
  return typeof value === "string" && value.includes("[REDACTED");
}

/** Line number (1-based) of the character at `index` in `text`. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Scan `text` for secret-like content.
 * @returns {{kind:string, line:number}[]}
 */
function scan(text) {
  const findings = [];
  const seen = new Set();
  const add = (kind, index) => {
    const line = lineOf(text, index);
    const key = `${kind}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ kind, line });
    }
  };
  if (typeof text !== "string" || text.length === 0) return findings;

  let m;
  PEM_RE.lastIndex = 0;
  while ((m = PEM_RE.exec(text)) !== null) {
    add("private-key", m.index);
    if (m.index === PEM_RE.lastIndex) PEM_RE.lastIndex++;
  }
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    add("api-token", m.index);
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++;
  }
  JWT_RE.lastIndex = 0;
  while ((m = JWT_RE.exec(text)) !== null) {
    add("jwt", m.index);
    if (m.index === JWT_RE.lastIndex) JWT_RE.lastIndex++;
  }
  BEARER_RE.lastIndex = 0;
  while ((m = BEARER_RE.exec(text)) !== null) {
    add("bearer-token", m.index);
    if (m.index === BEARER_RE.lastIndex) BEARER_RE.lastIndex++;
  }
  URL_CRED_RE.lastIndex = 0;
  while ((m = URL_CRED_RE.exec(text)) !== null) {
    add("url-credentials", m.index);
    if (m.index === URL_CRED_RE.lastIndex) URL_CRED_RE.lastIndex++;
  }
  ASSIGN_RE.lastIndex = 0;
  while ((m = ASSIGN_RE.exec(text)) !== null) {
    const value = m[4] || m[5] || m[6] || "";
    if (!isAlreadyRedacted(value)) add("assignment", m.index);
    if (m.index === ASSIGN_RE.lastIndex) ASSIGN_RE.lastIndex++;
  }
  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return findings;
}

/**
 * Redact secret-like content in `text`.
 * @returns {{text:string, findings:{kind:string,line:number}[]}}
 */
function redact(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text == null ? "" : String(text), findings: [] };
  }
  const findings = scan(text);
  let out = text;

  out = out.replace(PEM_RE, () => "[REDACTED:private-key]");
  out = out.replace(TOKEN_RE, () => "[REDACTED:api-token]");
  out = out.replace(JWT_RE, () => "[REDACTED:jwt]");
  out = out.replace(BEARER_RE, () => "Bearer [REDACTED:bearer-token]");
  out = out.replace(URL_CRED_RE, (_m, scheme, user) => `${scheme}${user}:[REDACTED:url-credentials]@`);
  out = out.replace(ASSIGN_RE, (m, q1, key, q2, dq, sq, bare) => {
    const val = dq || sq || bare;
    if (isAlreadyRedacted(val)) return m;
    const quote = dq ? '"' : sq ? "'" : "";
    return `${q1}${key}${q2}: ${quote}[REDACTED:assignment]${quote}`;
  });
  return { text: out, findings };
}

module.exports = { redact, scan };
