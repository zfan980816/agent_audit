"""C: credential / secret access."""
from __future__ import annotations

from agentaudit.events import Severity
from agentaudit.rules.base import RegexRule, Rule


class C001(RegexRule):
    id = "C001"
    severity = Severity.HIGH
    title = "Read .env file"
    explanation = ".env files typically hold API keys and database credentials."
    recommendation = "Check whether the secret values were further used or transmitted."
    pattern = r"\b(cat|type|less|more|head|tail|bat|Get-Content|gc)\b[^|;&\n]*\.env\b"


class C002(RegexRule):
    id = "C002"
    severity = Severity.HIGH
    title = "Read key material"
    explanation = "Private keys and service-account files grant long-lived access."
    recommendation = "Rotate the key if it was exposed to the model context."
    pattern = (
        r"\bid_(rsa|ed25519|ecdsa)\b"
        # \b prefix keeps the scan linear (unanchored char-class is quadratic on long commands)
        r"|\b[\w./\\-]+\.(pem|key|ppk)\b"
        r"|\bserviceAccount[\w.-]*\.json\b"
    )


class C003(RegexRule):
    id = "C003"
    severity = Severity.HIGH
    title = "Access credential directory"
    explanation = "~/.aws, ~/.ssh, ~/.gnupg, .npmrc and .kube/config hold machine-wide credentials."
    recommendation = "Review what was read; rotate credentials if contents entered model context."
    pattern = (
        r"\.aws\b|\.ssh\b|\.gnupg\b|\.npmrc\b"
        r"|\.docker[/\\]config\.json"
        r"|\.kube[/\\]config\b"
    )


class C004(RegexRule):
    id = "C004"
    severity = Severity.CRITICAL
    title = "Query OS keychain / password manager"
    explanation = "Keychain or password-store queries can dump stored account credentials."
    recommendation = "Rotate affected credentials immediately."
    pattern = (
        r"security\s+find-(generic|internet)-password\b"
        r"|\bpass\s+show\b"
        r"|keyctl\s+(get|pipe)"
    )


class C005(RegexRule):
    id = "C005"
    severity = Severity.HIGH
    title = "Access browser sensitive data"
    explanation = "Browser login/cookie databases expose all saved sessions."
    recommendation = "Sign out affected accounts; consider the sessions compromised."
    pattern = (
        r"Login\s+Data\b"
        r"|cookies\.sqlite\b"
        r"|User\s+Data[/\\]+(Default|Profile)"
    )


class C006(RegexRule):
    id = "C006"
    severity = Severity.MEDIUM
    title = "Dump all environment variables"
    explanation = "env dumps often include API tokens injected via CI/CD secrets."
    recommendation = "Check whether secret-looking values were printed or forwarded."
    # NOTE: DEVIATION from the plan's `(^|[\s;&|])(env|printenv)\b...`: the plan's
    # version let any whitespace precede `env`, so "python -m venv env" (env as a
    # mere argument) false-positived. Prefix is restricted to start-of-string or a
    # command separator (;, &, |), so piped `env` dumps like "echo hi | env" still hit.
    pattern = (
        r"(^|[;&|])\s*(env|printenv)\b(\s*$|\s*\||\s*;)"
        r"|Get-ChildItem\s+env:"
        r"|\bgci\s+env:"
    )


def rules() -> list[Rule]:
    return [C001(), C002(), C003(), C004(), C005(), C006()]
