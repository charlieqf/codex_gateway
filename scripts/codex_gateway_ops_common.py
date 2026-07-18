from __future__ import annotations

import re


DEFAULT_REMOTE_REPO = "/home/qian/codex-gateway-release-4e61f98-20260511T230214Z"

_SECRET_PATTERNS = [
    (re.compile(r"cgu_live_[A-Za-z0-9]{20,}"), "cgu_live_<redacted>"),
    (re.compile(r"cgw\.[A-Za-z0-9._-]+"), "cgw.<redacted>"),
    (re.compile(r"mev2_live_[A-Za-z0-9._-]+"), "mev2_live_<redacted>"),
    (re.compile(r"bat_(?:test|live)_[A-Za-z0-9._-]+"), "bat_<redacted>"),
    (
        re.compile(r"Bearer\s+[A-Za-z0-9._=-]+", re.IGNORECASE),
        "Bearer <redacted>",
    ),
]


def redact_secrets(value: str) -> str:
    redacted = value
    for pattern, replacement in _SECRET_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted
