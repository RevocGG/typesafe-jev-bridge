"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { KEY_HINT_RE, keyHardProblem, keyHint } = require("../lib/env.cjs");

test("dashboard apikey_ format matches the hint and produces no hint text", () => {
  const key = "apikey_2112fakeAbCdEfGhIjKlMnOp";
  assert.ok(KEY_HINT_RE.test(key));
  assert.strictEqual(keyHint(key), null);
  assert.strictEqual(keyHardProblem(key), null);
});

test("legacy ts_live_/ts_test_ formats are accepted silently", () => {
  for (const key of ["ts_live_abcdefghijklmnop", "ts_test_abcdefghijklmnop"]) {
    assert.ok(KEY_HINT_RE.test(key));
    assert.strictEqual(keyHint(key), null);
    assert.strictEqual(keyHardProblem(key), null);
  }
});

test("unusual prefixes are only an informational hint, never a hard error", () => {
  const key = "sk_live_abcdefghijklmnopqrstuv";
  assert.ok(!KEY_HINT_RE.test(key));
  const hint = keyHint(key);
  assert.ok(typeof hint === "string" && hint.length > 0, "expected a hint");
  assert.strictEqual(keyHardProblem(key), null, "hint must not become a hard error");
});

test("hard errors: empty, whitespace/quotes, too short", () => {
  assert.match(keyHardProblem(""), /empty/);
  assert.match(keyHardProblem("   "), /empty/);
  assert.match(keyHardProblem("apikey_abc defghijklmno"), /whitespace or quotes/);
  assert.match(keyHardProblem('"apikey_abcdef12345678"'), /whitespace or quotes/);
  assert.match(keyHardProblem("'apikey_abcdef12345678'"), /whitespace or quotes/);
  assert.match(keyHardProblem("apikey_123"), /too short/);
  assert.match(keyHardProblem("short"), /too short/);
  assert.strictEqual(keyHardProblem(null), "key is empty");
});

test("keys with dashes and underscores in the body are accepted", () => {
  assert.ok(KEY_HINT_RE.test("apikey_ABC-DEF_1234567890"));
  assert.ok(KEY_HINT_RE.test("ts_live_ABC-DEF_1234567890"));
});
