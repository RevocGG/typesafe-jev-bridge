"""
TypeSafe Jev demo — two ways to call it once your API key is set.

Setup (bash / macOS / Linux):
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    export TYPESAFE_API_KEY="ts_live_..."   # from console.typesafe.ai/settings/keys
    python demo.py

Setup (Windows PowerShell):
    .\.venv\Scripts\Activate.ps1
    pip install -r requirements.txt
    $env:TYPESAFE_API_KEY = "ts_live_..."   # from console.typesafe.ai/settings/keys
    python demo.py

Run 1 uses the official SDK directly (no 9Router needed): it sends an explicit
`questions` map with all three typed questions (choice / score / noul) and
prints each answer.

Run 2 goes through 9Router -> this bridge -> TypeSafe, exactly like your coding
tools will once the provider is configured in the 9Router dashboard. It sends
the same explicit questions map as JSON so the bridge asks Jev typed questions
instead of guessing a single yes/no.

Exit code: 0 if every requested run succeeded, 1 if any failed.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BRIDGE_URL = os.environ.get("TYPESAFE_BRIDGE_URL", "http://127.0.0.1:8399")
STATE = (
    "Hi, I've been trying to connect my Stripe account for 3 days and it keeps "
    "failing. I'm losing sales. Please help ASAP."
)

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which team should handle this ticket?",
        "criteria": {
            "billing": "Payment or subscription issues",
            "technical": "Bugs or integration problems",
            "sales": "Pricing or account questions",
        },
    },
    "frustration": {
        "type": "score",
        "instructions": "How frustrated does the customer appear?",
        "criteria": {
            "0": "Calm, just stating facts",
            "1": "Frustrated but civil",
            "2": "Very angry, strong language",
        },
    },
    "is_urgent": {
        "type": "noul",
        "instructions": "Does the message convey urgency or time-sensitivity?",
    },
}


def _normalize_base(url: str) -> str:
    """Accept a base with or without a trailing /v1; always return one without."""
    url = url.rstrip("/")
    return url[:-3] if url.endswith("/v1") else url


def via_sdk() -> None:
    """Official Python SDK -> api.typesafe.ai/v1/systemone directly."""
    from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

    client = TypeSafeClient()
    response = client.system_one(
        state=STATE,
        questions={
            "department": Choice(
                instructions="Which team should handle this ticket?",
                criteria={
                    "billing": "Payment or subscription issues",
                    "technical": "Bugs or integration problems",
                    "sales": "Pricing or account questions",
                },
            ),
            "frustration": Score(
                instructions="How frustrated does the customer appear?",
                criteria=[
                    "Calm, just stating facts",
                    "Frustrated but civil",
                    "Very angry, strong language",
                ],
            ),
            "is_urgent": Noul(
                instructions="The message conveys urgency or time-sensitivity",
            ),
        },
    )
    print("== via official SDK (direct) ==")
    print("department :", response.answers["department"].choice)
    print("frustration:", response.answers["frustration"].score)
    print("is_urgent  :", response.answers["is_urgent"].noul)
    print()


def via_bridge() -> None:
    """OpenAI-style call -> this bridge -> TypeSafe /v1/systemone."""
    base = _normalize_base(BRIDGE_URL)
    body = json.dumps(
        {
            "model": "typesafe/jev-latest",
            "messages": [{"role": "user", "content": STATE}],
            "questions": QUESTIONS,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-typesafe-bridge",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    answers = (data.get("typesafe") or {}).get("answers") or {}
    if not answers:
        raise RuntimeError(f"bridge returned no typed answers: {json.dumps(data)[:200]}")
    print("== via bridge (direct, no router) ==")
    for qid, ans in answers.items():
        if ans.get("type") == "noul":
            print(f"{qid:12}: {ans['noul']}")
        elif ans.get("type") == "choice":
            print(f"{qid:12}: {ans['choice']} (confidence {ans.get('confidence')})")
        else:
            print(f"{qid:12}: {ans.get('score')} (confidence {ans.get('confidence')})")
    print()


def via_9router() -> None:
    """OpenAI-style call -> 9Router -> this bridge -> TypeSafe /v1/systemone."""
    base = _normalize_base(os.environ.get("ROUTER_9_BASE_URL", "http://127.0.0.1:20128"))
    key = os.environ.get("ROUTER_9_API_KEY")
    model = os.environ.get("ROUTER_9_MODEL")
    if not key or not model:
        print(
            "== via 9Router skipped (set ROUTER_9_API_KEY and ROUTER_9_MODEL "
            "to your router's client key and chat model) =="
        )
        return
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": STATE}],
            "questions": QUESTIONS,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    print("== via 9Router -> bridge -> TypeSafe ==")
    print(data["choices"][0]["message"]["content"])
    if data.get("usage"):
        print("usage:", data["usage"])


if __name__ == "__main__":
    if not os.environ.get("TYPESAFE_API_KEY"):
        sys.exit("TYPESAFE_API_KEY is not set. Get a key at console.typesafe.ai/settings/keys")

    failures = 0

    try:
        via_sdk()
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"SDK call failed: {exc}\n", file=sys.stderr)

    try:
        via_bridge()
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"Bridge call failed (is the bridge running? node bridge.js): {exc}", file=sys.stderr)

    try:
        via_9router()
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"9Router call failed (is the router running? is the key set?): {exc}", file=sys.stderr)

    sys.exit(1 if failures else 0)
