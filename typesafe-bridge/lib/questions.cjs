"use strict";
/**
 * lib/questions.cjs — the single source of the Jev question sets and the
 * verdict thresholds used by audit.cjs and autofix.cjs.
 *
 * Thresholds were previously inconsistent between the two tools (audit:
 * >= 0.6 / <= 0.4 with min-score 0; autofix: > 0.6 / < 0.4 with 2.5).
 * Unified: noul flags at >= 0.60, consistency requires >= 0.40, and the
 * default min-score is 2.5. All overridable by CLI flags (see each tool).
 */

const THRESHOLDS = {
  /** noul at or above this means "the problem is present" */
  FLAG_NOUL: 0.6,
  /** consistency noul must be at or above this */
  CONSISTENT_NOUL: 0.4,
  /** default minimum score for robustness / maintainability / clarity */
  MIN_SCORE: 2.5,
};

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
      "Clear structure, minor readability gaps",
      "Excellent: unambiguous, complete, well organized",
    ],
  },
};

const SCORE_KEYS = ["robustness", "maintainability", "clarity"];

module.exports = { CODE_QUESTIONS, DOC_QUESTIONS, THRESHOLDS, SCORE_KEYS };
