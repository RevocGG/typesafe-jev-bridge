"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { redact, scan } = require("../lib/redact.cjs");

test("redacts upper and lowercase .env assignment lines", () => {
  const r = redact('TYPESAFE_API_KEY=ts_live_abcdef1234567890\ndb_password="Su3rSecretpw!"\n');
  assert.ok(r.text.includes("TYPESAFE_API_KEY="));
  assert.ok(r.text.includes("db_password"));
  assert.ok(!r.text.includes("ts_live_abcdef1234567890"));
  assert.ok(!r.text.includes("Su3rSecretpw"));
  assert.ok(r.text.includes("[REDACTED"));
});

test("redacts full PEM blocks including body and END line", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\nmorebase64body\n-----END RSA PRIVATE KEY-----\nafter";
  const r = redact(pem);
  assert.ok(!r.text.includes("MIIEow"));
  assert.ok(!r.text.includes("morebase64body"));
  assert.ok(!r.text.includes("-----END"));
  assert.ok(r.text.includes("after"));
});

test("redacts PEM without END marker to end of text", () => {
  const r = redact("x\n-----BEGIN PRIVATE KEY-----\nMIIEowfakewithnoend");
  assert.ok(!r.text.includes("MIIEow"));
});

test("redacts underscore-style tokens", () => {
  for (const t of [
    "ghp_abcdefghijklmnopqrstuvwx",
    "github_pat_ABCDEFGHIJKLMNOPQRS",
    "ts_live_abcdefghijklmnop",
    "sk_live_abcdefghijklmnop",
    "npm_abcdefghijklmnop",
    "hf_abcdefghijklmnop",
    "glpat-abcdefghijklmnop",
    "xapp-abcdefghijklmnop",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123",
  ]) {
    const r = redact(`token: ${t}`);
    assert.ok(!r.text.includes(t), `leaked: ${t}`);
  }
});

test("redacts JWTs, Bearer headers and URL credentials", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
  const r = redact(`token: ${jwt}\nAuthorization: Bearer abcdef123456789\npostgres://admin:s3cretpw@db.host/db`);
  assert.ok(!r.text.includes(jwt));
  assert.ok(!r.text.includes("abcdef123456789"));
  assert.ok(!r.text.includes("s3cretpw"));
  assert.ok(r.text.includes("postgres://admin:"));
});

test("keeps false positives untouched", () => {
  const clean = [
    "The auth token in this sentence is just prose.",
    "commit abc123def4567890abcdef1234567890abcdef12",
    "uuid 550e8400-e29b-41d4-a716-446655440000",
    "See docs at https://example.com/guide",
    "max_tokens = 4096 is a config value",
  ].join("\n");
  const r = redact(clean);
  assert.strictEqual(r.text, clean);
});

test("findings carry kind and line, never the value", () => {
  const r = redact('api_key=abcdef12345678\nthe token in prose');
  for (const f of r.findings) {
    assert.ok(typeof f.kind === "string");
    assert.ok(typeof f.line === "number");
    assert.strictEqual(Object.values(f).join(" ").includes("abcdef12345678"), false);
  }
});

test("case-insensitive matching does not depend on recompiled flags (regression: dropped i flag)", () => {
  // The old implementation rebuilt patterns with new RegExp(re.source) which
  // dropped `i`, sending UPPERCASE keys in cleartext while claiming to mask.
  const r = redact("DB_PASSWORD=SUPERSECRETVALUE1\ntoken: GHP_ABCDEFGHIJKLMNOPQRSTUVWX");
  assert.ok(!r.text.includes("SUPERSECRETVALUE1"), "uppercase assignment leaked");
  assert.ok(!r.text.includes("GHP_ABCDEFGHIJKLMNOPQRSTUVWX"), "uppercase token leaked");
});

test("scan reports per-kind findings", () => {
  const f = scan("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\npassword=hunter2hunter2");
  const kinds = f.map((x) => x.kind);
  assert.ok(kinds.includes("private-key"));
  assert.ok(kinds.includes("assignment"));
});
