#!/usr/bin/env node
/**
 * autofix.cjs — the Jev verdict → chat-model fix → Jev re-judge loop.
 *
 * Per flagged file:
 *   1. Judge the file with TypeSafe Jev (same questions as audit.cjs).
 *   2. If every verdict is inside thresholds → done, leave the file alone.
 *   3. Otherwise send Jev's specific findings + the file to a CHAT model
 *      (default: nvidia/deepseek-ai/deepseek-v4-flash via 9Router) and have it
 *      return the complete corrected file.
 *   4. Re-judge the fixed file. If the verdict did not improve (or the model
 *      returned something unusable), restore the backup.
 *   Repeat up to --max-runs per file (default 3) or until all verdicts pass.
 *
 * Safety:
 *   - DRY RUN by default: nothing is written unless --apply is given.
 *   - A one-time backup per run is kept next to the file (.bak-autofix).
 *   - .env / backups / huge files are never touched.
 *   - Model output must be a complete, fenced, changed file or it is rejected.
 *
 * Usage:
 *   node autofix.cjs                                  # show what would be fixed
 *   node autofix.cjs --apply                          # fix all flagged files
 *   node autofix.cjs --apply --max-runs 3 --min-score 2.5
 *   node autofix.cjs path/to/file.js --apply --fix-model nvidia/z-ai/glm-5.2
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BRIDGE_URL = process.env.TYPESAFE_BRIDGE_URL || "http://127.0.0.1:8399";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "sk-typesafe-bridge";
// The "fixer" side: any OpenAI-compatible chat endpoint. With 9Router running,
// the defaults below work as-is; otherwise set ROUTER_9_BASE_URL to e.g.
// "https://openrouter.ai/api" style base URL and ROUTER_9_API_KEY to a real key.
const ROUTER_URL = process.env.ROUTER_9_BASE_URL || "http://127.0.0.1:20128";
const DEFAULT_FIX_MODEL = process.env.AUTOFIX_MODEL || "bzl/claude-haiku-4.5";
// Tried in order when a model errors out.
// NOTE: never put a Jev-only combo here — Jev cannot generate text.
const FALLBACK_MODELS = [
  "bzl/claude-sonnet-4.6",
  "bzl/gpt-5.4",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "bzl/gemini-3-flash-preview",
];

const MAX_FILE_BYTES = 400_000;
const SKIP_FILES = new Set([".env", "bridge.log"]);
const SKIP_EXT = new Set([".bak-autofix"]);

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

// ---------------------------------------------------------------- helpers ---

function parseArgs(argv) {
  const args = {
    apply: false,
    maxRuns: 3,
    minScore: 2.5,
    fixModel: DEFAULT_FIX_MODEL,
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (a === "--min-score") args.minScore = Number(argv[++i]);
    else if (a === "--fix-model") args.fixModel = argv[++i];
    else if (!a.startsWith("--")) args.files.push(a);
  }
  return args;
}

function listTargets() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".venv", "node_modules", ".freebuff", ".git"].includes(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  })(__dirname);
  files.push(path.join(__dirname, "..", "CODEBUFF.md"));
  return files.filter((f) => {
    const base = path.basename(f);
    if (SKIP_FILES.has(base) || base.endsWith(".env")) return false; // secrets are never judged/sent
    if (SKIP_EXT.has(path.extname(f))) return false;
    if (base.endsWith(".bak-autofix")) return false;
    return fs.statSync(f).size < MAX_FILE_BYTES;
  });
}

function readState(file) {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const shown = lines.slice(0, 2000);
  const suffix = lines.length > 2000 ? `\n... (${lines.length - 2000} more lines)` : "";
  return {
    content,
    state: `File: ${file} (${lines.length} lines)\n${shown
      .map((l, i) => `${i + 1}| ${l}`)
      .join("\n")}${suffix}`,
  };
}

async function judge(file) {
  const ext = path.extname(file).toLowerCase();
  const isDoc = ext === ".md";
  const { state } = readState(file);
  const res = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    },
    body: JSON.stringify({
      model: "typesafe/jev-latest",
      messages: [{ role: "user", content: state }],
      questions: isDoc ? DOC_QUESTIONS : CODE_QUESTIONS,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 200));
  return {
    isDoc,
    answers: (data.typesafe && data.typesafe.answers) || {},
  };
}

function flagList(isDoc, answers, minScore) {
  const flags = [];
  if (!isDoc) {
    if ((answers.has_security_vulnerabilities?.noul ?? 0) > 0.6)
      flags.push({
        key: "has_security_vulnerabilities",
        detail: `noul=${fmt(answers.has_security_vulnerabilities.noul)} (needs ≤ 0.60)`,
        concern:
          "remove hardcoded credentials (read them from environment variables), avoid unsafe handling of untrusted input, close injection paths",
      });
    if ((answers.has_likely_bugs?.noul ?? 0) > 0.6)
      flags.push({
        key: "has_likely_bugs",
        detail: `noul=${fmt(answers.has_likely_bugs.noul)} (needs ≤ 0.60)`,
        concern:
          "fix likely bugs, unreachable logic, and broken references that would cause runtime failures",
      });
    if ((answers.robustness?.score ?? 4) < minScore)
      flags.push({
        key: "robustness",
        detail: `score=${fmt(answers.robustness.score)} (needs ≥ ${minScore})`,
        concern:
          "handle malformed input, network errors, and edge cases explicitly; fail loudly instead of corrupting state",
      });
    if ((answers.maintainability?.score ?? 4) < minScore)
      flags.push({
        key: "maintainability",
        detail: `score=${fmt(answers.maintainability.score)} (needs ≥ ${minScore})`,
        concern:
          "improve naming, structure, and add brief comments where the logic is non-obvious; keep public behavior unchanged",
      });
  } else {
    if ((answers.has_setup_gaps?.noul ?? 0) > 0.6)
      flags.push({
        key: "has_setup_gaps",
        detail: `noul=${fmt(answers.has_setup_gaps.noul)} (needs ≤ 0.60)`,
        concern:
          "add any missing setup steps, prerequisites, and configuration a new user would need",
      });
    if ((answers.is_internally_consistent?.noul ?? 1) < 0.4)
      flags.push({
        key: "is_internally_consistent",
        detail: `noul=${fmt(answers.is_internally_consistent.noul)} (needs ≥ 0.40)`,
        concern:
          "fix contradictions and stale references (file names, ports, commands) so everything matches",
      });
    if ((answers.clarity?.score ?? 4) < minScore)
      flags.push({
        key: "clarity",
        detail: `score=${fmt(answers.clarity.score)} (needs ≥ ${minScore})`,
        concern: "clarify ambiguous steps and fill gaps for the intended audience",
      });
  }
  return flags;
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(2) : "?";
}

/** Parse the first JSON object out of a possibly SSE-suffixed body. */
function firstJson(raw) {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no JSON in response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
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
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON in response");
}

function routerKey() {
  const key = process.env.ROUTER_9_API_KEY;
  if (!key) {
    throw new Error(
      "No fix-model key. Set ROUTER_9_API_KEY (and, if needed, ROUTER_9_BASE_URL) " +
        "to an OpenAI-compatible chat endpoint you can use as the fixer."
    );
  }
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askChatModelOnce(model, fixPrompt) {
  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a precise code-fixing assistant. Reply with the COMPLETE corrected file inside a single ``` fenced code block and nothing else. Never truncate the file. Never add or remove features; make only the edits required by the request.",
      },
      { role: "user", content: fixPrompt },
    ],
    stream: false,
    max_tokens: 8192,
  };
  // One retry with backoff — free tiers throttle per-minute.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(5000);
    const res = await fetch(`${ROUTER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${routerKey()}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    const data = firstJson(raw); // tolerant of SSE suffix
    if (data.error) {
      const msg = `fix model error: ${JSON.stringify(data.error).slice(0, 160)}`;
      if (/429|rate limit/i.test(msg) && attempt === 0) continue;
      throw new Error(msg);
    }
    return extractText(data);
  }
  throw new Error("unreachable");
}

/**
 * Try the chosen model, then fall back through FALLBACK_MODELS on errors.
 * `startOffset` rotates which model goes first, so successive fix runs in the
 * loop naturally try different models.
 */
async function askChatModel(model, fixPrompt, startOffset) {
  const chain = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  const off = ((startOffset || 0) % chain.length + chain.length) % chain.length;
  const rotated = chain.slice(off).concat(chain.slice(0, off));
  let lastErr = null;
  for (const m of rotated) {
    try {
      const text = await askChatModelOnce(m, fixPrompt);
      if (m !== model) console.log(`  (fell back to ${m})`);
      return text;
    } catch (e) {
      lastErr = e;
      console.log(`  (model ${m} failed: ${e.message.slice(0, 110)})`);
    }
  }
  throw lastErr;
}

function extractText(data) {
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    return (c.message && c.message.content) || (c.delta && c.delta.content) || "";
  }
  if (data.output) {
    for (const item of data.output) {
      for (const part of item.content || []) {
        if (part.type === "output_text") return part.text;
      }
    }
  }
  return "";
}

/** Pull the fenced code block; reject error pages / truncated output. */
function extractFenced(text, original) {
  const fenceStart = text.indexOf("```");
  if (fenceStart === -1) return null;
  let bodyStart = text.indexOf("\n", fenceStart);
  if (bodyStart === -1) return null;
  const closer = text.indexOf("\n```", bodyStart);
  if (closer === -1) return null; // truncated
  const body = text.slice(bodyStart + 1, closer).replace(/\r\n/g, "\n");
  if (body.length < 40) return null;
  if (body === original) return null; // model returned the file unchanged
  return body;
}

function buildFixPrompt(file, state, flags, attempt) {
  const lines = flags.map((f) => `  - ${f.key}: ${f.detail}\n    ${f.concern}`).join("\n");
  return [
    `File: ${file}`,
    attempt > 1
      ? `NOTE: a previous edit attempt was re-judged and still failed. Be more decisive about the security findings: for example, REMOVE hardcoded credentials entirely (load them from environment variables) rather than renaming them.`
      : "",
    "",
    `TypeSafe Jev (a typed decision model) flagged this file:`,
    lines,
    "",
    "Minimally edit the file to address exactly these findings.",
    "Keep behavior, public interfaces, and formatting style unchanged. No new dependencies.",
    "Return the COMPLETE corrected file in one ``` fenced code block.",
    "",
    "--- CURRENT FILE (numbers are line markers, do not keep them) ---",
    state,
  ].join("\n");
}

function backupFile(file) {
  const bak = `${file}.bak-autofix`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

// ------------------------------------------------------------------ main ---

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.files.length ? args.files.map((f) => path.resolve(f)) : listTargets();
  const dryPrefix = args.apply ? "" : "[dry-run] ";

  console.log(
    `autofix: ${targets.length} file(s), apply=${args.apply}, max-runs=${args.maxRuns}, ` +
      `min-score=${args.minScore}, fix-model=${args.fixModel}\n`
  );

  const summary = [];

  for (const file of targets) {
    const rel = path.relative(process.cwd(), file);
    if (!fs.existsSync(file) || fs.statSync(file).size >= MAX_FILE_BYTES) {
      console.log(`skip ${rel} (missing or too large)`);
      continue;
    }

    let verdict = await judge(file);
    let flags = flagList(verdict.isDoc, verdict.answers, args.minScore);
    console.log(`${rel}: ${flags.length ? flags.map((f) => `${f.key} ${f.detail}`).join(" | ") : "clean ✓"}`);
    if (!flags.length) {
      summary.push({ rel, result: "already-clean" });
      continue;
    }

    let runs = 0;
    let original = fs.readFileSync(file, "utf8");
    let current = original;

    while (flags.length && runs < args.maxRuns) {
      runs++;
      console.log(`  ${dryPrefix}fix run ${runs}/${args.maxRuns} via ${args.fixModel} …`);
      const { state } = readState(file);
      const prompt = buildFixPrompt(file, state, flags, runs);
      let fixed = null;
      try {
        const reply = await askChatModel(args.fixModel, prompt, runs - 1);
        fixed = extractFenced(reply, current);
      } catch (e) {
        console.log(`  ✗ fix model failed: ${e.message.slice(0, 160)}`);
      }
      if (fixed === null) {
        console.log("  ✗ unusable model output (missing fence, unchanged, or truncated) — stopping this file");
        break;
      }
      if (!args.apply) {
        console.log(`  [dry-run] would write ${fixed.split("\n").length} lines, then re-judge`);
        break;
      }
      const bak = backupFile(file);
      fs.writeFileSync(file, fixed.endsWith("\n") ? fixed : fixed + "\n");
      const re = await judge(file);
      const reFlags = flagList(re.isDoc, re.answers, args.minScore);
      if (reFlags.length < flags.length) {
        console.log(
          `  ✓ accepted: flags ${flags.length} → ${reFlags.length}` +
            (reFlags.length ? ` (${reFlags.map((f) => f.key).join(", ")})` : " — all clear")
        );
        verdict = re;
        flags = reFlags;
        current = fs.readFileSync(file, "utf8");
      } else {
        console.log("  ✗ no improvement — restoring backup, trying next model if runs remain");
        fs.writeFileSync(file, current);
        void bak;
        // Loop continues: the next run rotates to a different fix model.
      }
    }

    summary.push({ rel, result: flags.length ? `still-flagged: ${flags.map((f) => f.key).join(",")}` : `fixed (${runs} run(s))` });
  }

  console.log("\n===== SUMMARY =====");
  for (const s of summary) console.log(`${s.rel}: ${s.result}`);
  if (!args.apply) console.log("\nThis was a dry run. Re-run with --apply to write fixes.");
}

main().catch((e) => {
  console.error("autofix failed:", e);
  process.exit(1);
});
