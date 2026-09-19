from agentaudit.events import (
    Severity, SEVERITY_ORDER, severity_at_least,
    is_config_path, ShellCommand, FileWrite,
)


def test_severity_order_and_compare():
    assert severity_at_least(Severity.CRITICAL, Severity.HIGH)
    assert severity_at_least(Severity.HIGH, Severity.HIGH)
    assert not severity_at_least(Severity.LOW, Severity.HIGH)
    assert SEVERITY_ORDER[0] == Severity.INFO


def test_is_config_path_hits():
    assert is_config_path("/home/u/.claude/settings.json")
    assert is_config_path("/home/u/.bashrc")
    assert is_config_path("C:\\Users\\u\\.ssh\\authorized_keys")
    assert is_config_path("/home/u/project/settings.local.json")


def test_is_config_path_misses():
    assert not is_config_path("/home/u/project/src/main.py")
    assert not is_config_path("/home/u/project/.env")
    assert not is_config_path("/home/u/notes.txt")


def test_shell_command_fields():
    ev = ShellCommand(session_id="s1", project="demo", timestamp=None,
                      raw="ls -la", cwd="/tmp")
    assert ev.raw == "ls -la"
    assert ev.cwd == "/tmp"


def test_file_write_defaults():
    ev = FileWrite(session_id="s1", project="demo", timestamp=None,
                   path="/x/.bashrc")
    assert ev.is_config is True
    assert ev.content is None
