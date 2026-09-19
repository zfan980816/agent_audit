"""Rule contract: a rule turns events into findings."""
from __future__ import annotations

import re
from dataclasses import dataclass

from agentaudit.events import Event, FileWrite, McpToolCall, NetworkRequest, Severity, ShellCommand


@dataclass
class Finding:
    rule_id: str
    severity: Severity
    title: str
    event: Event
    evidence: str
    explanation: str
    recommendation: str


def evidence_of(event: Event) -> str:
    if isinstance(event, ShellCommand):
        return event.raw
    if isinstance(event, FileWrite):
        return event.path
    if isinstance(event, NetworkRequest):
        return event.url
    if isinstance(event, McpToolCall):
        return f"{event.server}::{event.tool} {event.args_hint}"
    return ""


class Rule:
    id: str = "?"
    severity: Severity = Severity.LOW
    title: str = ""
    explanation: str = ""
    recommendation: str = ""
    applies_to: tuple[type[Event], ...] = (ShellCommand,)

    def check(self, event: Event) -> Finding | None:
        raise NotImplementedError


class RegexRule(Rule):
    """Matches a case-insensitive regex against the event's evidence text."""

    pattern: str = ""

    def __init__(self) -> None:
        self._re = re.compile(self.pattern, re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if not isinstance(event, self.applies_to):
            return None
        text = evidence_of(event)
        if not text:
            return None
        m = self._re.search(text)
        if not m:
            return None
        return Finding(
            rule_id=self.id, severity=self.severity, title=self.title, event=event,
            evidence=m.group(0)[:200], explanation=self.explanation,
            recommendation=self.recommendation,
        )
