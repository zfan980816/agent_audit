import json

from typer.testing import CliRunner

from agentaudit.cli import app

runner = CliRunner()


def test_list_rules():
    res = runner.invoke(app, ["--list-rules"])
    assert res.exit_code == 0
    assert "D001" in res.output and "U006" in res.output
    assert len([l for l in res.output.splitlines() if l.strip()]) >= 28


def test_demo_json_output():
    res = runner.invoke(app, ["--demo", "--json"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert data["summary"]["total"] >= 10
    assert any(f["rule_id"] == "D001" for f in data["findings"])


def test_demo_severity_filter():
    res = runner.invoke(app, ["--demo", "--json", "--severity", "critical"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert data["summary"]["total"] >= 1
    assert all(f["severity"] == "critical" for f in data["findings"])


def test_demo_rules_filter():
    res = runner.invoke(app, ["--demo", "--json", "--rules", "D"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert {f["rule_id"][0] for f in data["findings"]} == {"D"}


def test_demo_terminal_and_share():
    res = runner.invoke(app, ["--demo", "--share"])
    assert res.exit_code == 0
    assert "agentaudit" in res.output
    assert "npx agent-audit" in res.output


def test_missing_path_errors_cleanly(tmp_path):
    res = runner.invoke(app, [str(tmp_path / "nope")])
    assert res.exit_code != 0
    assert "not found" in res.output.lower()
