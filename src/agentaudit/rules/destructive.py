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
    # NOTE: "rm" intentionally has no leading \b so compound commands like
    # "git rm -rf" still hit.
    # middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
    pattern = (
        # flag cluster containing both r and f (no trailing \b: -rfi etc. still hit)
        r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)"
        # separated flags: rm -r ... -f (either order), long flags included
        r"|rm\b[^|;&\n]{0,400}\s-r[a-zA-Z]*\b[^|;&\n]{0,400}\s-f[a-zA-Z]*\b"
        r"|rm\b[^|;&\n]{0,400}\s-f[a-zA-Z]*\b[^|;&\n]{0,400}\s-r[a-zA-Z]*\b"
        r"|rm\b[^|;&\n]{0,400}--recursive\b[^|;&\n]{0,400}--force\b"
        r"|rm\b[^|;&\n]{0,400}--force\b[^|;&\n]{0,400}--recursive\b"
        r"|\brd\s+/s\s+/q\b"
        # /s and /q anywhere in the del command (any flag order/prefix)
        r"|\bdel\b[^|;&\n]{0,400}/s\b[^|;&\n]{0,400}/q\b"
        r"|\bdel\b[^|;&\n]{0,400}/q\b[^|;&\n]{0,400}/s\b"
        r"|Remove-Item\b[^|;&\n]{0,400}-Recurse\b[^|;&\n]{0,400}-Force"
        r"|Remove-Item\b[^|;&\n]{0,400}-Force\b[^|;&\n]{0,400}-Recurse"
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
        r"|git\s+push\b[^|;&\n]{0,400}(\s--force\b|\s--force-with-lease\b|\s-[a-z]*f[a-z]*\b)"
        r"|git\s+reflog\s+expire\b"
    )


class D003(RegexRule):
    id = "D003"
    severity = Severity.MEDIUM
    title = "World-writable permissions (chmod 777)"
    explanation = "chmod 777 makes files writable by every user on the machine."
    recommendation = "Use the narrowest permission set that works."
    pattern = r"chmod\s+(-R\s+)?0?777\b"


class D004(RegexRule):
    id = "D004"
    severity = Severity.CRITICAL
    title = "Disk-level write/erase"
    explanation = "Raw device writes and filesystem formatting destroy all data on the target disk."
    recommendation = "Verify the target device; recover from backup if unintended."
    pattern = (
        r"\bdd\b[^|;&\n]{0,400}of=/dev/\w+"
        r"|\bmkfs(\.\w+)?\b"
        r"|diskutil\s+erase\w*"
        r"|\bformat\s+[a-zA-Z]:(\s|$|;)"
    )


class D005(RegexRule):
    id = "D005"
    severity = Severity.HIGH
    title = "System-level destructive action"
    explanation = "Pruning all docker resources or killing system processes can take down unrelated services."
    recommendation = "Scope the operation to named resources only."
    pattern = (
        r"docker\s+system\s+prune\b[^|;&\n]{0,400}(\s--volumes\b|\s--all\b|\s-[a-z]*a[a-z]*\b)"
        r"|killall\s+\w+"
        r"|taskkill\b[^|;&\n]{0,400}\s/im\b[^|;&\n]{0,400}(explorer|svchost|csrss|wininit)"
    )


def rules() -> list[Rule]:
    return [D001(), D002(), D003(), D004(), D005()]
