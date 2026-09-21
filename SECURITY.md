# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's **"Report a vulnerability"** button on the
[Security tab of this repository](https://github.com/RevocGG/typesafe-jev-bridge/security/advisories/new)
(private security advisory). Include a description, reproduction steps, and the
affected version/commit. You will get a response within a few days.

## Supported versions

| Version | Supported |
| --- | --- |
| latest `main` | ✅ |
| older tags/commits | ❌ (upgrade) |

## Security model (summary)

- The bridge is a **localhost convenience service**. It binds to `127.0.0.1`,
  rejects non-loopback `Host` headers, and rejects browser `Origin` headers
  unless allow-listed via `BRIDGE_ALLOWED_ORIGINS`.
- Set `BRIDGE_TOKEN` to require a shared Bearer secret from clients. Without it,
  **any local process** run by your user can use the bridge and spend your
  TypeSafe credits — that is the accepted trade-off for a zero-config local tool.
- Client Bearer tokens are **never** relayed upstream by default; the upstream
  key is always the one from `TYPESAFE_API_KEY`. With explicit opt-in
  (`BRIDGE_ALLOW_KEY_PASSTHROUGH=1`) only TypeSafe-shaped client keys
  (`apikey_…` or legacy `ts_live_…`/`ts_test_…`) are forwarded.
- The CLI masks secret-like values before sending. Bridge-level redaction for
  router traffic is opt-in (`BRIDGE_REDACT=1`).
- Never expose the bridge to a network, and never route code-generation tasks to
  a Jev combo.

See the "Security model" section of the root `README.md` for details.
