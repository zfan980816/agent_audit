// Ported 1:1 from src/agentaudit/rules/bypass.py (Python implementation is the spec).
// Patterns use String.raw so they stay character-for-character identical to the
// Python raw strings; adjacent String.raw`` segments concatenate exactly like
// the adjacent string literals in the .py file.
// Python keeps these as class-level `re.compile` attributes; here they are
// module-level RegExp consts, grouped right above the class that uses them.
import {
  FileWrite,
  ShellCommand,
  pathBasename,
  type Event,
  type Severity,
} from "../events.js";
import { type Finding, RegexRule, Rule } from "./base.js";

const B001_NAME_RE = new RegExp(String.raw`^settings(\.local)?\.json$`, "i");
// middle spans capped {0,2000}: adversarial repeated anchors stay linear (ReDoS hardening)
const B001_DANGER_RE = new RegExp(
  String.raw`"allow"\s*:\s*\[[^\]]{0,2000}"(Bash|Edit|Write|WebFetch|\*)`,
  "i",
);

export class B001 extends Rule {
  id = "B001";
  severity: Severity = "critical";
  title = "Loosened Claude Code permissions";
  explanation = "settings.json allow-list was widened to powerful tools or wildcards.";
  recommendation = "Revert the permission change; audit what ran while it was active.";
  appliesTo = [FileWrite];

  override check(event: Event): Finding | null {
    if (!(event instanceof FileWrite)) {
      return null;
    }
    // (JS `$` here anchors strictly at end-of-string; Python's would also take a
    // trailing "\n" — impossible for a basename, so no behavioral difference.)
    if (!B001_NAME_RE.test(pathBasename(event.path))) {
      return null;
    }
    if (!event.content || !B001_DANGER_RE.test(event.content)) {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: event.path.slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}

const B002_SHELL_RE = new RegExp(
  String.raw`--dangerously-skip-permissions|--yolo\b` +
    String.raw`|claude\s+config\s+set\b[^|;&\n]{0,400}(bypassPermissions|allowedTools)`,
  "i",
);
const B002_FILE_RE = new RegExp(
  String.raw`"defaultMode"\s*:\s*"bypassPermissions"|"hooks"\s*:\s*\{\s*\}`,
  "i",
);

export class B002 extends Rule {
  id = "B002";
  severity: Severity = "high";
  title = "Disabled safety mechanisms";
  explanation = "Bypass-permission flags or empty hooks disable the agent's safety net.";
  recommendation = "Re-enable permissions/hooks; review actions taken while disabled.";
  appliesTo = [ShellCommand, FileWrite];

  override check(event: Event): Finding | null {
    let evidence: string | null;
    if (event instanceof ShellCommand) {
      const m = B002_SHELL_RE.exec(event.raw);
      evidence = m ? m[0] : null;
    } else if (event instanceof FileWrite) {
      if (!pathBasename(event.path).startsWith("settings")) {
        return null;
      }
      evidence = B002_FILE_RE.test(event.content ?? "") ? event.path : null;
    } else {
      return null;
    }
    if (!evidence) {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: evidence.slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}

// NOTE: `[\w./\\~-]*` (DEVIATION from the plan's `\S*`): `\S*` also consumes
// `>` characters, so on a `>`-heavy command (e.g. 20k `>` chars) every position
// rescans the whole tail — 3.2s quadratic blowup, same class as the C002/E005
// findings. A redirect-target path-char class cannot cross whitespace or `>`,
// keeping the scan linear (3.3ms) while still matching `>> ~/.bashrc`.
// Trade-off: quoted targets (`>> "$HOME/.bashrc"`) no longer match the shell
// channel; the FileWrite channel still catches the actual write.
const B003_SHELL_RE = new RegExp(
  String.raw`(>>|>)\s*[\w./\\~-]*(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile)\b` +
    String.raw`|Add-Content\s+\$PROFILE|Out-File\s+\$PROFILE`,
  "i",
);

const B003_RC_NAMES: ReadonlySet<string> = new Set([
  ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
  "Microsoft.PowerShell_profile.ps1",
]);

export class B003 extends Rule {
  id = "B003";
  severity: Severity = "high";
  title = "Shell profile modification";
  explanation = "Writing to shell RC files persists commands that run on every new shell.";
  recommendation = "Inspect the written content; remove unknown lines.";
  appliesTo = [ShellCommand, FileWrite];

  override check(event: Event): Finding | null {
    let evidence: string;
    if (event instanceof ShellCommand) {
      const m = B003_SHELL_RE.exec(event.raw);
      if (!m) {
        return null;
      }
      evidence = m[0];
    } else if (event instanceof FileWrite) {
      if (!B003_RC_NAMES.has(pathBasename(event.path))) {
        return null;
      }
      evidence = event.path;
    } else {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: evidence.slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}

// NOTE: `\\(Run|RunOnce)\b` (DEVIATION from the plan's `\\(Run|RunOnce)\\`):
// the plan's trailing `\\` required a backslash AFTER the Run key, but real
// commands end the key path there ("...\CurrentVersion\Run /v x /d y"), so the
// planned pattern missed its own planned test case. `\b` matches both
// "...\Run /v" and "...\RunOnce\x" and still rejects "reg add HKCU\Software\Other".
const B004_SHELL_RE = new RegExp(
  String.raw`crontab\s+(-e|-r|--edit|--remove)\b` +
    String.raw`|systemctl\s+(enable|start)\b` +
    String.raw`|launchctl\s+(load|bootstrap)\b` +
    String.raw`|schtasks\s+/create\b` +
    String.raw`|reg\s+add\b[^|;&\n]{0,400}\\(Run|RunOnce)\b` +
    String.raw`|\bsc\s+create\b`,
  "i",
);
const B004_FILE_RE = new RegExp(String.raw`LaunchAgents|/etc/cron\.|systemd/system`, "i");

export class B004 extends Rule {
  id = "B004";
  severity: Severity = "critical";
  title = "System persistence installed";
  explanation = "Cron/systemd/LaunchAgent/registry-run entries execute at boot or on schedule.";
  recommendation = "Remove the persistence entry and inspect what it executes.";
  appliesTo = [ShellCommand, FileWrite];

  override check(event: Event): Finding | null {
    let evidence: string;
    if (event instanceof ShellCommand) {
      const m = B004_SHELL_RE.exec(event.raw);
      if (!m) {
        return null;
      }
      evidence = m[0];
    } else if (event instanceof FileWrite) {
      if (!B004_FILE_RE.test(event.path)) {
        return null;
      }
      evidence = event.path;
    } else {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: evidence.slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}

// NOTE: `[\w./\\~-]*` instead of the plan's `\S*` — see B003 (quadratic on
// `>`-heavy commands); still matches `>> ~/.ssh/authorized_keys` and
// `tee -a ~/.ssh/authorized_keys`.
const B005_SHELL_RE = new RegExp(
  String.raw`(>>?|tee\s+-a)\s*[\w./\\~-]*authorized_keys` +
    String.raw`|ssh-keygen[^|;&\n]{0,400}\|\s*(tee|cat)\b`,
  "i",
);

export class B005 extends Rule {
  id = "B005";
  severity: Severity = "critical";
  title = "authorized_keys modified";
  explanation = "New SSH authorized keys grant remote login access.";
  recommendation = "Remove unrecognized keys; rotate if the machine is exposed.";
  appliesTo = [ShellCommand, FileWrite];

  override check(event: Event): Finding | null {
    let evidence: string;
    if (event instanceof ShellCommand) {
      const m = B005_SHELL_RE.exec(event.raw);
      if (!m) {
        return null;
      }
      evidence = m[0];
    } else if (event instanceof FileWrite) {
      if (pathBasename(event.path) !== "authorized_keys") {
        return null;
      }
      evidence = event.path;
    } else {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: evidence.slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}

export class B006 extends RegexRule {
  // v0.1.1: prefix class also admits " ' / so `/usr/bin/sudo x` and
  // `sh -c "sudo x"` forms are caught (word-start sudo only, sudoedit safe)
  static override pattern =
    String.raw`(^|[\s;&|(\"'/])sudo\s|Start-Process\b[^|;&\n]{0,400}-Verb\s+RunAs`;
  id = "B006";
  severity: Severity = "medium";
  title = "Privilege escalation via sudo";
  explanation = "Commands ran as root; blast radius of any mistake or injection is the whole machine.";
  recommendation = "Check each sudo invocation was justified.";
}

export function rules(): Rule[] {
  return [new B001(), new B002(), new B003(), new B004(), new B005(), new B006()];
}
