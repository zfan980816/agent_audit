"""Rule registry. all_rules() MUST return fresh instances (E005 holds state)."""
from __future__ import annotations

from agentaudit.rules.base import Rule
from agentaudit.rules.bypass import rules as _bypass
from agentaudit.rules.credentials import rules as _credentials
from agentaudit.rules.destructive import rules as _destructive
from agentaudit.rules.exfiltration import rules as _exfiltration
from agentaudit.rules.unsafe import rules as _unsafe

CATEGORY_TITLES = {
    "D": "Destructive operations",
    "C": "Credential access",
    "E": "Data exfiltration",
    "B": "Bypass & persistence",
    "U": "Unsafe execution",
}


def all_rules() -> list[Rule]:
    return [
        *_destructive(),
        *_credentials(),
        *_exfiltration(),
        *_bypass(),
        *_unsafe(),
    ]
