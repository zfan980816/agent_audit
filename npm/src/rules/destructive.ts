// Ported 1:1 from src/agentaudit/rules/destructive.py (Python implementation is the spec).
// Patterns use String.raw so they stay character-for-character identical to the
// Python raw strings; adjacent String.raw`` segments concatenate exactly like
// the adjacent string literals in the .py file.
import type { Severity } from "../events.js";
import { RegexRule, type Rule } from "./base.js";

export class D001 extends RegexRule {
  // NOTE: "rm" intentionally has no leading \b so compound commands like
  // "git rm -rf" still hit.
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  static override pattern =
    // flag cluster containing both r and f (no trailing \b: -rfi etc. still hit)
    String.raw`rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)` +
    // separated flags: rm -r ... -f (either order), long flags included
    String.raw`|rm\b[^|;&\n]{0,400}\s-r[a-zA-Z]*\b[^|;&\n]{0,400}\s-f[a-zA-Z]*\b` +
    String.raw`|rm\b[^|;&\n]{0,400}\s-f[a-zA-Z]*\b[^|;&\n]{0,400}\s-r[a-zA-Z]*\b` +
    String.raw`|rm\b[^|;&\n]{0,400}--recursive\b[^|;&\n]{0,400}--force\b` +
    String.raw`|rm\b[^|;&\n]{0,400}--force\b[^|;&\n]{0,400}--recursive\b` +
    String.raw`|\brd\s+/s\s+/q\b` +
    // /s and /q anywhere in the del command (any flag order/prefix)
    String.raw`|\bdel\b[^|;&\n]{0,400}/s\b[^|;&\n]{0,400}/q\b` +
    String.raw`|\bdel\b[^|;&\n]{0,400}/q\b[^|;&\n]{0,400}/s\b` +
    String.raw`|Remove-Item\b[^|;&\n]{0,400}-Recurse\b[^|;&\n]{0,400}-Force` +
    String.raw`|Remove-Item\b[^|;&\n]{0,400}-Force\b[^|;&\n]{0,400}-Recurse`;
  id = "D001";
  severity: Severity = "critical";
  title = "Recursive force delete";
  explanation = "Recursive force deletion can wipe entire directory trees beyond recovery.";
  recommendation = "Confirm the deleted path scope; restore from VCS/backup if unintended.";
}

export class D002 extends RegexRule {
  static override pattern =
    String.raw`git\s+reset\s+--hard\b` +
    String.raw`|git\s+clean\s+-\w*f` +
    String.raw`|git\s+push\b[^|;&\n]{0,400}(\s--force\b|\s--force-with-lease\b|\s-[a-z]*f[a-z]*\b)` +
    String.raw`|git\s+reflog\s+expire\b`;
  id = "D002";
  severity: Severity = "high";
  title = "Destructive git operation";
  explanation = "Hard resets, force pushes and clean can silently discard committed or uncommitted work.";
  recommendation = "Check reflog; force-push only with explicit user intent.";
}

export class D003 extends RegexRule {
  static override pattern = String.raw`chmod\s+(-R\s+)?0?777\b`;
  id = "D003";
  severity: Severity = "medium";
  title = "World-writable permissions (chmod 777)";
  explanation = "chmod 777 makes files writable by every user on the machine.";
  recommendation = "Use the narrowest permission set that works.";
}

export class D004 extends RegexRule {
  static override pattern =
    String.raw`\bdd\b[^|;&\n]{0,400}of=/dev/\w+` +
    String.raw`|\bmkfs(\.\w+)?\b` +
    String.raw`|diskutil\s+erase\w*` +
    String.raw`|\bformat\s+[a-zA-Z]:(\s|$|;)`;
  id = "D004";
  severity: Severity = "critical";
  title = "Disk-level write/erase";
  explanation = "Raw device writes and filesystem formatting destroy all data on the target disk.";
  recommendation = "Verify the target device; recover from backup if unintended.";
}

export class D005 extends RegexRule {
  static override pattern =
    String.raw`docker\s+system\s+prune\b[^|;&\n]{0,400}(\s--volumes\b|\s--all\b|\s-[a-z]*a[a-z]*\b)` +
    String.raw`|killall\s+\w+` +
    // single middle span: the system-process name is the strong signal;
    // a chained /\im\b + name middle was quadratic on repeated anchors
    String.raw`|taskkill\b[^|;&\n]{0,400}\b(explorer|svchost|csrss|wininit)\b`;
  id = "D005";
  severity: Severity = "high";
  title = "System-level destructive action";
  explanation = "Pruning all docker resources or killing system processes can take down unrelated services.";
  recommendation = "Scope the operation to named resources only.";
}

export function rules(): Rule[] {
  return [new D001(), new D002(), new D003(), new D004(), new D005()];
}
