import json
from pathlib import Path

from agentaudit.events import FileWrite, NetworkRequest, ShellCommand, is_config_path


def make_tool_line(name: str, tool_input: dict, *, session: str = "11111111-2222-3333-4444-555555555555",
                   cwd: str = "D:\\demo", ts: str = "2026-09-19T10:00:00.000Z") -> dict:
    return {
        "type": "assistant",
        "sessionId": session,
        "timestamp": ts,
        "cwd": cwd,
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": name, "input": tool_input}],
        },
    }


def make_user_line(text: str = "hi") -> dict:
    return {"type": "user", "sessionId": "s-x", "timestamp": "2026-09-19T10:00:01.000Z",
            "cwd": "D:\\demo", "message": {"role": "user", "content": text}}


def write_jsonl(path: Path, records: list) -> Path:
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
                    encoding="utf-8")
    return path


def shell(cmd: str, *, session: str = "11111111-2222-3333-4444-555555555555",
          project: str = "demo") -> ShellCommand:
    return ShellCommand(session_id=session, project=project, timestamp=None, raw=cmd, cwd=project)


def fwrite(path_str: str, content: str | None = None, *,
           session: str = "11111111-2222-3333-4444-555555555555",
           project: str = "demo") -> FileWrite:
    return FileWrite(session_id=session, project=project, timestamp=None, path=path_str,
                     is_config=is_config_path(path_str), content=content)


def netreq(url: str, *, session: str = "11111111-2222-3333-4444-555555555555",
           project: str = "demo") -> NetworkRequest:
    return NetworkRequest(session_id=session, project=project, timestamp=None, url=url)
