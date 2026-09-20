// Ported 1:1 from src/agentaudit/rules/exfiltration.py (Python implementation is the spec).
// Patterns use String.raw so they stay character-for-character identical to the
// Python raw strings; adjacent String.raw`` segments concatenate exactly like
// the adjacent string literals in the .py file.
import { ShellCommand, type Event, type Severity } from "../events.js";
import { type Finding, RegexRule, Rule } from "./base.js";

export class E001 extends RegexRule {
  // NOTE: `-d\s*@` (DEVIATION from the plan's `-d\s+@`): curl accepts the
  // attached form `-d@file` with no space, which `\s+` missed.
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  static override pattern =
    String.raw`(\bcat|\btype)\b[^|;&\n]{0,400}(id_rsa|\.pem\b|\.env\b|\.key\b)[^|;&\n]{0,400}\|[^|;&\n]{0,400}\b(curl|wget)\b` +
    String.raw`|\b(curl|wget)\b[^|;&\n]{0,400}(--data\b|-d)\s*@` +
    String.raw`|\b(curl|wget)\b[^|;&\n]{0,400}-F\b[^|;&\n]{0,400}file=@`;
  id = "E001";
  severity: Severity = "critical";
  title = "Pipe/upload secrets to network";
  explanation = "Secret file contents are sent to a remote endpoint.";
  recommendation = "Treat the secret as compromised; rotate and block the destination.";
}

export class E002 extends RegexRule {
  static override pattern =
    String.raw`\$\(\s*(cat|type)\s+[^)\n]{0,400}(id_rsa|\.pem\b|\.env\b|\.key\b)`;
  id = "E002";
  severity: Severity = "critical";
  title = "Command-substitution exfiltration";
  explanation = "Command substitution $(cat <secret>) inlines secret contents into another command.";
  recommendation = "Treat the secret as compromised; rotate it.";
}

export class E003 extends RegexRule {
  static override pattern =
    String.raw`pastebin\.com|transfer\.sh|0x0\.st|paste\.ee` +
    String.raw`|discord(?:app)?\.com/api/webhooks` +
    String.raw`|api\.telegram\.org/bot`;
  id = "E003";
  severity: Severity = "critical";
  title = "Upload to paste site / webhook";
  explanation = "Paste services and chat webhooks are common exfiltration destinations.";
  recommendation = "Delete the paste/webhook message; rotate anything it contained.";
}

export class E004 extends RegexRule {
  static override pattern = String.raw`git\s+remote\s+add\b`;
  id = "E004";
  severity: Severity = "high";
  title = "Add git remote";
  explanation = "A newly added remote is a potential push destination for source code.";
  recommendation = "Verify the remote URL is trusted before pushing anything.";
}

const ARCHIVE_CREATE_RE = new RegExp(String.raw`zip\s+-\w*r|tar\s+-\w*c\w*f|Compress-Archive`, "i");
// NOTE: DEVIATION from the plan's `(\S+\.(?:zip|...))`: an unanchored `\S+` is a
// start candidate at every position and backtracks the whole token per position —
// quadratic on long commands. Same fix family as C002: \b prefix + path-char
// class {1,200} cap keeps the scan linear (dot/slash-heavy tokens included) and
// still matches relative paths like ./builds/proj.zip.
const ARCHIVE_NAME_RE = new RegExp(
  String.raw`(\b[\w./\\-]{1,200}\.(?:zip|tar\.gz|tgz|tar|7z))(?:\s|$|[;&|])`,
  "i",
);
const UPLOAD_CMD_RE = new RegExp(String.raw`\b(curl|wget|scp|sftp)\b`, "i");

export class E005 extends Rule {
  // Stateful: remembers the most recent archive artifact per session.
  //
  // The engine constructs fresh rule instances per run (allRules() factory),
  // so this map never outlives one scan.
  //
  // By design, a combined one-liner ("zip ... && curl -F file=@out.zip ...") is
  // treated as archive-create only: it stores the artifact and fires on a LATER
  // separate upload event, never on the create event itself.
  id = "E005";
  // v0.1.1: whole-repo archive-then-upload raised from MEDIUM to HIGH
  severity: Severity = "high";
  title = "Archive-then-upload pattern";
  explanation = "A directory was archived and the archive was immediately uploaded within the same session.";
  recommendation = "Confirm the upload destination is authorized for this codebase.";
  appliesTo = [ShellCommand];

  // Python: self._last_archive: dict[str, str] = {}  (keyed by session_id)
  private readonly lastArchive = new Map<string, string>();

  override check(event: Event): Finding | null {
    if (!(event instanceof ShellCommand) || !event.raw) {
      return null;
    }
    const m = ARCHIVE_NAME_RE.exec(event.raw);
    if (m && ARCHIVE_CREATE_RE.test(event.raw)) {
      this.lastArchive.set(event.sessionId, m[1]);
      return null;
    }
    if (UPLOAD_CMD_RE.test(event.raw)) {
      const target = this.lastArchive.get(event.sessionId);
      if (target !== undefined && event.raw.includes(target)) {
        this.lastArchive.delete(event.sessionId);
        return {
          ruleId: this.id,
          severity: this.severity,
          title: this.title,
          event,
          evidence: event.raw.slice(0, 200),
          explanation: this.explanation,
          recommendation: this.recommendation,
        };
      }
    }
    return null;
  }
}

export function rules(): Rule[] {
  return [new E001(), new E002(), new E003(), new E004(), new E005()];
}
