"use strict";
/**
 * lib/targets.cjs — shared file discovery + state building for audit/autofix.
 *
 * The state header uses the path RELATIVE to the repo root: the old code sent
 * `File: C:\Users\<name>\Documents\Jev\typesafe-bridge\bridge.js` to the API,
 * leaking the local username and directory layout to a third party.
 */

const fs = require("fs");
const path = require("path");
const { sensitiveReason } = require("./sensitive.cjs");

const MAX_FILE_BYTES_DEFAULT = 400_000;

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "node_modules",
  ".freebuff",
  ".agents",
  "__pycache__",
  "coverage",
  "test",
  "lib",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".zip",
  ".gz", ".tar", ".exe", ".dll", ".woff", ".woff2", ".ttf", ".eot",
  ".sqlite", ".sqlite3", ".pyc", ".p12", ".pfx",
]);

function hasBinaryBytes(buf, sample = 8192) {
  const n = Math.min(buf.length, sample);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Basename denylist shared with lib/sensitive.cjs plus tool leftovers. */
function isSkippedBase(base) {
  const lower = base.toLowerCase();
  if (sensitiveReason(base)) return true;
  if (lower.endsWith(".bak-autofix")) return true;
  if (lower === "e2e-live.cjs" || lower.startsWith("test-")) return true;
  return false;
}

/**
 * List auditable files under `root`, sorted, with shared ignore rules.
 * @param {string} root repo root
 * @param {object} [opts] { extraBytes?: number }
 * @returns {string[]} absolute paths
 */
function listTargets(root, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_FILE_BYTES_DEFAULT;
  const rootAbs = fs.realpathSync(path.resolve(root));
  const out = [];

  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(p);
        continue;
      }
      if (entry.isFile()) {
        if (isSkippedBase(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        let stat;
        try {
          stat = fs.statSync(p);
        } catch {
          continue;
        }
        if (stat.size > maxBytes) continue;
        out.push(p);
      }
    }
  })(rootAbs);

  return out.sort();
}

/**
 * Read a file and build the state string with a repo-root-relative header.
 * Lines are capped (2000) and byte size is capped; binary files are rejected.
 * @param {string} file absolute or root-relative path
 * @param {object} [opts] { root, maxBytes, numberLines }
 * @returns {{ state:string, relPath:string, lines:number, truncated:boolean, content:string }}
 */
function readState(file, opts = {}) {
  const root = opts.root || path.join(__dirname, "..", "..");
  const maxBytes = opts.maxBytes || MAX_FILE_BYTES_DEFAULT;
  const abs = path.resolve(root, file);
  const buf = fs.readFileSync(abs);
  if (buf.length > maxBytes) {
    const err = new Error(`file too large (${buf.length} bytes > ${maxBytes})`);
    err.code = "EFILETOOBIG";
    throw err;
  }
  if (hasBinaryBytes(buf)) {
    const err = new Error("binary file — refusing to send");
    err.code = "EBINARY";
    throw err;
  }
  let content = buf.toString("utf8");
  const relPath = path.relative(root, abs).replace(/\\/g, "/") || file;
  const lines = content.split(/\r?\n/);
  const cap = 2000;
  const shown = lines.slice(0, cap);
  const truncated = lines.length > cap;
  const suffix = truncated ? `\n... (${lines.length - cap} more lines)` : "";
  const numbered = opts.numberLines === false
    ? shown.join("\n")
    : shown.map((l, i) => `${i + 1}| ${l}`).join("\n");
  const state = `File: ${relPath} (${lines.length} lines)\n${numbered}${suffix}`;
  return { state, relPath, lines: lines.length, truncated, content };
}

/** Fixed 2-decimal formatting for scores. */
function fmt(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "?";
}

module.exports = { listTargets, readState, fmt, hasBinaryBytes, MAX_FILE_BYTES_DEFAULT };
