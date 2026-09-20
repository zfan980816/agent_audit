"""Report rendering: terminal (rich), JSON dict, share card."""
from __future__ import annotations

import re
from collections import Counter

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from agentaudit.engine import AuditResult
from agentaudit.events import SEVERITY_ORDER, Severity
from agentaudit.rules.base import Finding

SEV_LABEL = {
    Severity.CRITICAL: "CRITICAL",
    Severity.HIGH: "HIGH",
    Severity.MEDIUM: "MEDIUM",
    Severity.LOW: "LOW",
    Severity.INFO: "INFO",
}
SEV_STYLE = {
    Severity.CRITICAL: "bold white on red",
    Severity.HIGH: "bold red",
    Severity.MEDIUM: "yellow",
    Severity.LOW: "cyan",
    Severity.INFO: "dim",
}
_SEV_ORDERED = list(reversed(SEVERITY_ORDER))  # critical -> info


def severity_counts(findings: list[Finding]) -> Counter[Severity]:
    counts: Counter[Severity] = Counter(f.severity for f in findings)
    for sev in SEVERITY_ORDER:
        counts.setdefault(sev, 0)
    return counts


def filter_by_severity(findings: list[Finding], floor: Severity) -> list[Finding]:
    floor_idx = SEVERITY_ORDER.index(floor)
    return [f for f in findings if SEVERITY_ORDER.index(f.severity) >= floor_idx]


def _short_project(project: str) -> str:
    return re.split(r"[\\/]", project.replace("\\\\", "\\"))[-1] or project


def _short_ts(f: Finding) -> str:
    ts = f.event.timestamp
    return ts.strftime("%m-%d %H:%M") if ts else "-"


def render_terminal(result: AuditResult, floor: Severity = Severity.LOW,
                    console: Console | None = None) -> None:
    console = console or Console()
    findings = filter_by_severity(result.findings, floor)
    counts = severity_counts(findings)
    sev_line = "  ".join(
        f"[{SEV_STYLE[sev]}] {counts[sev]} {SEV_LABEL[sev]}[/{SEV_STYLE[sev]}]"
        for sev in _SEV_ORDERED
    )
    summary = (
        f"files {result.files_scanned} · sessions {len(result.sessions)} · "
        f"events {result.events} · findings {len(findings)}\n{sev_line}"
    )
    console.print(Panel(summary, title="agentaudit", expand=False))

    table = Table(show_lines=False, expand=True)
    for col, ratio in (("SEV", 8), ("RULE", 6), ("FINDING", 30),
                       ("PROJECT", 16), ("SESSION", 10), ("WHEN", 11), ("EVIDENCE", 40)):
        table.add_column(col, ratio=ratio, overflow="fold")
    for f in findings[:200]:
        # Text() around history-controlled cells: plain str cells are parsed as
        # rich markup, so evidence like "awk [/etc/passwd] x" would crash or
        # silently drop text (MarkupError on stray [/...] tags)
        table.add_row(
            SEV_LABEL[f.severity], f.rule_id, f.title,
            Text(_short_project(f.event.project)), Text(f.event.session_id[:8]),
            _short_ts(f), Text(f.evidence),
        )
    console.print(table)

    if result.lines_skipped:
        console.print(f"[dim]skipped {result.lines_skipped} malformed lines[/dim]")
    if result.files_failed:
        console.print(f"[yellow]failed to read {result.files_failed} file(s)[/yellow]")
    if len(findings) > 200:
        console.print(f"[dim]showing first 200 of {len(findings)} findings[/dim]")


def to_dict(result: AuditResult) -> dict:
    counts = severity_counts(result.findings)
    return {
        "summary": {
            "files": result.files_scanned,
            "files_failed": result.files_failed,
            "sessions": len(result.sessions),
            "events": result.events,
            "lines_skipped": result.lines_skipped,
            "total": len(result.findings),
            "by_severity": {sev.value: counts[sev] for sev in _SEV_ORDERED},
        },
        "findings": [
            {
                "rule_id": f.rule_id,
                "severity": f.severity.value,
                "title": f.title,
                "evidence": f.evidence,
                "project": f.event.project,
                "session_id": f.event.session_id,
                "timestamp": f.event.timestamp.isoformat() if f.event.timestamp else None,
                "explanation": f.explanation,
                "recommendation": f.recommendation,
            }
            for f in result.findings
        ],
    }


def share_card(result: AuditResult) -> str:
    counts = severity_counts(result.findings)
    stats = " · ".join(
        f"{SEV_LABEL[sev]} {counts[sev]}" for sev in _SEV_ORDERED if counts[sev]
    ) or "no findings"
    return (
        "──── agent-audit · AI agent safety report ────\n"
        f"Sessions: {len(result.sessions)}   {stats}\n"
        "Audit your own agents → npx agent-audit"
    )
