from agentaudit.events import FileWrite, McpToolCall, NetworkRequest, ShellCommand
from agentaudit.parsers.claude_code import ParseStats, iter_events
from tests.conftest import make_tool_line, make_user_line, write_jsonl


def collect(path):
    stats = ParseStats()
    events = list(iter_events(path, stats))
    return events, stats


def test_bash_becomes_shell_command(tmp_path):
    f = write_jsonl(tmp_path / "a.jsonl",
                    [make_tool_line("Bash", {"command": "ls -la", "description": "list"})])
    events, stats = collect(f)
    assert len(events) == 1
    ev = events[0]
    assert isinstance(ev, ShellCommand) and ev.raw == "ls -la"
    assert ev.session_id == "11111111-2222-3333-4444-555555555555"
    assert ev.project == "D:\\demo"
    assert stats.events == 1 and stats.lines_skipped == 0


def test_write_edit_notebook_become_file_write(tmp_path):
    f = write_jsonl(tmp_path / "a.jsonl", [
        make_tool_line("Write", {"file_path": "/x/.bashrc", "content": "evil"}),
        make_tool_line("Edit", {"file_path": "/x/main.py", "old_string": "a", "new_string": "b"}),
        make_tool_line("NotebookEdit", {"notebook_path": "/x/n.ipynb"}),
    ])
    events, _ = collect(f)
    assert len(events) == 3
    assert all(isinstance(ev, FileWrite) for ev in events)
    assert events[0].is_config is True and events[0].content == "evil"
    assert events[1].is_config is False and events[1].content == "b"
    assert events[2].path == "/x/n.ipynb" and events[2].content is None


def test_network_and_mcp_events(tmp_path):
    f = write_jsonl(tmp_path / "a.jsonl", [
        make_tool_line("WebFetch", {"url": "https://x.com/a"}),
        make_tool_line("WebSearch", {"query": "hello"}),
        make_tool_line("mcp__github__create_issue", {"title": "t"}),
    ])
    events, _ = collect(f)
    assert isinstance(events[0], NetworkRequest) and events[0].url == "https://x.com/a"
    assert isinstance(events[1], NetworkRequest) and events[1].url == "hello"
    mcp = events[2]
    assert isinstance(mcp, McpToolCall)
    assert mcp.server == "github" and mcp.tool == "create_issue"


def test_corrupt_line_skipped_and_counted(tmp_path):
    p = tmp_path / "a.jsonl"
    p.write_text('{"type":"assistant"}\nnot-json\n', encoding="utf-8")
    stats = ParseStats()
    events = list(iter_events(p, stats))
    assert events == []
    assert stats.lines_total == 2
    assert stats.lines_skipped == 1


def test_user_and_non_tool_lines_ignored(tmp_path):
    f = write_jsonl(tmp_path / "a.jsonl",
                    [make_user_line(), {"type": "summary", "summary": "s"}])
    events, _ = collect(f)
    assert events == []


def test_fallback_project_and_session(tmp_path):
    # no cwd/sessionId on the record -> parent dir name / file stem
    p = tmp_path / "D--my-proj" / "abc123.jsonl"
    p.parent.mkdir()
    rec = {"type": "assistant", "timestamp": "2026-09-19T10:00:00.000Z",
           "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}}
    write_jsonl(p, [rec])
    events, _ = collect(p)
    assert events[0].project == "D--my-proj"
    assert events[0].session_id == "abc123"
