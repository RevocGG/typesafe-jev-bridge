"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { extractFenced, normalize } = require("../lib/fence.cjs");

const ORIGINAL = "# Title\n\n```js\nconsole.log(1);\n```\n\nSome text.\n";

test("regression: nested fences no longer truncate at the first inner fence", () => {
  // The old code cut at the FIRST closing ``` inside the body, turning a 260
  // char markdown doc into 99 chars and still accepting it. The body here is
  // also a real CHANGE of the original (same shape, one word different), so
  // the unchanged-check does not legitimately reject it.
  const changed = ORIGINAL.replace("Some text.", "Some changed text.");
  const reply = "Here is the file:\n\n````markdown\n" + changed + "\n````\nHope that helps!";
  const out = extractFenced(reply, ORIGINAL, { originalLineCount: ORIGINAL.split("\n").length });
  assert.ok(out, "should extract");
  assert.ok(out.includes("console.log(1);"));
  assert.ok(out.includes("Some changed text."));
  assert.strictEqual(normalize(out), normalize(changed));
});

test("uses the LAST three-backtick block when several exist", () => {
  const reply = [
    "```\nfirst block of alpha beta gamma delta\n```",
    "prose",
    "```js\nsecond block of the quick brown fox jumps\n```",
  ].join("\n");
  const out = extractFenced(reply, "different original", {});
  assert.ok(out);
  assert.ok(out.includes("second block"));
  assert.ok(!out.includes("first block"));
});

test("tolerates prose before and after the block", () => {
  const reply = `Sure!\n\n\`\`\`\nalpha beta gamma\nbeta gamma epsilon\nmore text follows here to pass the minimum\n\`\`\`\n\nDone.`;
  const out = extractFenced(reply, "old", {});
  assert.ok(out, "should extract");
  assert.ok(out.includes("alpha"));
  assert.ok(out.includes("beta"));
});

test("truncated output is rejected", () => {
  const reply = "```\nstart of a body but never closed...";
  assert.strictEqual(extractFenced(reply, "old", {}), null);
});

test("unchanged output is rejected after normalization (regression)", () => {
  // The old check compared raw strings: model output had no trailing newline
  // while the original did, so "unchanged" was never detected.
  const reply = "```\n" + ORIGINAL.replace(/\n$/, "") + "\n```";
  assert.strictEqual(extractFenced(reply, ORIGINAL, {}), null);
  const crlfOriginal = ORIGINAL.replace(/\n/g, "\r\n");
  assert.strictEqual(extractFenced("```\n" + crlfOriginal + "\n```", crlfOriginal, {}), null);
});

test("line-number echo detection: >5% N| prefixes are rejected", () => {
  const echoed = "1| # Title\n2| text\n3| more\n4| lines\n5| here\n6| ok";
  assert.strictEqual(extractFenced("```\n" + echoed + "\n```", "different", {}), null);
});

test("size sanity: <60% or >200% of the original line count is rejected", () => {
  const big = Array.from({ length: 100 }, (_, i) => `line number ${i} is here`).join("\n");
  const small = "one line";
  assert.strictEqual(extractFenced("```\none line\n```", big, { originalLineCount: 101 }), null);
  assert.strictEqual(extractFenced("```\n" + big + "\n```", small, { originalLineCount: 1 }), null);
  const bigChanged = big + "\nextra final line of the fixed file";
  assert.ok(extractFenced("```\n" + bigChanged + "\n```", big, { originalLineCount: 101 }));
  // --force bypasses the size check but the one-line body still fails the
  // 40-char minimum-length rule, so use a long single line here.
  const longOneLiner = "x".repeat(120);
  assert.ok(extractFenced("```\n" + longOneLiner + "\n```", big, { originalLineCount: 101, force: true }), "--force bypasses");
});
