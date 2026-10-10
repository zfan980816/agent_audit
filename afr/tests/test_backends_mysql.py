"""MySQL integration smoke test — runs ONLY when $AFR_TEST_MYSQL_URL is set
(e.g. against examples/docker-compose.yml's mysql:8, or a real instance).

    AFR_TEST_MYSQL_URL='mysql://afr:afr@127.0.0.1:3306/afr' pytest afr/tests/test_backends_mysql.py
"""

import importlib.util
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("AFR_TEST_MYSQL_URL")
    or importlib.util.find_spec("pymysql") is None,
    reason="需要 AFR_TEST_MYSQL_URL 且已安装 PyMySQL")


def _connect():
    from afr.capture import connect
    return connect(db_url=os.environ["AFR_TEST_MYSQL_URL"])


def test_mysql_schema_auto_created_and_roundtrip():
    conn = _connect()
    rid = uuid.uuid4().hex[:12]
    big = "x" * 200_000  # LONGTEXT boundary — mysql TEXT would truncate/fail
    try:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at, finished_at)"
            " VALUES(?,?,?,?,?)",
            (rid, "mysql-e2e", "ok", "2026-09-26T10:00:00",
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
        assert row[0] == row["request_json"]  # positional access parity
    finally:
        conn.execute("DELETE FROM llm_calls WHERE run_id=?", (rid,))
        conn.execute("DELETE FROM runs WHERE id=?", (rid,))
        conn.commit()
        conn.close()


def test_mysql_viewer_queries():
    from afr.viewer import _run_rows, _trace_tree
    conn = _connect()
    rid = uuid.uuid4().hex[:12]
    try:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at, finished_at)"
            " VALUES(?,?,?,?,?)",
            (rid, "mysql-e2e", "ok", "2026-09-26T10:00:00",
             "2026-09-26T10:00:03"))
        conn.commit()
        rows = _run_rows(conn)
        mine = next(r for r in rows if r["id"] == rid)
        assert mine["latency"] == 3.0  # Python-side latency, no julianday
        t = _trace_tree(conn, rid)
        assert t["total"] == 3.0 and t["nodes"] == []
    finally:
        conn.execute("DELETE FROM runs WHERE id=?", (rid,))
        conn.commit()
        conn.close()


def test_mysql_conn_keeper_sees_runs_recorded_after_viewer_start():
    """REPEATABLE READ regression: a read-only connection that never ends
    its transaction freezes at the first snapshot — new runs recorded by
    other processes would never show up in the viewer."""
    from afr import db as db_mod
    url = os.environ["AFR_TEST_MYSQL_URL"]
    keeper = db_mod.ConnKeeper(url)
    keeper.get().execute("SELECT COUNT(*) c FROM runs").fetchone()

    writer = _connect()  # a separate process's recorder
    rid = uuid.uuid4().hex[:12]
    try:
        writer.execute(
            "INSERT INTO runs(id, label, status, started_at)"
            " VALUES(?,?,?,?)", (rid, "snap-check", "ok",
                                 "2026-09-26T12:00:00"))
        writer.commit()
        seen = keeper.get().execute(
            "SELECT id FROM runs WHERE id=?", (rid,)).fetchone()
        assert seen is not None, "viewer 连接必须看到启动后新录制的 run"
    finally:
        writer.execute("DELETE FROM runs WHERE id=?", (rid,))
        writer.commit()
        writer.close()
