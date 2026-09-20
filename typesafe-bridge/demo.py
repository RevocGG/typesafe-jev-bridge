"""
TypeSafe Jev demo — two ways to call it once your API key is set.

Setup (Windows PowerShell):
    .\\.venv\\Scripts\\activate
    $env:TYPESAFE_API_KEY = "ts_live_..."   # from console.typesafe.ai/settings/keys
    python demo.py

Run 1 uses the official SDK directly (no 9Router needed).
Run 2 goes through 9Router → the local bridge → TypeSafe, exactly like your
coding tools will once the provider is configured in the 9Router dashboard.
"""

import json
import os
import sys
import urllib.request

BRIDGE_URL = os.environ.get("TYPESAFE_BRIDGE_URL", "http://127.0.0.1:8399")
STATE = (
    "Hi, I've been trying to connect my Stripe account for 3 days and it keeps "
    "failing. I'm losing sales. Please help ASAP."
)


def via_sdk() -> None:
    """Official Python SDK → api.typesafe.ai/v1/systemone directly."""
    from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

    client = TypeSafeClient()
    response = client.system_one(
        state=STATE,
        questions={
            "department": Choice(
                instructions="Which team should handle this",
                criteria={
                    "billing": "Payment or subscription issues",
                    "technical": "Bugs or integration problems",
                    "sales": "Pricing or account questions",
                },
            ),
            "frustration": Score(
                instructions="How frustrated the customer appears",
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


def via_9router() -> None:
    """OpenAI-style call → 9Router → bridge → TypeSafe /v1/systemone."""
    base = os.environ.get("ROUTER_9_BASE_URL", "http://127.0.0.1:20128/v1")
    key = os.environ.get("ROUTER_9_API_KEY")
    if not key:
        print("== via 9Router skipped (set ROUTER_9_API_KEY to your 9Router client key from the dashboard) ==")
        return
    body = json.dumps(
        {
            "model": "typesafe/jev-latest",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Classify the support ticket. Return JSON with keys: "
                        "department, is_urgent"
                    ),
                },
                {"role": "user", "content": STATE},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read())
    print("== via 9Router → bridge → TypeSafe ==")
    print(data["choices"][0]["message"]["content"])
    if data.get("usage"):
        print("usage:", data["usage"])


if __name__ == "__main__":
    if not os.environ.get("TYPESAFE_API_KEY"):
        sys.exit("TYPESAFE_API_KEY is not set. Get a key at console.typesafe.ai/settings/keys")
    try:
        via_sdk()
    except Exception as exc:  # noqa: BLE001
        print(f"SDK call failed: {exc}\n", file=sys.stderr)
    try:
        via_9router()
    except Exception as exc:  # noqa: BLE001
        print(f"9Router call failed (is the bridge running? is the provider configured?): {exc}", file=sys.stderr)
        sys.exit(1)
