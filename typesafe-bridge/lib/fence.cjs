"use strict";
/**
 * lib/fence.cjs — extract a complete fenced code block from a model reply.
 *
 * Hardened against the failure modes seen in practice:
 *   - nested ``` fences inside a Markdown answer  → prefer a 4-backtick
 *     wrapper and otherwise use the LAST closing fence, never the first;
 *   - prose before/after the block                → tolerated;
 *   - model returned the file unchanged           → detected after
 *     normalizing trailing whitespace / EOL style;
 *   - model echoed the `N| ` line-number prefixes → detected via ratio;
 *   - truncation                                  → no closer found.
 */

const LF = "\n";

function normalize(text) {
  return String(text == null ? "" : text)
    .replace(/\r\n/g, LF)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/g, LF)
    .trimEnd();
}

function countLinePrefixes(text) {
  const lines = normalize(text).split(LF);
  if (!lines.length) return 0;
  return lines.filter((l) => /^\d+\| /.test(l)).length;
}

/**
 * Extract the first N| line-number marker from the original state, so callers
 * can verify the model actually removed them.
 */
function originalPrefixRatio(original) {
  const lines = normalize(original).split(LF);
  if (!lines.length) return 0;
  return lines.filter((l) => /^\d+\| /.test(l)).length / lines.length;
}

/**
 * @param {string} reply    full model reply
 * @param {string} original current file content (for the unchanged check)
 * @param {object} [opts]
 * @param {number} [opts.originalLineCount] line count of the original file
 * @returns {string|null} the extracted file body, or null when unusable
 */
function extractFenced(reply, original, opts = {}) {
  const text = String(reply == null ? "" : reply);

  // Prefer an explicit four-backtick wrapper (asked for in the fix prompt):
  //   ````\n<body>\n````
  const q4 = /````[^\n]*\n([\s\S]*?)\n````/.exec(text);
  if (q4 && q4[1].trim().length >= 40) {
    return accept(q4[1], original, opts);
  }

  // Fall back to three-backtick blocks, scanning ALL of them and using the
  // LAST valid (closed) pair — the first inner ``` of a nested block must not
  // truncate the result.
  const openers = [];
  const re = /^(`{3,})([^\n]*)\n([\s\S]*?)(?:\n\1[ \t]*(?=\n|$))/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    openers.push({
      body: m[3],
      end: m.index + m[0].length,
    });
  }
  // Also accept a block that runs to end-of-text only when a closing fence
  // exists somewhere after it (i.e. proper close, possibly with prose after).
  if (openers.length) {
    const best = openers[openers.length - 1];
    return accept(best.body, original, opts);
  }

  // Legacy shape: first ``` … first later \n``` (kept for back-compat).
  const fenceStart = text.indexOf("```");
  if (fenceStart === -1) return null;
  const bodyStart = text.indexOf(LF, fenceStart);
  if (bodyStart === -1) return null;
  const closer = text.indexOf(LF + "```", bodyStart);
  if (closer === -1) return null; // truncated
  return accept(text.slice(bodyStart + 1, closer), original, opts);
}

function accept(body, original, opts) {
  const cleaned = body.replace(/\r\n/g, LF);
  if (cleaned.length < 40) return null;

  // Unchanged check after normalizing EOL + trailing whitespace (the model
  // never reproduces the exact trailing newline of the original).
  if (original != null && normalize(cleaned) === normalize(original)) return null;

  // Line-number prefixes: the prompt asks the model to strip the `N| ` markers
  // we add. Reject output that still carries too many of them (> 5%).
  const lines = cleaned.split(LF);
  const prefixed = countLinePrefixes(cleaned);
  if (lines.length && prefixed / lines.length > 0.05) return null;

  // Sanity limits vs the original size (unless overridden by --force).
  if (opts.originalLineCount && !opts.force) {
    const ratio = lines.length / opts.originalLineCount;
    if (ratio < 0.6 || ratio > 2.0) return null;
  }
  return cleaned;
}

module.exports = { extractFenced, normalize, countLinePrefixes };
