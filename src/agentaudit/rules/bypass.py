"""B: permission bypass and persistence."""
from __future__ import annotations

import re

from agentaudit.events import Event, FileWrite, Severity, ShellCommand, path_basename
from agentaudit.rules.base import Finding, RegexRule, Rule


class B001(Rule):
    id = "B001"
    severity = Severity.CRITICAL
    title = "Loosened Claude Code permissions"
    explanation = "settings.json allow-list was widened to powerful tools or wildcards."
    recommendation = "Revert the permission change; audit what ran while it was active."
    applies_to = (FileWrite,)

    _name_re = re.compile(r"^settings(\.local)?\.json$", re.IGNORECASE)
    # middle spans capped {0,2000}: adversarial repeated anchors stay linear (ReDoS hardening)
    _danger_re = re.compile(r'"allow"\s*:\s*\[[^\]]{0,2000}"(Bash|Edit|Write|WebFetch|\*)', re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if not isinstance(event, FileWrite):
            return None
        if not self._name_re.match(path_basename(event.path)):
            return None
        if not event.content or not self._danger_re.search(event.content):
            return None
        return Finding(rule_id=self.id, severity=self.severity, title=self.title, event=event,
                       evidence=event.path[:200], explanation=self.explanation,
                       recommendation=self.recommendation)


class B002(Rule):
    id = "B002"
    severity = Severity.HIGH
    title = "Disabled safety mechanisms"
    explanation = "Bypass-permission flags or empty hooks disable the agent's safety net."
    recommendation = "Re-enable permissions/hooks; review actions taken while disabled."
    applies_to = (ShellCommand, FileWrite)

    _shell_re = re.compile(
        r"--dangerously-skip-permissions|--yolo\b"
        r"|claude\s+config\s+set\b[^|;&\n]{0,400}(bypassPermissions|allowedTools)", re.IGNORECASE)
    _file_re = re.compile(
        r'"defaultMode"\s*:\s*"bypassPermissions"|"hooks"\s*:\s*\{\s*\}', re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if isinstance(event, ShellCommand):
            m = self._shell_re.search(event.raw)
            evidence = m.group(0) if m else None
        elif isinstance(event, FileWrite):
            if not path_basename(event.path).startswith("settings"):
                return None
            m = self._file_re.search(event.content or "")
            evidence = event.path if m else None
        else:
            return None
        if not evidence:
            return None
        return Finding(rule_id=self.id, severity=self.severity, title=self.title, event=event,
                       evidence=evidence[:200], explanation=self.explanation,
                       recommendation=self.recommendation)


class B003(Rule):
    id = "B003"
    severity = Severity.HIGH
    title = "Shell profile modification"
    explanation = "Writing to shell RC files persists commands that run on every new shell."
    recommendation = "Inspect the written content; remove unknown lines."
    applies_to = (ShellCommand, FileWrite)

    # NOTE: `[\w./\\~-]*` (DEVIATION from the plan's `\S*`): `\S*` also consumes
    # `>` characters, so on a `>`-heavy command (e.g. 20k `>` chars) every position
    # rescans the whole tail — 3.2s quadratic blowup, same class as the C002/E005
    # findings. A redirect-target path-char class cannot cross whitespace or `>`,
    # keeping the scan linear (3.3ms) while still matching `>> ~/.bashrc`.
    # Trade-off: quoted targets (`>> "$HOME/.bashrc"`) no longer match the shell
    # channel; the FileWrite channel still catches the actual write.
    _shell_re = re.compile(
        r"(>>|>)\s*[\w./\\~-]*(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile)\b"
        r"|Add-Content\s+\$PROFILE|Out-File\s+\$PROFILE", re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if isinstance(event, ShellCommand):
            m = self._shell_re.search(event.raw)
            if not m:
                return None
            evidence = m.group(0)
        elif isinstance(event, FileWrite):
            if path_basename(event.path) not in {
                ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
                "Microsoft.PowerShell_profile.ps1",
            }:
                return None
            evidence = event.path
        else:
            return None
        return Finding(rule_id=self.id, severity=self.severity, title=self.title, event=event,
                       evidence=evidence[:200], explanation=self.explanation,
                       recommendation=self.recommendation)


class B004(Rule):
    id = "B004"
    severity = Severity.CRITICAL
    title = "System persistence installed"
    explanation = "Cron/systemd/LaunchAgent/registry-run entries execute at boot or on schedule."
    recommendation = "Remove the persistence entry and inspect what it executes."
    applies_to = (ShellCommand, FileWrite)

    # NOTE: `\\(Run|RunOnce)\b` (DEVIATION from the plan's `\\(Run|RunOnce)\\`):
    # the plan's trailing `\\` required a backslash AFTER the Run key, but real
    # commands end the key path there ("...\CurrentVersion\Run /v x /d y"), so the
    # planned pattern missed its own planned test case. `\b` matches both
    # "...\Run /v" and "...\RunOnce\x" and still rejects "reg add HKCU\Software\Other".
    _shell_re = re.compile(
        r"crontab\s+(-e|-r|--edit|--remove)\b"
        r"|systemctl\s+(enable|start)\b"
        r"|launchctl\s+(load|bootstrap)\b"
        r"|schtasks\s+/create\b"
        r"|reg\s+add\b[^|;&\n]{0,400}\\(Run|RunOnce)\b"
        r"|\bsc\s+create\b", re.IGNORECASE)
    _file_re = re.compile(r"LaunchAgents|/etc/cron\.|systemd/system", re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if isinstance(event, ShellCommand):
            m = self._shell_re.search(event.raw)
            if not m:
                return None
            evidence = m.group(0)
        elif isinstance(event, FileWrite):
            if not self._file_re.search(event.path):
                return None
            evidence = event.path
        else:
            return None
        return Finding(rule_id=self.id, severity=self.severity, title=self.title, event=event,
                       evidence=evidence[:200], explanation=self.explanation,
                       recommendation=self.recommendation)


class B005(Rule):
    id = "B005"
    severity = Severity.CRITICAL
    title = "authorized_keys modified"
    explanation = "New SSH authorized keys grant remote login access."
    recommendation = "Remove unrecognized keys; rotate if the machine is exposed."
    applies_to = (ShellCommand, FileWrite)

    # NOTE: `[\w./\\~-]*` instead of the plan's `\S*` — see B003 (quadratic on
    # `>`-heavy commands); still matches `>> ~/.ssh/authorized_keys` and
    # `tee -a ~/.ssh/authorized_keys`.
    _shell_re = re.compile(
        r"(>>?|tee\s+-a)\s*[\w./\\~-]*authorized_keys"
        r"|ssh-keygen[^|;&\n]{0,400}\|\s*(tee|cat)\b", re.IGNORECASE)

    def check(self, event: Event) -> Finding | None:
        if isinstance(event, ShellCommand):
            m = self._shell_re.search(event.raw)
            if not m:
                return None
            evidence = m.group(0)
        elif isinstance(event, FileWrite):
            if path_basename(event.path) != "authorized_keys":
                return None
            evidence = event.path
        else:
            return None
        return Finding(rule_id=self.id, severity=self.severity, title=self.title, event=event,
                       evidence=evidence[:200], explanation=self.explanation,
                       recommendation=self.recommendation)


class B006(RegexRule):
    id = "B006"
    severity = Severity.MEDIUM
    title = "Privilege escalation via sudo"
    explanation = "Commands ran as root; blast radius of any mistake or injection is the whole machine."
    recommendation = "Check each sudo invocation was justified."
    # v0.1.1: prefix class also admits " ' / so `/usr/bin/sudo x` and
    # `sh -c "sudo x"` forms are caught (word-start sudo only, sudoedit safe)
    pattern = r"(^|[\s;&|(\"'/])sudo\s|Start-Process\b[^|;&\n]{0,400}-Verb\s+RunAs"


def rules() -> list[Rule]:
    return [B001(), B002(), B003(), B004(), B005(), B006()]
