"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnvText, readEnvFile, loadEnvFile } = require("../lib/env.cjs");

test("trims trailing whitespace from values (regression: greedy (.*)\\s*$)", () => {
  const r = parseEnvText("KEY=value   \n");
  assert.strictEqual(r.KEY, "value");
});

test("strips matching single or double quotes", () => {
  assert.deepStrictEqual(parseEnvText("A=\"x y\"\nB='z z'\n"), { A: "x y", B: "z z" });
});

test("supports export prefix", () => {
  assert.deepStrictEqual(parseEnvText("export KEY=v1\nexport  OTHER=v2"), { KEY: "v1", OTHER: "v2" });
});

test("strips inline comments on unquoted values but keeps them in quotes", () => {
  assert.deepStrictEqual(parseEnvText("K=v # comment here\nJ=\"v # kept\"\n"), { K: "v", J: "v # kept" });
});

test("parses UTF-16LE files written by PowerShell 5.1 (regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-env-"));
  try {
    const file = path.join(dir, ".env");
    // PowerShell's `echo "K=V" > .env` produces UTF-16LE with BOM.
    fs.writeFileSync(file, Buffer.from("TYPESAFE_API_KEY=ts_live_u16fake\n", "utf16le"));
    // Prepend the FF FE BOM bytes that PowerShell writes.
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), fs.readFileSync(file)]);
    fs.writeFileSync(file, withBom);
    const { values, encoding } = readEnvFile(file);
    assert.strictEqual(encoding, "utf16le");
    assert.strictEqual(values.TYPESAFE_API_KEY, "ts_live_u16fake");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores a UTF-8 BOM", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-env-"));
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("K=v\n", "utf8")]));
    const { values } = readEnvFile(file);
    assert.strictEqual(values.K, "v");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile never overwrites existing environment variables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-env-"));
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "K1=fromfile\nK2=fromfile\n");
    process.env.K1 = "fromenv";
    const { loaded } = loadEnvFile(file);
    assert.strictEqual(process.env.K1, "fromenv");
    assert.strictEqual(process.env.K2, "fromfile");
    assert.ok(loaded.includes("K2"));
    assert.ok(!loaded.includes("K1"));
    delete process.env.K1;
    delete process.env.K2;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty lines, comments and garbage lines are ignored", () => {
  assert.deepStrictEqual(parseEnvText("\n# comment\nnot a pair\nA=1\n"), { A: "1" });
});
