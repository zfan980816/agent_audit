"""E: data exfiltration patterns."""
from __future__ import annotations

import re

from agentaudit.events import Event, Severity, ShellCommand
from agentaudit.rules.base import Finding, RegexRule, Rule


class E001(RegexRule):
    id = "E001"
    severity = Severity.CRITICAL
    title = "Pipe/upload secrets to network"
    explanation = "Secret file contents are sent to a remote endpoint."
    recommendation = "Treat the secret as compromised; rotate and block the destination."
    # NOTE: `-d\s*@` (DEVIATION from the plan's `-d\s+@`): curl accepts the
    # attached form `-d@file` with no space, which `\s+` missed.
    pattern = (
        r"(\bcat|\btype)\b[^|;&\n]*(id_rsa|\.pem\b|\.env\b|\.key\b)[^|;&\n]*\|[^|;&\n]*(curl|wget)"
        r"|(curl|wget)\b[^|;&\n]*(--data\b|-d)\s*@"
        r"|(curl|wget)\b[^|;&\n]*-F\b[^|;&\n]*file=@"
    )


class E002(RegexRule):
    id = "E002"
    severity = Severity.CRITICAL
    title = "Command-substitution exfiltration"
    explanation = "Command substitution $(cat <secret>) inlines secret contents into another command."
    recommendation = "Treat the secret as compromised; rotate it."
    pattern = r"\$\(\s*(cat|type)\s+[^)\n]*(id_rsa|\.pem\b|\.env\b|\.key\b)"


class E003(RegexRule):
    id = "E003"
    severity = Severity.CRITICAL
    title = "Upload to paste site / webhook"
    explanation = "Paste services and chat webhooks are common exfiltration destinations."
    recommendation = "Delete the paste/webhook message; rotate anything it contained."
    pattern = (
        r"pastebin\.com|transfer\.sh|0x0\.st|paste\.ee"
        r"|discord(?:app)?\.com/api/webhooks"
        r"|api\.telegram\.org/bot"
    )


class E004(RegexRule):
    id = "E004"
    severity = Severity.HIGH
    title = "Add git remote"
    explanation = "A newly added remote is a potential push destination for source code."
    recommendation = "Verify the remote URL is trusted before pushing anything."
    pattern = r"git\s+remote\s+add\b"


_ARCHIVE_CREATE_RE = re.compile(r"zip\s+-\w*r|tar\s+-\w*c\w*f|Compress-Archive", re.IGNORECASE)
# NOTE: DEVIATION from the plan's `(\S+\.(?:zip|...))`: an unanchored `\S+` is a
# start candidate at every position and backtracks the whole token per position —
# quadratic on long commands (619ms on a 20k dot-free token). Same fix as the
# accepted C002 change: a \b prefix + path-char class keeps the scan linear
# (0.3ms) and still matches relative paths like ./builds/proj.zip.
_ARCHIVE_NAME_RE = re.compile(r"(\b[\w./\\-]+\.(?:zip|tar\.gz|tgz|tar|7z))(?:\s|$|[;&|])", re.IGNORECASE)
_UPLOAD_CMD_RE = re.compile(r"\b(curl|wget|scp|sftp)\b", re.IGNORECASE)


class E005(Rule):
    """Stateful: remembers the most recent archive artifact per session.

    The engine constructs fresh rule instances per run (all_rules() factory),
    so this dict never outlives one scan.
    """

    id = "E005"
    severity = Severity.MEDIUM
    title = "Archive-then-upload pattern"
    explanation = "A directory was archived and the archive was immediately uploaded within the same session."
    recommendation = "Confirm the upload destination is authorized for this codebase."
    applies_to = (ShellCommand,)

    def __init__(self) -> None:
        self._last_archive: dict[str, str] = {}

    def check(self, event: Event) -> Finding | None:
        if not isinstance(event, ShellCommand) or not event.raw:
            return None
        m = _ARCHIVE_NAME_RE.search(event.raw)
        if m and _ARCHIVE_CREATE_RE.search(event.raw):
            self._last_archive[event.session_id] = m.group(1)
            return None
        if _UPLOAD_CMD_RE.search(event.raw):
            target = self._last_archive.get(event.session_id)
            if target and target in event.raw:
                self._last_archive.pop(event.session_id, None)
                return Finding(
                    rule_id=self.id, severity=self.severity, title=self.title, event=event,
                    evidence=event.raw[:200], explanation=self.explanation,
                    recommendation=self.recommendation,
                )
        return None


def rules() -> list[Rule]:
    return [E001(), E002(), E003(), E004(), E005()]
