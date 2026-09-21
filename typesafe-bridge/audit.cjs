#!/usr/bin/env node
/**
 * audit.cjs — ask TypeSafe Jev to judge a project's files.
 *
 * Sends one request per file with several typed questions sharing the same
 * state (the parallel-questions pattern from the TypeSafe skill):
 *   code files → security (noul), bugs (noul), robustness (score), maintainability (score)
 *   markdown   → setup gaps (noul), internal consistency (noul), clarity (score)
 *
 * Usage:
 *   node audit.cjs                       # audit the whole repo (default)
 *   node audit.cjs file1.js file2.md     # audit specific files
 *   node audit.cjs --min-score 3 --fail-on flagged
 *   node audit.cjs --json
 *
 * Exit codes (with --fail-on):
 *   0 ok · 1 at least one file flagged (flagged) / errored (error) · 2 usage
 *
 * Privacy: secret-like values are redacted before sending; .env / key files
 * are never read at all (see lib/sensitive.cjs).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { CODE_QUESTIONS, DOC_QUESTIONS, THRESHOLDS, SCORE_KEYS } = require("./lib/questions.cjs");
const { listTargets, readState, fmt } = require("./lib/targets.cjs");
const { sensitiveReason, assertInsideRoot } = require("./lib/sensitive.cjs");
const { redact } = require("./lib/redact.cjs");
const { bridgeFetch } = require("./lib/client.cjs");

const VERSION = (() => {
  try {
    return require("../package.json").version;
  } catch {
    return "0.0.0";
  }
})();

const ROOT = path.join(__dirname, "..");

function usage() {
  console.log(`audit v${VERSION} — Jev judges a project's files.

USAGE
  node audit.cjs [files...] [options]

OPTIONS
  --min-score <n>        minimum score for robustness/maintainability/clarity [default: ${THRESHOLDS.MIN_SCORE}]
  --max-noul <n>         flag threshold for problem-nouls [default: ${THRESHOLDS.FLAG_NOUL}]
  --min-noul-consistent <n>  minimum consistency noul [default: ${THRESHOLDS.CONSISTENT_NOUL}]
  --fail-on <mode>       never | flagged | error   [default: never]  (exit 1 when met; CI use)
  --concurrency <n>      parallel requests [default: 3, max 8]
  --json                 machine-readable JSON output
  --no-redact            send file content unredacted (not recommended)
  --allow-sensitive      allow explicitly-passed sensitive files (not recommended)
  --help                 this help

EXIT CODES
  0 ok  ·  1 --fail-on condition met  ·  2 usage error`);
}

function parseArgs(argv) {
  const args = {
    minScore: THRESHOLDS.MIN_SCORE,
    maxNoul: THRESHOLDS.FLAG_NOUL,
    minConsistent: THRESHOLDS.CONSISTENT_NOUL,
    failOn: "never",
    concurrency: 3,
    json: false,
    redact: true,
    allowSensitive: false,
    files: [],
    help: false,
    version: false,
  };
  const valued = new Set([
    "--min-score", "--max-noul", "--min-noul-consistent", "--fail-on", "--concurrency",
  ]);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} requires a value` };
      if (a === "--min-score") args.minScore = Number(v);
      else if (a === "--max-noul") args.maxNoul = Number(v);
      else if (a === "--min-noul-consistent") args.minConsistent = Number(v);
      else if (a === "--concurrency") args.concurrency = Number(v);
      else if (a === "--fail-on") args.failOn = v;
    } else if (a === "--json") args.json = true;
    else if (a === "--no-redact") args.redact = false;
    else if (a === "--allow-sensitive") args.allowSensitive = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--") continue;
    else if (a.startsWith("--")) return { error: `unknown flag "${a}"` };
    else args.files.push(a);
  }
  return { args };
}

function resolveTargets(args) {
  if (args.files.length) {
    const out = [];
    for (const f of args.files) {
      const abs = path.resolve(ROOT, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`file not found: ${f}`);
      }
      const reason = sensitiveReason(abs);
      if (reason && !args.allowSensitive) {
        throw new Error(`refusing to read ${f}: ${reason} (use --allow-sensitive to override)`);
      }
      assertInsideRoot(abs, ROOT);
      out.push(abs);
    }
    return out;
  }
  // Default: the whole repo, plus any root-level markdown docs that exist.
  const targets = listTargets(ROOT);
  for (const doc of ["README.md", "AGENTS.md", "GUIDE.md", "CHANGELOG.md", "SECURITY.md"]) {
    const p = path.join(ROOT, doc);
    if (fs.existsSync(p)) targets.push(p);
  }
  return [...new Set(targets)].sort();
}

function questionsFor(file) {
  return path.extname(file).toLowerCase() === ".md" ? DOC_QUESTIONS : CODE_QUESTIONS;
}

async function judge(file, args) {
  const { state, relPath, truncated } = readState(file, { root: ROOT });
  const finalState = args.redact ? redact(state).text : state;
  const token = process.env.BRIDGE_TOKEN || "sk-typesafe-bridge";
  const url = (process.env.TYPESAFE_BRIDGE_URL || "http://127.0.0.1:8399").replace(/\/+$/, "");
  const res = await bridgeFetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: finalState }],
      questions: questionsFor(file),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return { answers: (data.typesafe && data.typesafe.answers) || {}, truncated };
}

/** Compute flag keys for one file's answers against the (unified) thresholds. */
function flagList(isDoc, answers, args) {
  const flags = [];
  if (!isDoc) {
    if ((answers.has_security_vulnerabilities?.noul ?? 0) >= args.maxNoul) flags.push("SECURITY");
    if ((answers.has_likely_bugs?.noul ?? 0) >= args.maxNoul) flags.push("BUGS");
  } else {
    if ((answers.has_setup_gaps?.noul ?? 0) >= args.maxNoul) flags.push("GAPS");
    if ((answers.is_internally_consistent?.noul ?? 1) < args.minConsistent) flags.push("INCONSISTENT");
  }
  for (const key of SCORE_KEYS) {
    const a = answers[key];
    if (a && typeof a.score === "number" && a.score < args.minScore) flags.push(`LOW:${key}=${fmt(a.score)}`);
  }
  return flags;
}

function oneLine(isDoc, answers) {
  if (isDoc) {
    return `setup_gaps=${fmt(answers.has_setup_gaps?.noul)} consistent=${fmt(answers.is_internally_consistent?.noul)} clarity=${fmt(answers.clarity?.score)}`;
  }
  return `security=${fmt(answers.has_security_vulnerabilities?.noul)} bugs=${fmt(answers.has_likely_bugs?.noul)} robustness=${fmt(answers.robustness?.score)} maintainability=${fmt(answers.maintainability?.score)}`;
}

async function pool(items, n, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.error) {
    console.error(`usage error: ${parsed.error} (see --help)`);
    process.exit(2);
  }
  const args = parsed.args;
  if (args.help) return usage();
  if (args.version) return console.log(`audit v${VERSION}`);

  if (!["never", "flagged", "error"].includes(args.failOn)) {
    console.error("usage error: --fail-on must be never|flagged|error");
    process.exit(2);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    console.error("usage error: --concurrency must be 1..8");
    process.exit(2);
  }
  for (const [name, v] of [["--min-score", args.minScore], ["--max-noul", args.maxNoul], ["--min-noul-consistent", args.minConsistent]]) {
    if (!Number.isFinite(v)) {
      console.error(`usage error: ${name} must be a number`);
      process.exit(2);
    }
  }

  let targets;
  try {
    targets = resolveTargets(args);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const rows = [];
  let lock = Promise.resolve();
  let printCursor = 0;
  const progress = (rel, text) => {
    // Interleave-safe progress output for concurrent runs.
    rows[printCursor] = rows[printCursor] || {};
    console.log(`judging ${rel} … ${text}`);
  };

  await pool(targets, args.concurrency, async (file) => {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const isDoc = path.extname(file).toLowerCase() === ".md";
    const row = { file: rel, isDoc, answers: null, error: null, flags: [] };
    try {
      const { answers } = await judge(file, args);
      row.answers = answers;
      row.flags = flagList(isDoc, answers, args);
      if (!args.json) console.log(`${rel}: ${oneLine(isDoc, answers)}${row.flags.length ? "  ⚠ " + row.flags.join(", ") : ""}`);
    } catch (e) {
      row.error = e.message.slice(0, 200);
      if (!args.json) console.log(`${rel}: FAILED — ${row.error}`);
    }
    rows.push(row);
    void lock; void progress; void printCursor;
  });

  const ordered = rows.sort((a, b) => a.file.localeCompare(b.file));
  let anyFlagged = false;
  let anyError = false;

  if (args.json) {
    console.log(JSON.stringify({ files: ordered }, null, 2));
  } else {
    console.log("\n===== VERDICTS =====");
    for (const { file, flags, error } of ordered) {
      if (error) {
        anyError = true;
        console.log(`✗ ${file} (error: ${error})`);
      } else if (flags.length) {
        anyFlagged = true;
        console.log(`⚠ ${file} → ${flags.join(", ")}`);
      } else {
        console.log(`✓ ${file}`);
      }
    }
  }

  if (args.failOn === "flagged" && anyFlagged) process.exit(1);
  if (args.failOn === "error" && (anyError || anyFlagged)) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("audit failed:", e.message);
  process.exit(1);
});
