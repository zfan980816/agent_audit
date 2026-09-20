"""Pipeline engine: files -> events -> findings."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from agentaudit.events import SEVERITY_ORDER
from agentaudit.parsers.claude_code import ParseStats, iter_events
from agentaudit.rules import all_rules
from agentaudit.rules.base import Finding


@dataclass
class AuditResult:
    findings: list[Finding] = field(default_factory=list)
    files_scanned: int = 0
    files_failed: int = 0
    lines_total: int = 0
    lines_skipped: int = 0
    events: int = 0
    sessions: set[str] = field(default_factory=set)


def run_audit(files: Iterable[Path], rule_prefixes: set[str] | None = None,
              session_id: str | None = None) -> AuditResult:
    rules = [r for r in all_rules()
             if rule_prefixes is None or r.id[0] in rule_prefixes]
    result = AuditResult()
    stats = ParseStats()
    for path in files:
        result.files_scanned += 1
        try:
            event_iter = iter_events(path, stats)
            for event in event_iter:
                if session_id is not None and event.session_id != session_id:
                    continue
                result.sessions.add(event.session_id)
                for rule in rules:
                    if not isinstance(event, rule.applies_to):
                        continue
                    finding = rule.check(event)
                    if finding is not None:
                        result.findings.append(finding)
        except OSError:
            # unreadable file (deleted mid-run, AV/indexer lock, permissions):
            # count loudly instead of aborting the whole audit
            result.files_failed += 1
    result.lines_total = stats.lines_total
    result.lines_skipped = stats.lines_skipped
    result.events = stats.events
    result.findings.sort(key=lambda f: -SEVERITY_ORDER.index(f.severity))
    return result
