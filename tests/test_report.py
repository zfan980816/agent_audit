import io
import json

from rich.console import Console

from agentaudit.engine import run_audit
from agentaudit.events import Severity
from agentaudit.report import (
    filter_by_severity, render_terminal, severity_counts, share_card, to_dict,
)
from tests.conftest import make_tool_line, write_jsonl


def make_result(tmp_path):
    return run_audit([write_jsonl(tmp_path / "a.jsonl", [
        make_tool_line("Bash", {"command": "rm -rf /tmp/x"}),
        make_tool_line("Bash", {"command": "sudo apt install x"}),
        make_tool_line("Bash", {"command": "ls -la"}),
    ])])


def test_severity_counts_and_filter(tmp_path):
    result = make_result(tmp_path)
    counts = severity_counts(result.findings)
    assert counts[Severity.CRITICAL] == 1
    assert counts[Severity.MEDIUM] == 1
    assert len(filter_by_severity(result.findings, Severity.CRITICAL)) == 1


def test_render_terminal_contains_rows(tmp_path):
    result = make_result(tmp_path)
    buf = io.StringIO()
    render_terminal(result, console=Console(file=buf, force_terminal=False, width=160))
    out = buf.getvalue()
    assert "D001" in out and "B006" in out
    assert "CRITICAL" in out
    assert "skipped" not in out  # 无坏行时不显示


def test_to_dict_roundtrip(tmp_path):
    result = make_result(tmp_path)
    data = to_dict(result)
    text = json.dumps(data)
    assert '"findings"' in text
    assert data["summary"]["total"] == 2
    assert {f["rule_id"] for f in data["findings"]} == {"D001", "B006"}
    assert data["findings"][0]["severity"] in ("critical", "high", "medium", "low", "info")


def test_share_card_lines(tmp_path):
    result = make_result(tmp_path)
    card = share_card(result)
    assert "agentaudit" in card
    assert "CRITICAL 1" in card
    assert "uvx agentaudit" in card


def test_files_failed_surfaced(tmp_path):
    from pathlib import Path
    result = run_audit([write_jsonl(tmp_path / "a.jsonl", [
        make_tool_line("Bash", {"command": "ls -la"}),
    ]), Path(tmp_path) / "missing.jsonl"])
    data = to_dict(result)
    assert data["summary"]["files_failed"] == 1
    buf = io.StringIO()
    render_terminal(result, console=Console(file=buf, force_terminal=False, width=160))
    assert "failed to read 1" in buf.getvalue()
