# TypeSafe Jev Bridge — add a typed decision model to any agent or app

A tiny, zero-dependency Node.js bridge that exposes the TypeSafe **System One** API
(`POST https://api.typesafe.ai/v1/systemone`) as an **OpenAI-compatible** service, so
**9Router**, Claude Code, Cursor, Cline, OpenCode — or **any OpenAI SDK** — can talk
to the **Jev** decision model.

> ⚠️ **Read this first — why every answer looks like "yes":**
> Jev is **not a chat model**. It cannot generate text, write code, or do open-ended
> analysis. It only answers **typed questions** (yes/no, choice among options, or a
> score on a rubric) with probabilities. When a coding agent sends a normal coding
> request through this bridge, the bridge infers a yes/no question → Jev answers
> "yes". That's expected.
>
> **Correct architecture:** keep a *chat* model (Claude, GPT, GLM, …) as the agent's
> main model, and use Jev as a separate **decision tool** next to it — via the
> `ask-jev.cjs` CLI below, a dedicated router combo, or `questions` in raw API calls.

## Why a bridge at all?

- TypeSafe only serves `POST /v1/systemone` (no OpenAI-compatible endpoint, no streaming).
- Most routers and IDE agents only accept OpenAI/Anthropic-compatible chat providers.
- OpenRouter also serves Jev only through the Decisions API, not `/chat/completions`.

The bridge translates both `POST /v1/chat/completions` **and** `POST /v1/responses`
(including SSE streaming) into TypeSafe calls, and renders typed answers back as text.

## Files

| File | Purpose |
| --- | --- |
| `bridge.js` | The bridge server (port 8399, localhost only) |
| `.env` | `TYPESAFE_API_KEY=…` — loaded automatically by the bridge. **Never commit or print this.** See `../.env.example` |
| `ask-jev.cjs` | CLI for asking typed questions about files / text |
| `audit.cjs` | Jev judges every project file (security / bugs / robustness / maintainability) |
| `autofix.cjs` | Judge → fix → re-judge loop (see below) |
| `lib/` | Shared modules: redaction, sensitive-path guard, fence extraction, HTTP client, env parser |
| `test/` | Offline test suite (`npm test` from the repo root) — no network, no key |
| `e2e-live.cjs` | Live end-to-end suite (real bridge, optionally 9Router; spends credits) |
| `demo.py` + `requirements.txt` | Official `typesafe-sdk` demo, direct to TypeSafe |

## 0) Setup (once, for every path below)

### The easy way: `npm run setup`

From the repo root:

```bash
npm run setup
```

The installer checks prerequisites, asks for your key with **hidden input**,
writes `typesafe-bridge/.env` (UTF-8, LF, chmod 600 on macOS/Linux) and
smoke-tests the bridge. Idempotent — re-running it is safe and skips what is
already done. It never installs anything global, never touches your PATH, and
never prints (or stores anywhere but `.env`) your key.

Flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | print the planned actions, change nothing |
| `--yes` | accept defaults, never prompt |
| `--key-stdin` | read the key from stdin (one line) — for scripts/CI |
| `--background` | start the bridge detached, write `.bridge.pid` + `bridge.log` |
| `--with-python` | ALSO set up the optional demo (needs Python ≥ 3.9; creates `.venv`, pip-installs `requirements.txt`) |
| `--live-check` | send ONE short fixed sentence to the real API (a few tokens) after asking |
| `--port N` | bridge port (default `8399` / `TYPESAFE_BRIDGE_PORT`; busy ports auto-advance) |
| `--no-color` | disable ANSI colors |

Python and 9Router are **optional** and are never installed automatically.

### `npm run doctor`

A read-only checklist (`✓ / ! / ✗`, one fix hint per problem): Node version,
`.env` presence/encoding/key shape/permissions/git-tracking, port state, bridge
`/health` + `/v1/models`, version match between the running bridge and the
files, `BRIDGE_TOKEN` / `BRIDGE_ALLOWED_ORIGINS` sanity, optional 9Router and
Python detection, `.gitignore` coverage. Exit 1 when any check fails; `--json`
for machine-readable output.

### `npm run stop`

Stops a bridge started with `--background`: reads `.bridge.pid`, verifies the
recorded process still answers `/health` (so it never kills an unrelated
process), terminates it gracefully and removes the pid file.

### The manual path

1. Get a TypeSafe API key at `console.typesafe.ai/settings/keys`.
2. Create `typesafe-bridge/.env` (copy `../.env.example`):
   ```
   TYPESAFE_API_KEY=apikey_…your key…
   ```
   (or export `TYPESAFE_API_KEY` in your shell — both work)

   Windows note: create the file with Notepad or
   `Set-Content -Encoding utf8` — **not** `echo "…" > .env`, which writes
   UTF-16LE that the parser rejects (a UTF-16 BOM is detected and decoded, but
   plain ASCII is safest).
3. Node 18+ is required (`fetch` is used by the CLI tools).

---

## Path A — Use Jev **without 9Router** (recommended, simplest)

You only need the bridge + your TypeSafe key. Nothing else.

### A1. Run the bridge

```bash
cd typesafe-bridge
node bridge.js
# or in background (Linux/macOS):  nohup node bridge.js > bridge.log 2>&1 &
```

Health check: `curl http://127.0.0.1:8399/health` → `"hasEnvKey": true` means the
key is loaded.

### A2. Ask Jev a typed question (CLI)

```bash
# Yes/no about a project file (file content with line numbers becomes the state):
node ask-jev.cjs --file src/index.ts --q "Does this file have security issues?"

# Choice among named options:
node ask-jev.cjs --file src/routes.ts --q "What is the primary role of this file?" \
  --type choice --criteria "auth=Authentication logic,routes=HTTP routes,utils=Helpers"

# Score from piped text:
echo "chat log of angry customer" | node ask-jev.cjs \
  --q "How angry is the customer?" --type score --criteria "Calm, Frustrated, Very angry"

# Judge a directory layout (names only):
node ask-jev.cjs --dir src --q "Is this codebase well organized?"
```

Output includes the answer, confidence, and token usage. `--min-conf 0.55` (default)
prints full probabilities and exits with code `3` when a choice is low-confidence —
handy for scripts. Secret-like values are **masked by default** before anything is
sent to the TypeSafe API (`--no-redact` disables this).
`--url` targets another bridge instance.

### A3. Raw HTTP (any OpenAI SDK / curl)

The bridge speaks plain OpenAI; the API key stays **in the bridge** — clients use the
placeholder key `sk-typesafe-bridge` (or pass a real TypeSafe key as Bearer):

```bash
# Yes/no (noul) — probability of "yes"
curl -s http://127.0.0.1:8399/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-typesafe-bridge" \
  -d '{
    "model": "typesafe/jev-latest",
    "messages": [{"role":"user","content":"Is this log line an error? | ERROR disk full"}]
  }'

# Typed questions — pass a `questions` map, get structured answers
curl -s http://127.0.0.1:8399/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-typesafe-bridge" \
  -d '{
    "model": "typesafe/jev-latest",
    "messages": [{"role":"user","content":"Customer: Stripe fails 3 days, losing sales, help ASAP"}],
    "questions": {
      "department": {"type":"choice","instructions":"Which team should handle this",
        "criteria":{"billing":"Payment or subscription issues","technical":"Bugs or integration problems","sales":"Pricing or account questions"}},
      "is_urgent": {"type":"noul","instructions":"The message conveys urgency"}
    }
  }'
```

Responses are standard OpenAI chat completions; the raw TypeSafe answer is always
attached on the `typesafe` field of the reply. The Responses API (`/v1/responses`)
works the same way, streaming included.

### A4. Python directly (no bridge)

```bash
cd typesafe-bridge
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install typesafe-sdk
export TYPESAFE_API_KEY=apikey_…
python demo.py    # Run 1 uses the official SDK; Run 2 is optional (via 9Router)
```

---

## Path B — Use Jev **with 9Router** (for routing/combos)

9Router only accepts OpenAI/Anthropic-compatible chat providers, so point a custom
provider node at the bridge:

1. Make sure the bridge is running (Path A, step A1).
2. Open the 9Router dashboard (`http://localhost:20128`) and add a
   **Custom / OpenAI-compatible** provider node:
   - **Base URL:** `http://127.0.0.1:8399/v1`
   - **API Key:** `sk-typesafe-bridge` (the real key lives in the bridge's `.env`)
   - **Models:** `typesafe/jev-latest`, `typesafe/jev-preview`
3. Run **Test** on the node once — status should become `active`.
4. Optionally add `typesafe/jev-latest` as a layer in a **Combo** (e.g. a combo
   that pairs your chat model with a Jev decision layer). Point any tool at
   `http://localhost:20128/v1` and select the Jev model/combo. 9Router normalizes
   chat ↔ responses formats itself, so both work.

> ⚠️ **Never route coding tasks to a Jev combo.** Jev returns typed decisions, not
> text. Use it as a decision layer, not as the main model.

Test end-to-end (bridge + 9Router):

```bash
node e2e-live.cjs                # full suite against the REAL API (spends credits)
node e2e-live.cjs --skip-9router # only the direct-bridge tests
```

The offline suite (no network, no key) is `npm test` from the repo root.

---

## How questions are inferred (plain chat requests)

The bridge picks questions in this exact order:

1. **Explicit `questions` map** in the JSON body → passed to TypeSafe verbatim
   (validated: plain object, ≤ 20 entries, ids `^[A-Za-z0-9_.-]{1,64}$`,
   `type` ∈ `noul|choice|score`; anything else → 400).
2. **JSON object spec** in the system message, else the first user message →
   its keys become **choice** options (string values become instructions).
   A single-key object keeps that key as the answer id and asks yes/no.
   Every value must be a string; otherwise the spec is ignored.
3. **Yes/no phrasing** ("Is…", "Does…", "yes/no") in the **last user message**,
   then the system message → **noul** (probability of yes).
4. **Default**: a single yes/no **choice** over the last user message (or the
   system message if there is no user text).

So `demo.py`-style "Return JSON with keys: department, is_urgent" prose does
**not** create two questions — send an explicit `questions` map instead (the
demo now does exactly that).

Answers are rendered like:

```
department: billing (confidence: 0.84)
is_urgent: 0.999
```

---

## `autofix.cjs` — the Jev verdict → chat-model fix → re-judge loop

Jev is the **judge**; a **chat model** is the fixer — Jev cannot generate text.
By default the fixer goes through 9Router (`ROUTER_9_BASE_URL`, default
`http://127.0.0.1:20128`); set `AUTOFIX_MODEL` to any chat model your router
exposes. Without 9Router, point `ROUTER_9_BASE_URL` at any OpenAI-compatible
endpoint and set `ROUTER_9_API_KEY` accordingly.

For each flagged file the loop:

1. Judges the file with Jev (same questions as `audit.cjs`).
2. Sends Jev's specific findings + the file to the fix model, which must return
   the complete corrected file in one fenced block.
3. Re-judges. Improvements are accepted; anything else restores the backup and
   rotates to the next model in the fallback chain. Up to `--max-runs` per file.

```bash
node autofix.cjs                          # dry-run: show verdicts + planned fixes
node autofix.cjs --apply                  # actually fix flagged files
node autofix.cjs src/app.js --apply --max-runs 4 --min-score 2.5
AUTOFIX_MODEL="your-chat-model" node autofix.cjs --apply
```

Safety: dry-run by default (it still **sends file content to Jev and — for
flagged files — to your fix model**, and spends credits; use `--plan-only` for
verdicts without any fix-model call), timestamped `.bak-autofix-…` backup per
run, sensitive paths (`.env*`, `*.pem`, `*.key`, `id_rsa*`, …) refused even on
the command line, truncated/unchanged/corrupt model output is rejected and
validated (`node --check` / `py_compile` / JSON / fence balance), and a unified
diff is printed for review. The tool's own sources and tests are excluded from
default targets.

---

## Point your AI agent at this app (agent instructions)

Copy-paste the block below into your agent's config/rules file
(`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, a custom MCP/tool description, …)
and it will know how to use Jev correctly:

```markdown
## Jev — typed decision tool (available in this repo)

A local bridge exposes TypeSafe **Jev**, a model that answers TYPED QUESTIONS
(yes/no probability, choice among options, score 0–4) about any text or file.
It never generates text — use it to *decide*, not to *write*.

When to use it: verification, triage, ranking, routing, choosing between
options, or any judgment an LLM would otherwise do with prompt-and-parse.
When NOT: code generation, explanations, open-ended analysis.

How to ask (from the repo root, bridge must be running):
    node typesafe-bridge/ask-jev.cjs --file <path> --q "<question?>"
    # choice:  --type choice --criteria "optA=meaning A,optB=meaning B"
    # score:   --type score --criteria "Level1,Level2,Level3,Level4"
    # stdin:   <command> | node typesafe-bridge/ask-jev.cjs --q "<question?>"

Reading answers:
- yes/no: value near 1 = yes, near 0 = no; 0.35–0.65 = uncertain → gather
  more evidence or reframe the question.
- choice: confidence < 0.55 → check the printed probability distribution
  before acting (the CLI exits with code 3 on low confidence).
- score: read against the printed level legend, not as a raw number.

Rules:
- One narrow judgment per question; split complex decisions into several asks.
- Ask independent questions over the same file together (they run in parallel).
- Never paste secrets into the question; the CLI masks secret-like values by
  default (`--no-redact` to disable), and the bridge rejects non-loopback
  Host/Origin headers so websites can't reach your local bridge.
```

For agent frameworks that call OpenAI-compatible HTTP APIs directly, point them at
`http://127.0.0.1:8399/v1` (Path A3) and let them send `questions` maps.

---

## Troubleshooting

- **404 "Unknown route"** — an old bridge process is still running. Restart it: the
  current bridge supports `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/health`.
- **`model-id` in errors** — that's a router's combo placeholder; the bridge maps any
  model id (`typesafe/jev-latest`, `jev-latest/model-id`, `model-id`) to `jev-latest`.
- **401 authentication_error from upstream** — the key is wrong/expired; fix `.env`.
- **429 / 529** — TypeSafe rate limit / overload; back off and retry.
- **Router returns SSE after the JSON body** — when writing your own client, parse
  the first JSON object and ignore the trailing `data: [DONE]`.
- **Bridge dies on reboot** — it's a plain background process. Start it again, or
  convert it to a service (scheduled task / systemd unit).

## Notes

- The bridge listens on `127.0.0.1` only, rejects non-loopback `Host` headers
  (DNS-rebinding guard) and rejects browser `Origin` headers unless they are in
  `BRIDGE_ALLOWED_ORIGINS` (comma-separated). Set `BRIDGE_TOKEN=…` to require a
  real shared secret from clients (constant-time compared); without it, any
  local process can use the bridge. Malformed request targets answer 400 and
  never crash the process. Still don't expose it publicly.
- TypeSafe errors: 401 bad key, 422 invalid question shape, 429 rate limit, 529 overloaded.
- Direct SDK usage (bypassing the bridge) works too — see `demo.py`.
- Official docs: `docs.typesafe.ai` — the `typesafe-ai` agent skill
  (github.com/typesafe-ai/skills) mirrors the integration patterns.
