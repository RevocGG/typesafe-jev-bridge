#!/usr/bin/env node
/**
 * audit.cjs — ask TypeSafe Jev to judge this project's files.
 *
 * Sends one request per file with several typed questions sharing the same
 * state (the parallel-questions pattern from the TypeSafe skill):
 *   code files → security (noul), bugs (noul), robustness (noul), maintainability (score)
 *   markdown   → setup clarity (noul), completeness (noul), accuracy (noul)
 *
 * Usage:  node audit.cjs [file1 file2 ...]   (defaults to the project files)
 *         node audit.cjs --min-score 2.5     (only report files below threshold)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BRIDGE_URL =
  process.env.TYPESAFE_BRIDGE_URL || "http://127.0.0.1:8399";
const TOKEN = process.env.BRIDGE_TOKEN || "sk-typesafe-bridge";
const MAX_LINES = 2000;

const CODE_QUESTIONS = {
  has_security_vulnerabilities: {
    type: "noul",
    instructions:
      "Does this code contain concrete security vulnerabilities such as credential leakage, command injection, or unsafe handling of untrusted input?",
  },
  has_likely_bugs: {
    type: "noul",
    instructions:
      "Does this code contain likely bugs, unreachable logic, or broken references that would cause runtime failures?",
  },
  robustness: {
    type: "score",
    instructions:
      "How robust is this code against malformed input, network errors, and edge cases? Higher means more robust.",
    criteria: [
      "Fragile: crashes or corrupts state on common error paths",
      "Handles some errors but has significant gaps",
      "Generally solid with only minor gaps",
      "Defensive and thorough across error paths",
    ],
  },
  maintainability: {
    type: "score",
    instructions:
      "How maintainable is this file: clarity, naming, structure, and ease of safe modification? Higher means more maintainable.",
    criteria: [
      "Hard to modify safely: tangled, opaque, undocumented",
      "Understandable but brittle or poorly organized",
      "Clear structure, minor readability gaps",
      "Exemplary: obvious, well-factored, low risk to change",
    ],
  },
};

const DOC_QUESTIONS = {
  has_setup_gaps: {
    type: "noul",
    instructions:
      "Does this documentation miss steps or prerequisites a new user would need to run or use what it describes?",
  },
  is_internally_consistent: {
    type: "noul",
    instructions:
      "Are all commands, file names, ports, and references inside this document consistent with each other (no contradictions or stale references)?",
  },
  clarity: {
    type: "score",
    instructions:
      "How clear and complete is this document for its intended audience? Higher means clearer.",
    criteria: [
      "Confusing: missing context, ambiguous steps",
      "Understandable with effort; notable gaps",
      "Clear with minor gaps",
      "Excellent: unambiguous, complete, well organized",
    ],
  },
};

function listTargets() {
  const root = path.join(__dirname, "..");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".venv" || entry.name === "node_modules" || entry.name === ".freebuff") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      // Secrets are never judged — their content would be sent to the API.
      else if (!entry.name.endsWith(".env") && !entry.name.endsWith(".log")) files.push(p);
    }
  })(__dirname);
  files.push(path.join(root, "CODEBUFF.md"));
  return files.filter((f) => fs.statSync(f).size < 400_000);
}

function readState(file) {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const shown = lines.slice(0, MAX_LINES);
  const suffix = lines.length > MAX_LINES ? `\n... (${lines.length - MAX_LINES} more lines)` : "";
  const numbered = shown.map((l, i) => `${i + 1}| ${l}`).join("\n");
  return `File: ${file} (${lines.length} lines)\n${numbered}${suffix}`;
}

async function judge(file) {
  const ext = path.extname(file).toLowerCase();
  const isDoc = ext === ".md";
  const questions = isDoc ? DOC_QUESTIONS : CODE_QUESTIONS;
  const res = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: readState(file) }],
      questions,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return (data.typesafe && data.typesafe.answers) || {};
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(2) : String(n);
}

async function main() {
  const args = process.argv.slice(2);
  const minScoreIdx = args.indexOf("--min-score");
  const minScore = minScoreIdx !== -1 ? Number(args[minScoreIdx + 1]) : 0;

  const targets = args.length && !args[0].startsWith("--")
    ? args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min-score")
    : listTargets();

  const rows = [];
  for (const file of targets) {
    const rel = path.relative(process.cwd(), file);
    process.stdout.write(`judging ${rel} … `);
    try {
      const answers = await judge(file);
      const rec = { file: rel, answers };
      rows.push(rec);
      if (path.extname(file).toLowerCase() === ".md") {
        const gaps = answers.has_setup_gaps;
        const cons = answers.is_internally_consistent;
        const clarity = answers.clarity;
        console.log(
          `setup_gaps=${gaps ? fmt(gaps.noul) : "?"} consistent=${cons ? fmt(cons.noul) : "?"} clarity=${clarity ? fmt(clarity.score) : "?"}`
        );
      } else {
        const sec = answers.has_security_vulnerabilities;
        const bugs = answers.has_likely_bugs;
        const maint = answers.maintainability;
        console.log(
          `security=${sec ? fmt(sec.noul) : "?"} bugs=${bugs ? fmt(bugs.noul) : "?"} maintainability=${maint ? fmt(maint.score) : "?"}`
        );
      }
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  console.log("\n===== VERDICTS =====");
  for (const { file, answers } of rows) {
    const flags = [];
    if (answers.has_security_vulnerabilities && answers.has_security_vulnerabilities.noul >= 0.6)
      flags.push("SECURITY");
    if (answers.has_likely_bugs && answers.has_likely_bugs.noul >= 0.6) flags.push("BUGS");
    if (answers.has_setup_gaps && answers.has_setup_gaps.noul >= 0.6) flags.push("GAPS");
    if (answers.is_internally_consistent && answers.is_internally_consistent.noul <= 0.4)
      flags.push("INCONSISTENT");
    for (const key of ["robustness", "maintainability", "clarity"]) {
      const a = answers[key];
      if (a && typeof a.score === "number" && a.score < minScore) flags.push(`LOW:${key}=${fmt(a.score)}`);
    }
    console.log(`${flags.length ? "⚠ " : "✓ "}${file}${flags.length ? " → " + flags.join(", ") : ""}`);
  }
}

main().catch((e) => {
  console.error("audit failed:", e.message);
  process.exit(1);
});
