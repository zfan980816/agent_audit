"""达梦 DM8 integration smoke test — runs ONLY when $AFR_TEST_DM_URL is set
(the user's real DM8 instance, MySQL 兼容模式 COMPATIBLE_MODE=4):

    AFR_TEST_DM_URL='dm://SYSDBA:pwd@host:5236?schema=AFR' pytest afr/tests/test_backends_dm.py

Covers the two untestable-offline facts: dmPython's placeholder style
(qmark per DM docs) and information_schema-free schema auto-creation.
"""

import importlib.util
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("AFR_TEST_DM_URL")
    or (importlib.util.find_spec("dmPython") is None
        and importlib.util.find_spec("dmpython") is None),
    reason="需要 AFR_TEST_DM_URL 且已安装 dmPython")


def _connect():
    from afr.capture import connect
    return connect(db_url=os.environ["AFR_TEST_DM_URL"])


def test_dm_schema_auto_created_and_roundtrip():
    conn = _connect()
    rid = uuid.uuid4().hex[:12]
    big = "x" * 200_000  # CLOB round-trip
    try:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at, finished_at)"
            " VALUES(?,?,?,?,?)",
            (rid, "dm-e2e", "ok", "2026-09-26T10:00:00",
             "2026-09-26T10:00:03"))
        conn.execute(
            "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
            " request_json, response_json, kind, tokens, dur)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (rid, 1, "agent", "qwen-test", "k", big, big, "ok", 3297, 0.5))
        conn.commit()
        row = conn.execute(
            "SELECT request_json, tokens FROM llm_calls WHERE run_id=?",
            (rid,)).fetchone()
        assert len(row["request_json"]) == 200_000
        assert row["tokens"] == 3297
    finally:
        conn.execute("DELETE FROM llm_calls WHERE run_id=?", (rid,))
        conn.execute("DELETE FROM runs WHERE id=?", (rid,))
        conn.commit()
        conn.close()


def test_dm_viewer_queries():
    from afr.viewer import _run_rows, _trace_tree
    conn = _connect()
    rid = uuid.uuid4().hex[:12]
    try:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at, finished_at)"
            " VALUES(?,?,?,?,?)",
            (rid, "dm-e2e", "ok", "2026-09-26T10:00:00",
             "2026-09-26T10:00:03"))
        conn.commit()
        rows = _run_rows(conn)
        mine = next(r for r in rows if r["id"] == rid)
        assert mine["latency"] == 3.0
        t = _trace_tree(conn, rid)
        assert t["total"] == 3.0 and t["nodes"] == []
    finally:
        conn.execute("DELETE FROM runs WHERE id=?", (rid,))
        conn.commit()
        conn.close()
