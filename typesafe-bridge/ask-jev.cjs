#!/usr/bin/env node
/**
 * ask-jev — ask TypeSafe Jev typed questions (noul/choice/score) about files
 * or any text, through the local bridge (or directly via 9Router's combo).
 *
 * Examples:
 *   node ask-jev.mjs --file src/index.ts --q "Does this file have security issues?" \
 *     --criteria "No issues,Serious issues"
 *
 *   node ask-jev.mjs --text "Server is on fire, customers leaving" \
 *     --q "Is this urgent?" --type noul
 *
 *   node ask-jev.mjs --file big.ts --q "Which category?" \
 *     --choice "auth=Authentication logic,routes=HTTP routes,utils=Helpers"
 *
 *   echo "some chat log" | node ask-jev.mjs --q "Is the customer angry?" \
 *     --type score --criteria "Calm,Frustrated,Very angry"
 *
 * Flags:
 *   --file <path...>    one or more files (with line numbers, capped) as state
 *   --dir  <path>       list a directory's files (names only) as state
 *   --text <string>     raw text as state
 *   --q <string>        question (required)
 *   --type noul|choice|score   (default: inferred — yes/no → noul, options → choice)
 *   --criteria a,b,c    score levels or choice options (key=value for named options)
 *   --min-conf 0.6      warn when confidence is below this (default 0.55)
 *   --redact            mask values that look like secrets before sending (on by default; --no-redact to disable)
 *   --url <url>         bridge URL (default http://127.0.0.1:8399)
 */

"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    files: [],
    dir: null,
    text: null,
    q: null,
    type: null,
    criteria: null,
    minConf: 0.55,
    redact: true, // mask secret-like values by default; --no-redact to disable
    url: process.env.TYPESAFE_BRIDGE_URL || "http://127.0.0.1:8399",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      let v;
      while ((v = argv[++i]) && !v.startsWith("--")) args.files.push(v);
      i--;
    } else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--text") args.text = argv[++i];
    else if (a === "--q") args.q = argv[++i];
    else if (a === "--type") args.type = argv[++i];
    else if (a === "--criteria") args.criteria = argv[++i];
    else if (a === "--min-conf") args.minConf = Number(argv[++i]);
    else if (a === "--redact") args.redact = true;
    else if (a === "--no-redact") args.redact = false;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(fs.readFileSync(__filename, "utf8").split("/**")[1]
    .split("*/")[0].replace(/^\s*\*/, "").trim());
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|ts|nvapi|ghp|github_pat|xoxb|xoxp)-[A-Za-z0-9_\-]{16,}\b/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
];

function scanSecrets(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (SECRET_PATTERNS.some((re) => re.test(line))) {
      hits.push({ line: i + 1, text: line.trim().slice(0, 80) });
    }
  });
  return hits;
}

function redactSecrets(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), (m) => m.slice(0, 4) + "…[REDACTED]");
  }
  return out;
}

function readState(args, piped) {
  const parts = [];
  if (piped) parts.push(`Piped input:\n${piped}`);
  if (args.text) parts.push(args.text);
  if (args.dir) {
    const entries = fs.readdirSync(args.dir, { withFileTypes: true });
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    parts.push(`Directory listing of ${path.resolve(args.dir)}:\n${names}`);
  }
  for (const f of args.files || []) {
    const p = path.resolve(f);
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf8");
    const lines = content.split(/\r?\n/);
    const capped = lines.slice(0, 2000);
    const numbered = capped.map((l, i) => `${i + 1}| ${l}`).join("\n");
    const suffix = lines.length > 2000 ? `\n... (${lines.length - 2000} more lines)` : "";
    parts.push(`File: ${p} (${lines.length} lines, ${stat.size} bytes)\n${numbered}${suffix}`);
    if (capped.length > 500) {
      parts.push(
        `Note: ${p} is large (${lines.length} lines); you are seeing the first 2000.`
      );
    }
  }
  if (!parts.length) {
    console.error("Nothing to analyze. Use --file, --dir or --text (or pipe stdin).");
    process.exit(2);
  }
  return parts.join("\n\n");
}

function buildQuestion(args) {
  const q = args.q;
  if (!q) {
    console.error("--q is required");
    process.exit(2);
  }
  const type = args.type || (args.criteria ? "score" : "noul");
  if (type === "noul") return { [q]: { type: "noul", instructions: q } };

  const items = (args.criteria || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) {
    console.error(`--type ${type} requires --criteria`);
    process.exit(2);
  }
  if (type === "score") {
    return { [q]: { type: "score", instructions: q, criteria: items } };
  }
  // choice: "key=description" or plain labels
  const criteria = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq > 0) criteria[item.slice(0, eq)] = item.slice(eq + 1);
    else criteria[item] = item;
  }
  return { [q]: { type: "choice", instructions: q, criteria } };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  // Read piped stdin (if any) before building the state
  let piped = null;
  if (!args.text && !args.files.length && !args.dir && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    if (chunks.length) {
      piped = Buffer.concat(chunks).toString("utf8").slice(0, 200000);
    }
  }

  const state = readState(args, piped);
  const questions = buildQuestion(args);

  // Secrets never leave the machine by default: they are masked before the
  // state is sent to the TypeSafe API. Use --no-redact to send as-is.
  const secretHits = scanSecrets(state);
  if (secretHits.length) {
    // Preview lines are masked too, so the warning itself never leaks values.
    const preview = secretHits
      .slice(0, 5)
      .map((h) => `  line ${h.line}: ${redactSecrets(h.text)}`)
      .join("\n");
    if (args.redact) {
      console.error(`⚠ masked ${secretHits.length} potential secret(s) (--redact):\n${preview}`);
    }
  }
  const finalState = args.redact && secretHits.length ? redactSecrets(state) : state;

  const res = await fetch(`${args.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BRIDGE_TOKEN || "sk-typesafe-bridge"}`,
    },
    body: JSON.stringify({
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: finalState }],
      questions,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`bridge error ${res.status}:`, JSON.stringify(data).slice(0, 400));
    process.exit(1);
  }

  const ts = data.typesafe || {};
  const answers = ts.answers || {};
  for (const [key, ans] of Object.entries(answers)) {
    if (ans.type === "noul") {
      console.log(`${key}: ${ans.noul}`);
      if (ans.noul < 0.35 || ans.noul > 0.65)
        console.log(`  -> ${ans.noul >= 0.5 ? "YES" : "NO"} (confident)`);
      else console.log("  -> uncertain (ask differently or add criteria)");
    } else if (ans.type === "choice") {
      console.log(`${key}: ${ans.choice}${ans.confidence != null ? ` (confidence ${ans.confidence})` : ""}`);
      if (ans.confidence != null && ans.confidence < args.minConf) {
        console.log(`  !! low confidence (< ${args.minConf}) — check probabilities:`);
        for (const [opt, p] of Object.entries(ans.probabilities || {}))
          console.log(`     ${opt}: ${p}`);
        process.exitCode = 3;
      }
    } else if (ans.type === "score") {
      console.log(`${key}: ${ans.score}${ans.confidence != null ? ` (confidence ${ans.confidence})` : ""}`);
      for (const [lvl, desc] of Object.entries(ans.legend || {}))
        console.log(`   ${lvl}: ${desc}`);
    }
  }
  if (ts.usage) console.log(`tokens: ${ts.usage.input_tokens} in / ${ts.usage.output_tokens} out`);
}

main().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
