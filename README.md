# typesafe-jev-bridge

> Use the **TypeSafe Jev** decision model (System One) from any OpenAI-compatible
> tool: **9Router, Claude Code, Cursor, Cline — or any OpenAI SDK.**

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
$ node ask-jev.cjs --text "Customer: I was charged twice for my September
    subscription. I want the duplicate $29 charge refunded today." \
    --q "Which team should handle this?" --type choice \
    --criteria "billing=Payment or subscription issues,technical=Bugs or integration problems,sales=Pricing or account questions"

Which team should handle this?: billing (confidence 1)
tokens: 352 in / 44 out
```

Same question, ambiguous message — Jev **refuses to fake certainty** and the CLI
exits with code `3` so scripts can react (real output):

```console
$ node ask-jev.cjs --text "Customer: Stripe fails 3 days, losing sales, help ASAP."
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

Security by default: the CLI masks secret-like values before sending (`--no-redact`
to opt out), and the bridge only serves loopback `Host`/`Origin` headers, so a
web page you visit can't quietly use your paid key.

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
  clients use the placeholder key `sk-typesafe-bridge`.
- **Why a bridge?** TypeSafe only serves its own `/v1/systemone` endpoint — no
  OpenAI-compatible chat API, no streaming. Routers and IDE agents only speak
  OpenAI/Anthropic. This fills that gap in ~500 lines of dependency-free Node.
- **Keep the two roles separate:** your *chat* model writes code and prose; Jev
  answers *decisions* next to it — verify, triage, rank, route, choose. Never
  route coding tasks to Jev: the bridge infers a yes/no question → Jev answers
  "yes". That's by design, not a bug.

## Quickstart

**1) Get a key** at `console.typesafe.ai/settings/keys`, then:

```bash
echo "TYPESAFE_API_KEY=ts_live_…" > typesafe-bridge/.env   # or export it
cd typesafe-bridge
node bridge.js          # keep it running (localhost only)
```

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
tool at `http://localhost:20128/v1`. Full step-by-step guide (and how to test it
end-to-end with `node test-all.cjs`) in
[`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md).

## 🤖 Tell your AI agent

Paste the ready-made block from
[`typesafe-bridge/GUIDE.md → "Point your AI agent at this app"`](typesafe-bridge/GUIDE.md#point-your-ai-agent-at-this-app-agent-instructions)
into `AGENTS.md`, `CLAUDE.md`, or `.cursorrules`. Your agent then knows when to
ask Jev, how to phrase typed questions, and how to read probabilities,
confidence, and score levels.

## What's in the box

| File | Purpose |
| --- | --- |
| `typesafe-bridge/bridge.js` | The OpenAI-compatible bridge (port 8399, localhost only) |
| `typesafe-bridge/ask-jev.cjs` | CLI: typed questions about files, directories, or stdin |
| `typesafe-bridge/audit.cjs` | Jev judges every file (security / bugs / robustness / docs) |
| `typesafe-bridge/autofix.cjs` | Judge → fix → re-judge loop (dry-run by default, backups, model fallback chain) |
| `typesafe-bridge/test-all.cjs` | End-to-end tests for the direct bridge **and** the 9Router path |
| `typesafe-bridge/demo.py` | Official `typesafe-sdk` demo (direct, no bridge) |
| `typesafe-bridge/GUIDE.md` | The full manual (setup, HTTP, 9Router, agents) |
| `examples.html` | Real verbatim test-run outputs from the build session, styled |

## Docs

- 🧪 Real test runs — verbatim suite output, security verification & Jev judgments → [`examples.html`](examples.html)
- Full guide: HTTP examples, 9Router setup, agent instructions, troubleshooting → [`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md)
- Official TypeSafe docs → [docs.typesafe.ai](https://docs.typesafe.ai)

## License

[MIT](LICENSE) © 2026 RevocGG
