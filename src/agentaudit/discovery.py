"""Locate local agent session files."""
from __future__ import annotations

from pathlib import Path


class DataDirNotFound(FileNotFoundError):
    pass


def default_claude_projects_dir() -> Path:
    return Path.home() / ".claude" / "projects"


def find_session_files(root: Path | None = None) -> list[Path]:
    root = root or default_claude_projects_dir()
    if not root.exists():
        raise DataDirNotFound(
            f"Claude Code data directory not found: {root}\n"
            "Hints:\n"
            "  - pass an explicit path: agentaudit <path>\n"
            "  - if Claude Code runs inside WSL, the dir lives under\n"
            "    \\\\wsl$\\<distro>\\home\\<user>\\.claude\\projects"
        )
    return sorted(p for p in root.rglob("*.jsonl") if p.is_file())
