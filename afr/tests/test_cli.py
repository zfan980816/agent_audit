"""T6 — viewer tests: three routes render, corrupt DB exits non-zero (C1)."""

import pytest
from fastapi.testclient import TestClient

from afr.capture import canonical_json, connect
from afr.cli import create_app, main


def _seed(db, run_ids):
    conn = connect(db)
    for rid, status, outputs in run_ids:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
            (rid, "t", status, "2026-09-25T00:00:00"))
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (rid, 1, 0.0, "node_start", "researcher",
             canonical_json({"inputs": outputs})))
    conn.commit()
    conn.close()


def test_runs_list_page(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []})])
    client = TestClient(create_app(db))
    r = client.get("/")
    assert r.status_code == 200 and "#fa" in r.text and 'title="失败"' in r.text


def test_run_detail_page(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []})])
    client = TestClient(create_app(db))
    r = client.get("/run/fa")
    assert r.status_code == 200 and "researcher" in r.text
    frag = client.get("/run/fa/tree")
    assert frag.status_code == 200 and "sources" in frag.text


def test_diff_page_first_divergence(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []}),
               ("pb", "ok", {"sources": ["u1"]})])
    client = TestClient(create_app(db))
    r = client.get("/diff", params={"a": "fa", "b": "pb"})
    assert r.status_code == 200 and "首个分歧" in r.text


def test_diff_page_unaligned(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    for rid, node in [("a", "writer"), ("b", "critic")]:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
            (rid, "t", "ok", "2026-09-25T00:00:00"))
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (rid, 1, 0.0, "node_start", node, canonical_json({"inputs": {}})))
    conn.commit()
    conn.close()
    client = TestClient(create_app(db))
    r = client.get("/diff", params={"a": "a", "b": "b"})
    assert r.status_code == 200 and "不可对齐" in r.text


def test_empty_db_guide_page(tmp_path):
    client = TestClient(create_app(tmp_path / "t.db"))
    r = client.get("/")
    assert r.status_code == 200 and "暂无录制" in r.text


def test_stats_page_and_failure_banner(tmp_path):
    """D17 A+B: monitoring overview renders; failed-run banner appears."""
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []}),
               ("pb", "ok", {"sources": ["u1"]})])
    client = TestClient(create_app(db))
    r = client.get("/stats")
    assert r.status_code == 200 and "监控概览" in r.text
    assert "失败" in r.text and "¥" in r.text  # per-flow table + cost column
    home = client.get("/")
    assert "次失败" in home.text  # banner counts the 1 failed run


def test_corrupt_db_clear_error_nonzero_exit(tmp_path):
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"\x00not a sqlite file at all")
    with pytest.raises(SystemExit) as ei:
        main(["--db", str(bad), "diff", "a", "b"])
    assert ei.value.code == 2
