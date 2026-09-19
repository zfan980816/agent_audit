import pytest

from agentaudit.rules.credentials import rules

R = {r.id: r for r in rules()}


@pytest.mark.parametrize("rule_id,cmd", [
    ("C001", "cat .env"),
    ("C001", "Get-Content .env.production"),
    ("C001", "head -20 .env.local"),
    ("C002", "cat ~/.ssh/id_rsa"),
    ("C002", "openssl x509 -in cert.pem"),
    ("C002", "type server.key"),
    ("C002", "cat serviceAccount-prod.json"),
    ("C003", "ls ~/.aws"),
    ("C003", "cat ~/.ssh/config"),
    ("C003", "cat ~/.npmrc"),
    ("C004", "security find-generic-password -s github"),
    ("C004", "pass show work/aws"),
    ("C005", "strings 'Login Data'"),
    ("C005", "sqlite3 cookies.sqlite 'select *'"),
    ("C006", "env"),
    ("C006", "printenv | grep TOKEN"),
    ("C006", "Get-ChildItem env:"),
])
def test_rule_hits(rule_id, cmd):
    from tests.conftest import shell
    finding = R[rule_id].check(shell(cmd))
    assert finding is not None, f"{rule_id} should match: {cmd}"


@pytest.mark.parametrize("rule_id,cmd", [
    ("C001", "cat main.py"),
    ("C002", "cat readme.md"),
    ("C003", "ls ~/.config"),
    ("C004", "pass ls"),
    ("C006", "conda env create"),
    ("C006", "python -m venv env"),
])
def test_rule_misses(rule_id, cmd):
    from tests.conftest import shell
    assert R[rule_id].check(shell(cmd)) is None, f"{rule_id} should NOT match: {cmd}"
