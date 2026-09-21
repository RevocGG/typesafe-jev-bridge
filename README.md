# typesafe-jev-bridge

> Use the **TypeSafe Jev** decision model (System One) from any OpenAI-compatible
> tool: **9Router, Claude Code, Cursor, Cline — or any OpenAI SDK.**

> [!IMPORTANT]
> **Unofficial community project — not affiliated with, endorsed by, or
> officially connected to TypeSafe.** "TypeSafe" and "Jev" are used to describe
> interoperability only. You need your own TypeSafe API key.

## What is Jev? (30-second intro)

Most AI models *generate text*. **Jev** doesn't — it answers **typed questions**
with calibrated probabilities: a yes/no likelihood (*noul*), a **choice** among
options, or a **score** on a rubric you define. You give it *state* (any text or
file) plus questions; it gives your code answers it can act on. It's fast and
cheap, and it says **"I'm not sure"** when it genuinely is — instead of making
something up.

This repo ships a tiny **zero-dependency Node.js bridge** that makes Jev speak the
OpenAI API, plus a CLI, a code-audit tool, and an auto-fix loop.

## 🍿 A real example first

Ask Jev to route a support ticket — a **choice** question (real output):

```console
$ node ask-jev.cjs --text 'Customer: I was charged twice for my September
    subscription. I want the duplicate $29 charge refunded today.' \
    --q "Which team should handle this?" --type choice \
    --criteria "billing=Payment or subscription issues,technical=Bugs or integration problems,sales=Pricing or account questions"

Which team should handle this?: billing (confidence 1)
tokens: 352 in / 44 out
```

> PowerShell users: quoting differs. Easiest path is `--text-file ticket.txt`,
> or use `--%` stop-parsing: `node ask-jev.cjs --% --text "..." --q "..."`.
> The `$29` above is why plain double quotes bite in both shells.

Same question, ambiguous message — Jev **refuses to fake certainty** and the CLI
exits with code `3` so scripts can react (real output):

```console
$ node ask-jev.cjs --text 'Customer: Stripe fails 3 days, losing sales, help ASAP.' \
    --q "Which team should handle this?" --type choice \
    --criteria "billing=Payment or subscription issues,technical=Bugs or integration problems,sales=Pricing or account questions"

Which team should handle this?: technical (confidence 0.29)
  !! low confidence (< 0.55) — check probabilities:
     billing: 0.47
     sales: 0
     technical: 0.53
tokens: 360 in / 44 out
```

A **score** question over a rubric you define (real output):

```console
$ echo "You people are useless, this is the third time I'm writing. Fix it NOW." \
    | node ask-jev.cjs --q "How angry is the customer?" --type score \
    --criteria "Calm, Frustrated, Very angry"

How angry is the customer?: 2 (confidence 1)
   0: Calm
   1: Frustrated
   2: Very angry
tokens: 324 in / 23 out
```

Yes/no questions work the same way (`--type noul`): you get a probability like
`0.07` (no) or `0.94` (yes), and anything between 0.35–0.65 means *uncertain —
gather more evidence*.

🎬 **See these real outputs on one styled page** — including Jev judging this very
repo and the fixes its verdicts triggered: [`examples.html`](examples.html)

## 🏗️ Architecture

```
 your chat model decides WHAT to do        Jev decides WHAT IS TRUE
 ┌──────────────┐   ┌──────────────────┐   ┌───────────────────────┐
 │ Claude/GPT/  │   │ typesafe-bridge  │   │  api.typesafe.ai      │
 │ GLM … (agent)│──▶│ (this repo,      │──▶│  POST /v1/systemone   │
 │              │   │  port 8399)      │   │  (Jev, typed answers) │
 └──────────────┘   └──────────────────┘   └───────────────────────┘
        ▲                  ▲      ▲
        │                  │      └── any OpenAI SDK / curl / 9Router combo
        └── ask-jev.cjs ───┘          (chat/completions + responses + SSE)
```

- **The bridge** translates `POST /v1/chat/completions` and `POST /v1/responses`
  (including SSE streaming) into TypeSafe's `/v1/systemone` calls, and renders the
  typed answers back as text. Your TypeSafe API key stays in the bridge's `.env`;
  clients use the placeholder key `sk-typesafe-bridge` (or set `BRIDGE_TOKEN` for
  a real shared secret — see the security model below).
- **Why a bridge?** TypeSafe only serves its own `/v1/systemone` endpoint — no
  OpenAI-compatible chat API, no streaming. Routers and IDE agents only speak
  OpenAI/Anthropic. This fills that gap in one dependency-free Node file.
- **Keep the two roles separate:** your *chat* model writes code and prose; Jev
  answers *decisions* next to it — verify, triage, rank, route, choose. Never
  route coding tasks to Jev: the bridge infers a yes/no question → Jev answers
  "yes". That's by design, not a bug.

## Quickstart

**1) Get a key** at `console.typesafe.ai/keys`, then create `typesafe-bridge/.env`
(copy the provided [`.env.example`](.env.example)):

```bash
# bash / macOS / Linux
cp .env.example typesafe-bridge/.env && nano typesafe-bridge/.env
```

```powershell
# Windows PowerShell (NOT "echo > .env" — that writes UTF-16 which the parser rejects)
Copy-Item .env.example typesafe-bridge/.env
notepad typesafe-bridge\.env
```

Then start the bridge:

```bash
cd typesafe-bridge
node bridge.js          # keep it running (localhost only)
```

<details>
<summary>Keep it running in the background</summary>

```bash
# bash / macOS / Linux
nohup node bridge.js > bridge.log 2>&1 &
```

```powershell
# Windows: Start-Process keeps it alive after the terminal closes
Start-Process -WindowStyle Hidden node -ArgumentList "bridge.js" -WorkingDirectory typesafe-bridge
```
</details>

**2a) Without 9Router** — use the CLI or any OpenAI client directly:

```bash
node ask-jev.cjs --file src/index.ts --q "Does this file have security issues?"
node ask-jev.cjs --dir src --q "Is this codebase well organized?"
```

Copy-paste `curl` examples for `/v1/chat/completions` (with and without an
explicit `questions` map) are in
[`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md).

**2b) With 9Router** — dashboard (`http://localhost:20128`) → add a
**Custom / OpenAI-compatible** provider:

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8399/v1` |
| API Key | `sk-typesafe-bridge` (real key stays in the bridge's `.env`) |
| Models | `typesafe/jev-latest`, `typesafe/jev-preview` |

Run **Test** once, optionally add the model as a **Combo** layer, and point any
tool at `http://localhost:20128/v1`. Full step-by-step guide (and how to run the
live end-to-end suite with `node e2e-live.cjs`) in
[`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md).

## 🔒 Security model

- **Loopback only.** The bridge binds to `127.0.0.1` and rejects non-loopback
  `Host` headers (DNS-rebinding guard). Malformed request targets answer 400 and
  never crash the process.
- **Origin allow-list.** Browser requests carrying an `Origin` header are
  rejected (403) unless the origin is listed in `BRIDGE_ALLOWED_ORIGINS`. Any
  page on any local dev server or `*.localhost` is *not* trusted by default.
- **Optional shared token.** Set `BRIDGE_TOKEN=…` and clients must send
  `Authorization: Bearer …` (constant-time compare). Only real `ts_live_`/`ts_test_`
  keys are ever forwarded upstream; other client tokens are ignored.
- **Redaction.** The CLI masks secret-like values (`.env` style assignments,
  PEM keys, `ghp_`/`sk_live_`/JWT/`AIza…` tokens, URL credentials) before
  anything leaves your machine. Bridge-level redaction for router traffic is
  opt-in via `BRIDGE_REDACT=1`.
- **What is NOT protected:** any *local process* that you run (or that runs with
  your user) can still call the bridge unless you set `BRIDGE_TOKEN`. The bridge
  is a localhost convenience service, not a multi-user sandbox.
- **What leaves your machine:** `--file`, `--dir`, `audit` and `autofix` send
  file content to the TypeSafe API (Jev); `autofix` additionally sends flagged
  files to your configured fix model. Redaction masks obvious secret-like
  values, but it cannot catch everything — review `--no-redact` usage and
  never point it at credential stores. Sensitive paths (`.env*`, `*.pem`,
  `*.key`, `id_rsa*`, `.npmrc`, …) are refused by default.

## 🤖 Tell your AI agent

Paste the ready-made block from
[`typesafe-bridge/GUIDE.md → "Point your AI agent at this app"`](typesafe-bridge/GUIDE.md#point-your-ai-agent-at-this-app-agent-instructions)
into `AGENTS.md`, `CLAUDE.md`, or `.cursorrules`. Your agent then knows when to
ask Jev, how to phrase typed questions, and how to read probabilities,
confidence, and score levels. This repo's own agent notes live in
[`AGENTS.md`](AGENTS.md).

## What's in the box

| File | Purpose |
| --- | --- |
| `typesafe-bridge/bridge.js` | The OpenAI-compatible bridge (port 8399, localhost only) |
| `typesafe-bridge/ask-jev.cjs` | CLI: typed questions about files, directories, or stdin |
| `typesafe-bridge/audit.cjs` | Jev judges every file (security / bugs / robustness / docs) |
| `typesafe-bridge/autofix.cjs` | Judge → fix → re-judge loop (dry-run by default, backups, model fallback chain) |
| `typesafe-bridge/lib/` | Shared modules: redaction, sensitive-path guard, fence extraction, HTTP client, env parser |
| `typesafe-bridge/test/` | Offline test suite (`npm test`) — no network, no key needed |
| `typesafe-bridge/e2e-live.cjs` | Live end-to-end suite against a real bridge (and optionally 9Router) |
| `typesafe-bridge/demo.py` | Official `typesafe-sdk` demo (direct, no bridge) |
| `typesafe-bridge/GUIDE.md` | The full manual (setup, HTTP, 9Router, agents) |
| `examples.html` | Real verbatim test-run outputs from the build session, styled |

## Environment variables

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `TYPESAFE_API_KEY` | bridge, all CLIs | — (required) | Your `ts_live_`/`ts_test_` key; from env or `typesafe-bridge/.env` |
| `TYPESAFE_API_BASE` | bridge | `https://api.typesafe.ai` | Upstream base (protocol/host/port/path honored) |
| `TYPESAFE_BRIDGE_PORT` | bridge | `8399` | Port the bridge listens on |
| `TYPESAFE_BRIDGE_URL` | demo.py, e2e-live | `http://127.0.0.1:8399` | Where clients find the bridge |
| `BRIDGE_TOKEN` | bridge + clients | unset | If set, require this exact Bearer token |
| `BRIDGE_ALLOWED_ORIGINS` | bridge | empty | Comma-separated browser origins allowed (CORS + preflight) |
| `BRIDGE_REDACT` | bridge | `0` | `1` = redact state before forwarding (routers bypass the CLI) |
| `BRIDGE_MAX_BODY_BYTES` | bridge | `2097152` | Max request body size (413 above) |
| `BRIDGE_MAX_STATE_CHARS` | bridge | `200000` | Max state characters sent upstream (413 above) |
| `BRIDGE_LOG_LEVEL` | bridge | `info` | `error` \| `info` \| `debug` |
| `TYPESAFE_TIMEOUT_MS` | bridge | `60000` | Upstream call timeout |
| `ROUTER_9_BASE_URL` | autofix, demo, e2e-live | `http://127.0.0.1:20128` | 9Router base (with or without `/v1`) |
| `ROUTER_9_API_KEY` | autofix, demo, e2e-live | — | Client key of the router endpoint |
| `ROUTER_9_MODEL` | demo, e2e-live | — | Chat model name at the router (no private default ships) |
| `AUTOFIX_MODEL` | autofix | — | Default fix model id |
| `AUTOFIX_FALLBACK_MODELS` | autofix | — | Comma-separated fallback chain |

## Exit codes (`ask-jev.cjs`, `audit.cjs`, `autofix.cjs`)

| Code | Meaning |
| --- | --- |
| `0` | Success (confident answers / clean audit) |
| `1` | Runtime error (bridge unreachable, upstream error, validation) |
| `2` | Usage error (bad flag, sensitive path refused, missing config) |
| `3` | Uncertain answer (below `--min-conf`, or noul in the 0.35–0.65 band) |

## Docs

- 🧪 Real test runs — verbatim suite output, security verification & Jev judgments → [`examples.html`](examples.html)
- Full guide: HTTP examples, 9Router setup, agent instructions, troubleshooting → [`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md)
- Official TypeSafe docs → [docs.typesafe.ai](https://docs.typesafe.ai)

## License

[MIT](LICENSE) © 2026 RevocGG
