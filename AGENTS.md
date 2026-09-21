# AGENTS.md — Notes for AI Agents

This repo is a small toolkit for using **TypeSafe Jev** — a typed *decision* model —
as a judge/arbiter for code, documents, and strategies.

## What Jev is (and is NOT)

- **Jev is NOT a chat model.** It returns typed decisions (yes/no probability,
  choice among options, score on a rubric) — never generated text. Do not use it
  for code generation or open-ended analysis. See the official skill docs at
  https://github.com/typesafe-ai/skills (skill: `typesafe-ai`) and
  https://docs.typesafe.ai for the live API docs.
- The local bridge (`typesafe-bridge/bridge.js`, port 8399) exposes Jev as an
  OpenAI-compatible API so routers and IDE agents can talk to it. Your API key
  lives in `typesafe-bridge/.env` (never commit or print it).
- When building features that need judgments (routing, ranking, verification,
  severity triage…), prefer asking Jev typed questions via the bridge instead of
  LLM prompt-and-parse. Read the skill docs first.

## Prerequisites

- **Node.js 18+** (the CLI tools use global `fetch`).
- A **TypeSafe API key** from `console.typesafe.ai/keys`, placed in
  `typesafe-bridge/.env` as `TYPESAFE_API_KEY=apikey_…`.
- macOS/Linux users need `curl` for the health check; on Windows use any HTTP
  client or PowerShell's `Invoke-WebRequest`.

## Quick commands

```bash
# start the bridge (localhost only)
cd typesafe-bridge && node bridge.js

# ask a typed question about a file
node typesafe-bridge/ask-jev.cjs --file src/index.ts --q "Does this file have security issues?"
```

Full docs, setup for both 9Router and non-9Router users, and instructions for
pointing an AI agent at this app: see [`typesafe-bridge/GUIDE.md`](typesafe-bridge/GUIDE.md).
Live example outputs: [`examples.html`](examples.html).

## Repo hygiene

- `typesafe-bridge/.env` holds the only secret (`TYPESAFE_API_KEY`). It is
  git-ignored; never print, copy, or commit it.
- Judgment outputs (`answers*.json`), logs, and `.venv/` are local-only and
  git-ignored.
- `.agents/skills/` is git-ignored (local installs), while `skills-lock.json`
  **is** committed — a fresh clone must reinstall the skill before using it.
