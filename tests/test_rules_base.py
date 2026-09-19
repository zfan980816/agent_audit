from agentaudit.events import Severity
from agentaudit.rules.base import Finding, RegexRule, evidence_of
from tests.conftest import shell


class DemoRule(RegexRule):
    id = "X001"
    severity = Severity.HIGH
    title = "demo"
    explanation = "exp"
    recommendation = "rec"
    pattern = r"rm\s+-rf"


def test_regex_rule_matches():
    f = DemoRule().check(shell("rm -rf /tmp/x"))
    assert isinstance(f, Finding)
    assert f.rule_id == "X001"
    assert f.severity is Severity.HIGH
    assert f.evidence == "rm -rf"
    assert f.event.raw == "rm -rf /tmp/x"


def test_regex_rule_no_match():
    assert DemoRule().check(shell("ls -la")) is None


def test_regex_rule_case_insensitive():
    assert DemoRule().check(shell("RM -RF /tmp/x")) is not None


def test_evidence_of_variants():
    from tests.conftest import fwrite, netreq
    assert evidence_of(shell("cmd")) == "cmd"
    assert evidence_of(fwrite("/a/.bashrc")) == "/a/.bashrc"
    assert evidence_of(netreq("https://x.com")) == "https://x.com"
