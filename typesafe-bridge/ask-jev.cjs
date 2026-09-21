#!/usr/bin/env node
/**
 * ask-jev — ask TypeSafe Jev typed questions (noul/choice/score) about files
 * or any text, through the local bridge.
 *
 * Exit codes:
 *   0  answered confidently
 *   1  error (network, bridge, argument failure at runtime)
 *   2  usage error (bad flags / missing arguments)
 *   3  answered with low confidence / uncertain band
 *
 * Security:
 *   - Secret-like values are masked BEFORE anything leaves the machine
 *     (default on; --no-redact disables and prints a warning).
 *   - Sensitive files (.env, keys, *.pem …) are refused unless --allow-sensitive.
 *   - --url must be loopback unless --allow-remote is given.
 *
 * Examples:
 *   node ask-jev.cjs --file src/index.ts --q "Does this file have security issues?"
 *   node ask-jev.cjs --text "Server is on fire, customers leaving" \
 *     --q "Is this urgent?" --type noul
 *   node ask-jev.cjs --file big.ts --q "Which category?" --type choice \
 *     --criteria "auth=Authentication logic,routes=HTTP routes,utils=Helpers"
 *   echo "chat log" | node ask-jev.cjs --q "How angry is the customer?" \
 *     --type score --criteria "Calm, Frustrated, Very angry"
 *   node ask-jev.cjs --text-file notes.txt --q "What is the mood?" --json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { redact } = require("./lib/redact.cjs");
const { isSensitivePath, sensitiveReason } = require("./lib/sensitive.cjs");
const { bridgeFetch } = require("./lib/client.cjs");

const VERSION = (() => {
  try {
    return require("../package.json").version;
  } catch {
    return "0.0.0";
  }
})();

function usage() {
  console.log(`ask-jev v${VERSION} — ask TypeSafe Jev a typed question about a file or text.

USAGE
  node ask-jev.cjs [state] --q "<question>" [--type noul|choice|score] [options]

STATE (exactly one; or pipe text via stdin)
  --file <path...>       one or more files (content with line numbers becomes the state)
  --dir  <path>          list a directory's files (names only) as state
  --text <string>        raw text as state
  --text-file <path>     read the state text from a file

QUESTION
  --q <string>           question (required)
  --type <t>             noul (yes/no) | choice | score    [default: inferred —
                         score when --criteria given, otherwise noul]
  --criteria <list>      comma-separated score levels or choice options
                         (use key=description for named choice options)

OUTPUT / BEHAVIOUR
  --min-conf <0..1>      low-confidence threshold for choice/score [default: 0.55]
  --json                 machine-readable JSON output
  --max-bytes <n>        max file size in bytes [default: 400000]
  --redact               mask secret-like values before sending [default: ON]
  --no-redact            send state unredacted (prints a warning)
  --allow-sensitive      allow reading .env / key / credential files (not recommended)
  --allow-remote         allow a non-loopback --url (state and token leave localhost!)

ENDPOINT
  --url <url>            bridge URL [default: http://127.0.0.1:8399, or TYPESAFE_BRIDGE_URL]
  --token <string>       bridge auth token [default: BRIDGE_TOKEN env, or sk-typesafe-bridge]
  --timeout <ms>         request timeout [default: 60000]

ENV VARS
  TYPESAFE_BRIDGE_URL    default bridge URL
  BRIDGE_TOKEN           auth token when the bridge is started with BRIDGE_TOKEN

EXIT CODES
  0  answered (confident enough)      2  usage error
  1  runtime error                    3  uncertain / low confidence

EXAMPLES
  node ask-jev.cjs --file src/index.ts --q "Does this file have security issues?"
  node ask-jev.cjs --text "Is the database down again?" --q "Is this urgent?"
  node ask-jev.cjs --dir src --q "Is this codebase well organized?"
  echo "angry chat log" | node ask-jev.cjs --q "How angry is the customer?" \\
    --type score --criteria "Calm, Frustrated, Very angry"`);
}

function parseArgs(argv) {
  const args = {
    files: [],
    dir: null,
    text: null,
    textFile: null,
    q: null,
    type: null,
    criteria: null,
    minConf: 0.55,
    maxBytes: 400_000,
    redact: true,
    allowSensitive: false,
    allowRemote: false,
    url: process.env.TYPESAFE_BRIDGE_URL || "http://127.0.0.1:8399",
    token: process.env.BRIDGE_TOKEN || "sk-typesafe-bridge",
    timeoutMs: 60_000,
    json: false,
    help: false,
    version: false,
  };
  const needsValue = new Set([
    "--file", "--dir", "--text", "--text-file", "--q", "--type", "--criteria",
    "--min-conf", "--max-bytes", "--url", "--token", "--timeout",
  ]);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      let v;
      while ((v = argv[++i]) && !v.startsWith("--")) args.files.push(v);
      if (!args.files.length) return { error: "--file requires at least one path" };
      i--;
    } else if (needsValue.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} requires a value` };
      if (a === "--dir") args.dir = v;
      else if (a === "--text") args.text = v;
      else if (a === "--text-file") args.textFile = v;
      else if (a === "--q") args.q = v;
      else if (a === "--type") args.type = v;
      else if (a === "--criteria") args.criteria = v;
      else if (a === "--min-conf") args.minConf = Number(v);
      else if (a === "--max-bytes") args.maxBytes = Number(v);
      else if (a === "--url") args.url = v;
      else if (a === "--token") args.token = v;
      else if (a === "--timeout") args.timeoutMs = Number(v);
    } else if (a === "--redact") args.redact = true;
    else if (a === "--no-redact") args.redact = false;
    else if (a === "--allow-sensitive") args.allowSensitive = true;
    else if (a === "--allow-remote") args.allowRemote = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else return { error: `unknown flag "${a}" (see --help)` };
  }
  return { args };
}

function failUsage(msg, code = 2) {
  console.error(`usage error: ${msg} (see --help)`);
  process.exit(code);
}

/** Validate + build the typed question map with a stable answer id. */
function buildQuestion(args) {
  if (!args.q) failUsage("--q is required");
  const q = args.q;
  const type = args.type || (args.criteria ? "score" : "noul");
  if (!["noul", "choice", "score"].includes(type)) {
    failUsage(`--type must be noul|choice|score (got "${args.type}")`);
  }
  if (args.minConf == null || Number.isNaN(args.minConf) || args.minConf < 0 || args.minConf > 1) {
    failUsage("--min-conf must be a number between 0 and 1");
  }
  if (args.maxBytes == null || Number.isNaN(args.maxBytes) || args.maxBytes < 100) {
    failUsage("--max-bytes must be a number >= 100");
  }
  if (args.timeoutMs == null || Number.isNaN(args.timeoutMs) || args.timeoutMs < 1000) {
    failUsage("--timeout must be a number >= 1000");
  }

  const id = "answer"; // stable id; the raw question text can be any length
  if (type === "noul") return { map: { [id]: { type: "noul", instructions: q } }, type };
  const items = (args.criteria || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) failUsage(`--type ${type} requires --criteria`);
  if (type === "score") return { map: { [id]: { type: "score", instructions: q, criteria: items } }, type };

  const criteria = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq > 0) criteria[item.slice(0, eq)] = item.slice(eq + 1);
    else criteria[item] = item;
  }
  return { map: { [id]: { type: "choice", instructions: q, criteria } }, type };
}

/** Read the state from files / dir / text / stdin. Exits 2 on misuse. */
function readState(args, piped) {
  const parts = [];
  if (piped) parts.push(`Piped input:\n${piped}`);
  if (args.textFile) {
    if (!fs.existsSync(args.textFile)) failUsage(`--text-file not found: ${args.textFile}`);
    parts.push(fs.readFileSync(args.textFile, "utf8"));
  }
  if (args.text) parts.push(args.text);
  if (args.dir) {
    if (!fs.existsSync(args.dir)) failUsage(`--dir not found: ${args.dir}`);
    const entries = fs.readdirSync(args.dir, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    parts.push(`Directory listing of ${path.basename(path.resolve(args.dir))}:\n${names}`);
  }
  for (const f of args.files) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) failUsage(`file not found: ${f}`);
    const reason = sensitiveReason(p);
    if (reason && !args.allowSensitive) {
      console.error(`refusing to read ${f}: ${reason}. Pass --allow-sensitive to override.`);
      process.exit(2);
    }
    const stat = fs.statSync(p);
    if (stat.size > args.maxBytes) {
      failUsage(`file too large: ${f} (${stat.size} bytes > ${args.maxBytes}; use --max-bytes)`);
    }
    const buf = fs.readFileSync(p);
    if (buf.slice(0, 8192).includes(0)) {
      failUsage(`binary file refused: ${f}`);
    }
    const content = buf.toString("utf8");
    const lines = content.split(/\r?\n/);
    const capped = lines.slice(0, 2000);
    const numbered = capped.map((l, i) => `${i + 1}| ${l}`).join("\n");
    const suffix = lines.length > 2000 ? `\n... (${lines.length - 2000} more lines)` : "";
    parts.push(`File: ${path.basename(p)} (${lines.length} lines, ${stat.size} bytes)\n${numbered}${suffix}`);
  }
  if (!parts.length) {
    console.error("Nothing to analyze. Use --file, --dir, --text or --text-file (or pipe stdin).");
    process.exit(2);
  }
  return parts.join("\n\n");
}

function emit(args, payload) {
  if (args.json) console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.error) failUsage(parsed.error);
  const args = parsed.args;
  if (args.help) return usage();
  if (args.version) return console.log(`ask-jev v${VERSION}`);

  // Non-loopback --url requires explicit opt-in (state + token leave localhost).
  try {
    const u = new URL(args.url);
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\]|.*\.localhost)$/.test(u.hostname);
    if (!loopback && !args.allowRemote) {
      failUsage(`--url ${args.url} is not loopback. Pass --allow-remote if you really want to send this state (and your token) there.`);
    }
  } catch {
    failUsage(`--url is not a valid URL: ${args.url}`);
  }

  let piped = null;
  if (!args.text && !args.textFile && !args.files.length && !args.dir && !process.stdin.isTTY) {
    // When stdin is a pipe with no writer (spawned scripts, `node ask-jev ...`
    // without a redirect), reading it would block forever. End-of-stream data
    // events still fire for a closed pipe, so this resolves either way — but a
    // never-ending silent pipe must not hang us: race it against a short idle
    // timer and proceed without piped input if nothing arrives.
    const chunks = [];
    piped = await Promise.race([
      (async () => {
        for await (const chunk of process.stdin) chunks.push(chunk);
        return chunks.length ? Buffer.concat(chunks).toString("utf8").slice(0, 200_000) : null;
      })(),
      new Promise((resolve) => setTimeout(() => {
        try {
          process.stdin.destroy(); // unblocks the for-await below any pending data
        } catch {}
        resolve(chunks.length ? Buffer.concat(chunks).toString("utf8").slice(0, 200_000) : null);
      }, 250)),
    ]);
  }

  const rawState = readState(args, piped);
  const { map, type } = buildQuestion(args);

  let finalState = rawState;
  let findings = [];
  if (args.redact) {
    const r = redact(rawState);
    finalState = r.text;
    findings = r.findings;
    if (findings.length) {
      // Kinds and line numbers only — never any part of the value.
      const summary = findings.slice(0, 5).map((f) => `line ${f.line}: ${f.kind}`).join("; ");
      console.error(`⚠ masked ${findings.length} potential secret(s): ${summary}${findings.length > 5 ? "; …" : ""}`);
    }
  } else if (findings.length === 0) {
    console.error("⚠ --no-redact: content will be sent UNREDACTED to the bridge (and upstream).");
  }

  const started = Date.now();
  let data;
  try {
    const res = await bridgeFetch(`${args.url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      timeoutMs: args.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        model: "typesafe/jev-latest",
        messages: [{ role: "user", content: finalState }],
        questions: map,
      }),
    });
    data = await res.json();
    if (!res.ok) {
      console.error(`bridge error ${res.status}:`, JSON.stringify(data).slice(0, 400));
      process.exit(1);
    }
  } catch (e) {
    console.error("failed:", e.message);
    process.exit(1);
  }

  const ts = data.typesafe || {};
  const answers = ts.answers || {};
  let uncertain = false;
  const out = { question: args.q, type, answers: {}, findings: findings.length, raw: answers, elapsedMs: Date.now() - started };

  for (const [key, ans] of Object.entries(answers)) {
    const rec = { type: ans.type };
    if (ans.type === "noul") {
      rec.value = ans.noul;
      rec.verdict = ans.noul >= 0.5 ? "yes" : "no";
      rec.uncertain = ans.noul >= 0.35 && ans.noul <= 0.65;
      if (rec.uncertain) uncertain = true;
      if (!args.json) {
        console.log(`${args.q}: ${ans.noul}`);
        if (rec.uncertain) console.log("  -> uncertain (0.35-0.65) — gather more evidence or reframe");
        else console.log(`  -> ${rec.verdict.toUpperCase()} (confident)`);
      }
    } else if (ans.type === "choice") {
      rec.value = ans.choice;
      rec.confidence = ans.confidence;
      rec.probabilities = ans.probabilities || {};
      if (ans.confidence != null && ans.confidence < args.minConf) uncertain = true;
      if (!args.json) {
        console.log(`${args.q}: ${ans.choice}${ans.confidence != null ? ` (confidence ${ans.confidence})` : ""}`);
        if (uncertain) {
          console.log(`  !! low confidence (< ${args.minConf}) — probabilities:`);
          for (const [opt, p] of Object.entries(ans.probabilities || {})) console.log(`     ${opt}: ${p}`);
        }
      }
    } else if (ans.type === "score") {
      rec.value = ans.score;
      rec.confidence = ans.confidence;
      rec.legend = ans.legend || {};
      if (ans.confidence != null && ans.confidence < args.minConf) uncertain = true;
      if (!args.json) {
        console.log(`${args.q}: ${ans.score}${ans.confidence != null ? ` (confidence ${ans.confidence})` : ""}`);
        for (const [lvl, desc] of Object.entries(ans.legend || {})) console.log(`   ${lvl}: ${desc}`);
      }
    }
    out.answers[key] = rec;
  }
  if (args.json) return emit(args, out);
  if (ts.usage) console.log(`tokens: ${ts.usage.input_tokens} in / ${ts.usage.output_tokens} out`);
  process.exitCode = uncertain ? 3 : 0;
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
