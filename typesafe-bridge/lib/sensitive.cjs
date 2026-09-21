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
 * True when `p` is a filesystem-absolute path *for the current platform*.
 * Windows drive-letter paths ("C:/…", "C:\\…") and UNC paths are absolute on
 * win32 but NOT on POSIX, where they are just odd relative folder names —
 * a Windows absolute path passed on Linux must still be rejected, not
 * silently resolved to a harmless-looking directory inside the root.
 */
function isPlatformAbsolute(p) {
  const s = String(p);
  if (path.isAbsolute(s)) return true;
  if (process.platform === "win32") return false; // path.isAbsolute already covered drive/UNC
  // POSIX: a drive-letter or UNC path is foreign and must be treated as absolute.
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(s);
}

/**
 * Refuse any path that resolves outside `root` (after symlink resolution).
 * @throws Error with code EOUTSIDEROOT
 */
function assertInsideRoot(p, root) {
  const rootAbs = fs.realpathSync(path.resolve(root));
  const raw = String(p);
  // An absolute path (per EITHER platform's rules) is never resolved relative
  // to the root: if it is not inside root verbatim, it is refused outright.
  if (isPlatformAbsolute(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    const candidates = [path.resolve(raw), path.posix.resolve("/", raw), path.win32.resolve("C:\\", raw)];
    let inside = false;
    for (const cand of candidates) {
      // Absolute paths are checked LEXICALLY (with the deepest existing
      // ancestor for the non-existent tail) — an absolute path must never be
      // re-rooted onto `root`, which is exactly the POSIX drive-letter bug.
      let probe = cand;
      let real;
      for (;;) {
        try {
          real = fs.realpathSync(probe);
          break;
        } catch {
          const parent = path.dirname(probe);
          if (parent === probe) {
            real = probe;
            break;
          }
          probe = parent;
        }
      }
      const a = real.toLowerCase() + path.sep;
      const b = rootAbs.toLowerCase() + path.sep;
      if (real.toLowerCase() === rootAbs.toLowerCase() || a.startsWith(b)) {
        inside = true;
        break;
      }
    }
    if (!inside) {
      const err = new Error(
        `refusing to touch "${raw}" — it resolves outside the repo root (${rootAbs})`
      );
      err.code = "EOUTSIDEROOT";
      throw err;
    }
    return path.resolve(rootAbs, raw);
  }
  const target = path.resolve(rootAbs, raw);
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
