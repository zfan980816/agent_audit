"""D: destructive operations."""
from __future__ import annotations

from agentaudit.events import Severity
from agentaudit.rules.base import RegexRule, Rule


class D001(RegexRule):
    id = "D001"
    severity = Severity.CRITICAL
    title = "Recursive force delete"
    explanation = "Recursive force deletion can wipe entire directory trees beyond recovery."
    recommendation = "Confirm the deleted path scope; restore from VCS/backup if unintended."
    pattern = (
        r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b"
        r"|\brd\s+/s\s+/q\b"
        r"|\bdel\s+(/q\s+/s\b|/s\s+/q\b)"
        r"|Remove-Item\b[^|;&\n]*-Recurse\b[^|;&\n]*-Force"
        r"|Remove-Item\b[^|;&\n]*-Force\b[^|;&\n]*-Recurse"
    )


class D002(RegexRule):
    id = "D002"
    severity = Severity.HIGH
    title = "Destructive git operation"
    explanation = "Hard resets, force pushes and clean can silently discard committed or uncommitted work."
    recommendation = "Check reflog; force-push only with explicit user intent."
    pattern = (
        r"git\s+reset\s+--hard\b"
        r"|git\s+clean\s+-\w*f"
        r"|git\s+push\b[^|;&\n]*(--force\b|--force-with-lease\b|\s-f\b)"
        r"|git\s+reflog\s+expire\b"
    )


class D003(RegexRule):
    id = "D003"
    severity = Severity.MEDIUM
    title = "World-writable permissions (chmod 777)"
    explanation = "chmod 777 makes files writable by every user on the machine."
    recommendation = "Use the narrowest permission set that works."
    pattern = r"chmod\s+(-R\s+)?777\b"


class D004(RegexRule):
    id = "D004"
    severity = Severity.CRITICAL
    title = "Disk-level write/erase"
    explanation = "Raw device writes and filesystem formatting destroy all data on the target disk."
    recommendation = "Verify the target device; recover from backup if unintended."
    pattern = (
        r"\bdd\b[^|;&\n]*of=/dev/\w+"
        r"|\bmkfs(\.\w+)?\b"
        r"|diskutil\s+erase\w*"
        r"|\bformat\s+[a-zA-Z]:(\s|$)"
    )


class D005(RegexRule):
    id = "D005"
    severity = Severity.HIGH
    title = "System-level destructive action"
    explanation = "Pruning all docker resources or killing system processes can take down unrelated services."
    recommendation = "Scope the operation to named resources only."
    pattern = (
        r"docker\s+system\s+prune\b[^|;&\n]*(--volumes|--all|\s-a\b)"
        r"|killall\s+\w+"
        r"|taskkill\b[^|;&\n]*\s/im\b[^|;&\n]*(explorer|svchost|csrss|wininit)"
    )


def rules() -> list[Rule]:
    return [D001(), D002(), D003(), D004(), D005()]
