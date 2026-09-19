"""Streaming parser: Claude Code session JSONL -> unified events."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from agentaudit.events import (
    Event, FileWrite, McpToolCall, NetworkRequest, ShellCommand, is_config_path,
)

WRITE_TOOLS = {"Write", "Edit", "NotebookEdit"}
NETWORK_TOOLS = {"WebFetch", "WebSearch"}


@dataclass
class ParseStats:
    lines_total: int = 0
    lines_skipped: int = 0
    events: int = 0


def _parse_ts(raw) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def iter_events(path: Path, stats: ParseStats | None = None) -> Iterator[Event]:
    stats = stats if stats is not None else ParseStats()
    fallback_project = path.parent.name
    fallback_session = path.stem
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            stats.lines_total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats.lines_skipped += 1
                continue
            if not isinstance(rec, dict):
                stats.lines_skipped += 1
                continue
            sid = rec.get("sessionId") or fallback_session
            ts = _parse_ts(rec.get("timestamp"))
            cwd = rec.get("cwd")
            project = cwd if isinstance(cwd, str) and cwd else fallback_project
            msg = rec.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                ev = _to_event(block.get("name") or "", block.get("input"), sid, project, ts, cwd)
                if ev is not None:
                    stats.events += 1
                    yield ev


def _to_event(name: str, inp, sid: str, project: str, ts, cwd) -> Event | None:
    kw = {"session_id": sid, "project": project, "timestamp": ts}
    if not isinstance(inp, dict):
        inp = {}
    if name == "Bash":
        cmd = inp.get("command")
        if isinstance(cmd, str) and cmd:
            return ShellCommand(raw=cmd, cwd=cwd, **kw)
        return None
    if name in WRITE_TOOLS:
        p = inp.get("file_path") or inp.get("notebook_path")
        if not isinstance(p, str) or not p:
            return None
        content = inp.get("content") if isinstance(inp.get("content"), str) else None
        if content is None and isinstance(inp.get("new_string"), str):
            content = inp["new_string"]
        return FileWrite(path=p, is_config=is_config_path(p), content=content, **kw)
    if name in NETWORK_TOOLS:
        url = inp.get("url") or inp.get("query")
        if isinstance(url, str) and url:
            return NetworkRequest(url=url, **kw)
        return None
    if name.startswith("mcp__"):
        parts = name.split("__", 2)
        if len(parts) == 3:
            server, tool = parts[1], parts[2]
        else:
            server, tool = "?", name
        return McpToolCall(server=server, tool=tool,
                           args_hint=json.dumps(inp, ensure_ascii=False)[:200], **kw)
    return None
