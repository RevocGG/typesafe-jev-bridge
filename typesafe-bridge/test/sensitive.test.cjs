"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isSensitivePath, sensitiveReason, assertInsideRoot } = require("../lib/sensitive.cjs");

test("denylist covers env files, keys, credentials, logs, backups, judgment outputs", () => {
  for (const p of [
    ".env",
    "typesafe-bridge/.env",
    ".env.local",
    "server.pem",
    "server.key",
    "cert.p12",
    "id_rsa",
    "id_ed25519.pub",
    ".npmrc",
    ".netrc",
    "credentials.json",
    "bridge.log",
    "bridge.js.bak-autofix",
    "answers1.json",
    "nohup.out",
    "db.sqlite",
  ]) {
    assert.ok(isSensitivePath(p), `should be sensitive: ${p}`);
  }
});

test("normal source files are not sensitive", () => {
  for (const p of ["bridge.js", "README.md", "src/index.ts", "typesafe-bridge/lib/redact.cjs", "package.json"]) {
    assert.strictEqual(isSensitivePath(p), false, `should NOT be sensitive: ${p}`);
  }
});

test(".git / .agents / .freebuff directories are protected", () => {
  assert.ok(isSensitivePath(".git/config"));
  assert.ok(isSensitivePath(".agents/skills/x.md"));
  assert.ok(isSensitivePath(".freebuff/project-id"));
  assert.ok(sensitiveReason(".git/HEAD").includes("protected directory"));
});

test("assertInsideRoot rejects traversal outside root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-root-"));
  try {
    assertInsideRoot(path.join(root, "ok.js"), root);
    assert.throws(() => assertInsideRoot(path.join(root, "..", "outside.txt"), root), /outside the repo root/);
    assert.throws(() => assertInsideRoot("C:/Windows/system32/drivers/etc/hosts", root), /outside the repo root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assertInsideRoot resolves symlinks before checking", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-root-"));
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jev-out-"));
    const link = path.join(root, "evil-link");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch {
      return; // Windows without symlink privilege
    }
    assert.throws(() => assertInsideRoot(path.join(link, "x.txt"), root), /outside the repo root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of fs.readdirSync(os.tmpdir())) {
      if (d.startsWith("jev-out-")) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
  }
});
