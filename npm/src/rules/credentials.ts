// Ported 1:1 from src/agentaudit/rules/credentials.py (Python implementation is the spec).
// Patterns use String.raw so they stay character-for-character identical to the
// Python raw strings; adjacent String.raw`` segments concatenate exactly like
// the adjacent string literals in the .py file.
import type { Severity } from "../events.js";
import { RegexRule, type Rule } from "./base.js";

export class C001 extends RegexRule {
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  static override pattern =
    String.raw`\b(cat|type|less|more|head|tail|bat|Get-Content|gc)\b[^|;&\n]{0,400}\.env\b`;
  id = "C001";
  severity: Severity = "high";
  title = "Read .env file";
  explanation = ".env files typically hold API keys and database credentials.";
  recommendation = "Check whether the secret values were further used or transmitted.";
}

export class C002 extends RegexRule {
  static override pattern =
    String.raw`\bid_(rsa|ed25519|ecdsa)\b` +
    // \b prefix + {1,200} cap keep the scan linear: '.' and '/' are non-word
    // chars inside the class, so each word->punct transition is a fresh start
    // candidate whose greedy run backtracks (quadratic on dot/slash-heavy tokens)
    String.raw`|\b[\w./\\-]{1,200}\.(pem|key|ppk)\b` +
    String.raw`|\bserviceAccount[\w.-]*\.json\b`;
  id = "C002";
  severity: Severity = "high";
  title = "Read key material";
  explanation = "Private keys and service-account files grant long-lived access.";
  recommendation = "Rotate the key if it was exposed to the model context.";
}

export class C003 extends RegexRule {
  static override pattern =
    String.raw`\.aws\b|\.ssh\b|\.gnupg\b|\.npmrc\b` +
    String.raw`|\.docker[/\\]config\.json` +
    String.raw`|\.kube[/\\]config\b`;
  id = "C003";
  severity: Severity = "high";
  title = "Access credential directory";
  explanation = "~/.aws, ~/.ssh, ~/.gnupg, .npmrc and .kube/config hold machine-wide credentials.";
  recommendation = "Review what was read; rotate credentials if contents entered model context.";
}

export class C004 extends RegexRule {
  static override pattern =
    String.raw`security\s+find-(generic|internet)-password\b` +
    String.raw`|\bpass\s+show\b` +
    String.raw`|keyctl\s+(get|pipe)`;
  id = "C004";
  severity: Severity = "critical";
  title = "Query OS keychain / password manager";
  explanation = "Keychain or password-store queries can dump stored account credentials.";
  recommendation = "Rotate affected credentials immediately.";
}

export class C005 extends RegexRule {
  static override pattern =
    String.raw`Login\s+Data\b` +
    String.raw`|cookies\.sqlite\b` +
    String.raw`|User\s+Data[/\\]+(Default|Profile)`;
  id = "C005";
  severity: Severity = "high";
  title = "Access browser sensitive data";
  explanation = "Browser login/cookie databases expose all saved sessions.";
  recommendation = "Sign out affected accounts; consider the sessions compromised.";
}

export class C006 extends RegexRule {
  // NOTE: DEVIATION from the plan's `(^|[\s;&|])(env|printenv)\b...`: the plan's
  // version let any whitespace precede `env`, so "python -m venv env" (env as a
  // mere argument) false-positived. Prefix is restricted to start-of-string or a
  // command separator (;, &, |), so piped `env` dumps like "echo hi | env" still hit.
  static override pattern =
    String.raw`(^|[;&|])\s*(env|printenv)\b(\s*$|\s*\||\s*;)` +
    String.raw`|Get-ChildItem\s+env:` +
    String.raw`|\bgci\s+env:`;
  id = "C006";
  severity: Severity = "medium";
  title = "Dump all environment variables";
  explanation = "env dumps often include API tokens injected via CI/CD secrets.";
  recommendation = "Check whether secret-looking values were printed or forwarded.";
}

export function rules(): Rule[] {
  return [new C001(), new C002(), new C003(), new C004(), new C005(), new C006()];
}
