"use strict";
/**
 * lib/env.cjs — .env parsing shared by bridge.js (and available to CLIs).
 *
 * Handles the real-world cases the old inline parser got wrong:
 *   - trailing whitespace in values (old regex `(.*)\s*$` was greedy),
 *   - matching single OR double quotes,
 *   - `export KEY=...`,
 *   - inline ` # comment` on unquoted values,
 *   - UTF-16LE files written by Windows PowerShell 5.1 (`echo "K=V" > .env`
 *     writes UTF-16LE, which used to be read as garbage),
 *   - a UTF-8 BOM.
 * Environment variables already set always win (never overwritten).
 */

function decodeBuffer(buf) {
  // UTF-16LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString("utf16le"), encoding: "utf16le" };
  }
  // UTF-8 BOM: EF BB BF — strip it.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString("utf8").replace(/^\uFEFF/, ""), encoding: "utf8" };
  }
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

function parseLine(line) {
  let s = line.trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("export ")) s = s.slice(7).trim();
  const eq = s.indexOf("=");
  if (eq <= 0) return null;
  const key = s.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = s.slice(eq + 1).trim();
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) {
      value = value.slice(1, -1);
    } else if (q !== '"' && q !== "'") {
      // inline comment on unquoted values
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
  }
  return { key, value };
}

/** Parse .env text into { key: value } (does NOT touch process.env). */
function parseEnvText(text) {
  const out = {};
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const kv = parseLine(line);
    if (kv && !(kv.key in out)) out[kv.key] = kv.value;
  }
  return out;
}

/**
 * Read a .env file (any of the encodings above) into { key: value }.
 * @returns {{values:object, encoding:string}} or {values:{}, encoding:null} when missing
 */
function readEnvFile(file) {
  const fs = require("fs");
  if (!fs.existsSync(file)) return { values: {}, encoding: null };
  const buf = fs.readFileSync(file);
  const { text, encoding } = decodeBuffer(buf);
  return { values: parseEnvText(text), encoding };
}

/**
 * Load `file` into process.env without overwriting existing variables.
 * @returns {{loaded:string[], encoding:string|null}} keys actually applied
 */
function loadEnvFile(file) {
  const { values, encoding } = readEnvFile(file);
  const loaded = [];
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return { loaded, encoding };
}

module.exports = { parseEnvText, readEnvFile, loadEnvFile, decodeBuffer };
