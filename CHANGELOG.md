# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-09-21

### Fixed
- `assertInsideRoot` treated Windows drive-letter paths (`C:/…`) as plain
  relative folder names on POSIX, silently resolving them inside the repo
  root; foreign-absolute paths are now rejected on every platform.
- The offline CLI tests created a fixture `.env` themselves, so the suite
  passes on a fresh clone / CI runner without a developer's real `.env`.

### Changed
- **Default: no client-key passthrough.** The bridge always uses the key from
  `TYPESAFE_API_KEY`; client Bearer tokens are never relayed upstream unless
  `BRIDGE_ALLOW_KEY_PASSTHROUGH=1` is set (and then only TypeSafe-shaped keys:
  `apikey_…` or legacy `ts_live_…`/`ts_test_…`).
- **Key-shape checks are informational.** Shared `KEY_HINT_RE` in `lib/env.cjs`
  accepts the dashboard's `apikey_…` format (and legacy `ts_live_…`/`ts_test_…`);
  an unusual prefix is only a hint, never a failure or a ✗ in doctor/setup.
  Hard errors are limited to empty keys, whitespace/quotes, or < 16 chars.
- Secret redaction recognizes `apikey_…` tokens; docs use `apikey_…` examples.

## [0.2.0] - 2026-09-21

### Added (post-0.2.0)
- One-command guided setup (`npm run setup`) with preflight checks, hidden API-key
  input, optional Python/9Router detection, background start (`--background`),
  offline smoke test, optional `--live-check`, and a final summary screen.
- `npm run doctor` — read-only health checklist (`--json` for machines).
- `npm run stop` — gracefully stops a background bridge via `.bridge.pid`.
- Startup banner and a request log line (method, path, status, latency, tokens)
  on every bridge start; colors honor `NO_COLOR`, `--no-color` and non-TTY.
- setup backs up an existing `.env` to `.env.bak-setup` before rewriting.
- `test/setup-doctor.test.cjs` — offline tests for the setup/doctor flow.

### Hardening (the `hardening` branch)

#### Added
- `BRIDGE_TOKEN`: optional shared-secret auth on the bridge (constant-time
  compare). Client Bearer tokens are forwarded upstream only when they are real
  `ts_live_`/`ts_test_` keys; anything else is ignored, never relayed.
- `BRIDGE_ALLOWED_ORIGINS`: browser-origin allow-list with real CORS/preflight
  support; every other `Origin` is rejected with 403.
- `lib/` shared modules (redact, sensitive, fence, client, questions, targets,
  env) — one implementation for every consumer.
- Offline test suite (`npm test`, 50 tests, mock upstream, no network/key) plus
  regression tests for every verified defect.
- `--plan-only` (autofix), `--json`, `--text-file`, `--max-bytes`,
  `--allow-sensitive`, `--allow-remote`, `--version` flags on the CLIs;
  `--fail-on`, `--concurrency`, threshold flags on `audit`.
- `.env.example`, `.gitattributes`, `.editorconfig`, GitHub Actions CI
  (Node 18/20/22 × Linux/Windows, offline only), `SECURITY.md`.
- `VERSION` in `/health`, friendly `EADDRINUSE`/`EACCES` messages, graceful
  SIGINT/SIGTERM shutdown, `BRIDGE_LOG_LEVEL`.

#### Changed
- Secret redaction rewritten: single-pass compiled patterns, full PEM blocks,
  underscore-style tokens (`ghp_`, `ts_live_`, `sk_live_`), JWTs, `AIza…`,
  Bearer headers, URL credentials; `[REDACTED:<kind>]` replacement that never
  echoes a prefix of the secret; warnings show line numbers only.
- Sensitive-path guard unified and applied to explicit CLI arguments too;
  audit/autofix refuse paths outside the repo root (symlink-resolved).
- `autofix` extracts fenced output with the last fence, validates syntax
  (`node --check` / `py_compile` / JSON / fence balance), preserves EOL, prints
  a diff, writes timestamped backups, and excludes its own sources from targets.
- Question inference order documented and fixed: explicit map → JSON spec →
  yes/no phrasing in the **last** user message → default.
- `.env` parser: trims values, strips quotes, supports `export ` and inline
  `#` comments, decodes UTF-16LE (PowerShell 5.1) and UTF-8 BOMs.
- `test-all.cjs` renamed to `e2e-live.cjs` (so `node --test` does not pick it
  up); URLs from `TYPESAFE_BRIDGE_URL`/`TYPESAFE_BRIDGE_PORT`; 9Router section
  skips with a warning when unconfigured; specific numeric assertions.
- `CODEBUFF.md` renamed to `AGENTS.md`.

#### Fixed
- Malformed request targets (`GET //`, bad URLs, 100 KB request lines) no
  longer crash the bridge (400 + keep serving).
- Oversized bodies now answer **413** instead of leaking `ECONNRESET`.
- Upstream/stream failures return real HTTP error statuses instead of 200 with
  an error chunk; first stream delta carries `role: "assistant"`.
- `TYPESAFE_API_BASE` honors protocol/port/base path (enables offline testing).
- Non-JSON upstream 200 responses become 502 instead of empty content.
- `ask-jev.cjs` no longer hangs when stdin is a silent pipe (spawned runs).
- `autofix.cjs` argv off-by-two that silently dropped the first two arguments.

## [0.1.0]

- Initial public preview: bridge, `ask-jev` CLI, `audit`, `autofix`, demo.
