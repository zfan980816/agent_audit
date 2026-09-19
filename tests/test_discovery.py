from pathlib import Path

import pytest

from agentaudit.discovery import DataDirNotFound, find_session_files


def test_finds_nested_jsonl(tmp_path: Path):
    (tmp_path / "proj-a").mkdir()
    (tmp_path / "proj-a" / "s1.jsonl").write_text("{}", encoding="utf-8")
    (tmp_path / "proj-a" / "s2.jsonl").write_text("{}", encoding="utf-8")
    (tmp_path / "proj-b" / "sub").mkdir(parents=True)
    (tmp_path / "proj-b" / "sub" / "s3.jsonl").write_text("{}", encoding="utf-8")
    (tmp_path / "proj-b" / "notes.txt").write_text("x", encoding="utf-8")

    files = find_session_files(tmp_path)

    assert len(files) == 3
    assert all(f.suffix == ".jsonl" for f in files)
    assert files == sorted(files)


def test_missing_dir_raises_with_hint(tmp_path: Path):
    with pytest.raises(DataDirNotFound) as exc:
        find_session_files(tmp_path / "nope")
    assert "WSL" in str(exc.value)


def test_default_dir_is_claude_projects(monkeypatch, tmp_path: Path):
    import agentaudit.discovery as disc

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".claude" / "projects" / "p").mkdir(parents=True)
    (tmp_path / ".claude" / "projects" / "p" / "a.jsonl").write_text("{}", encoding="utf-8")

    assert len(find_session_files()) == 1
