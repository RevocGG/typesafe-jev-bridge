"use strict";
/**
 * lib/sensitive.cjs — one denylist for files whose content must never be sent
 * to a third-party API or rewritten by autofix. Used by ask-jev --file,
 * audit.cjs and autofix.cjs — for discovered files AND explicit arguments.
 */

const fs = require("fs");
const path = require("path");

// Exact basenames.
const SENSITIVE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "nohup.out",
]);

// Basename prefixes: .env.local, credentials.json, id_rsa, id_ed25519, answers1.json
const SENSITIVE_PREFIXES = [".env", "credentials", "id_rsa", "id_ed25519"];

// Suffixes: .pem, .key, .p12, .pfx, .log, .sqlite … and any *.bak-autofix*
const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".log",
  ".sqlite",
  ".sqlite3",
];

// Directory names: nothing inside these may be sent or rewritten.
const SENSITIVE_DIRS = new Set([
  ".git",
  ".agents",
  ".freebuff",
  "__pycache__",
]);

/**
 * @param {string} p file or directory path (absolute or relative)
 * @returns {string|null} reason string when sensitive, null when safe
 */
function sensitiveReason(p) {
  if (p == null || p === "") return null;
  const norm = String(p).replace(/\\/g, "/");
  const segments = norm.split("/").filter(Boolean);
  const base = segments[segments.length - 1] || "";
  const lowerBase = base.toLowerCase();

  for (const seg of segments) {
    if (SENSITIVE_DIRS.has(seg.toLowerCase())) {
      return `inside protected directory "${seg}/"`;
    }
  }
  if (SENSITIVE_NAMES.has(lowerBase)) return `sensitive file "${base}"`;
  for (const prefix of SENSITIVE_PREFIXES) {
    if (lowerBase.startsWith(prefix)) return `sensitive file "${base}"`;
  }
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lowerBase.endsWith(suffix)) return `sensitive file "${base}"`;
  }
  if (lowerBase.includes(".bak-autofix")) return `autofix backup "${base}"`;
  if (lowerBase.startsWith("answers") && lowerBase.endsWith(".json")) {
    return `judgment output "${base}"`;
  }
  return null;
}

/** @returns {boolean} true when the path matches the sensitive denylist. */
function isSensitivePath(p) {
  return sensitiveReason(p) !== null;
}

/**
 * Refuse any path that resolves outside `root` (after symlink resolution).
 * @throws Error with code EOUTSIDEROOT
 */
function assertInsideRoot(p, root) {
  const rootAbs = fs.realpathSync(path.resolve(root));
  const target = path.resolve(rootAbs, String(p));
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Path does not exist yet — resolve the deepest existing ancestor.
    let parent = path.dirname(target);
    try {
      real = fs.realpathSync(parent);
    } catch {
      real = path.resolve(parent);
    }
  }
  const a = real.toLowerCase() + path.sep;
  const b = rootAbs.toLowerCase() + path.sep;
  const inside = real.toLowerCase() === rootAbs.toLowerCase() || a.startsWith(b);
  if (!inside) {
    const err = new Error(
      `refusing to touch "${p}" — it resolves outside the repo root (${rootAbs})`
    );
    err.code = "EOUTSIDEROOT";
    throw err;
  }
  return real;
}

module.exports = { isSensitivePath, sensitiveReason, assertInsideRoot };
