"""Production controls: record switch / sampling, retention cleanup."""

import time

from afr import capture
from afr.capture import cleanup, connect, record_prob, retain_days, run


class _DummyGraph:
    """Minimal graph stand-in: run() only needs .invoke()."""

    def __init__(self):
        self.calls = []

    def invoke(self, inputs, config=None):
        self.calls.append((inputs, config))
        return {"echo": inputs}


def test_record_prob_precedence(monkeypatch, tmp_path):
    monkeypatch.setenv("AFR_RECORD", "off")
    cfg = tmp_path / "config.json"
    cfg.write_text('{"record": true}', encoding="utf-8")
    monkeypatch.setattr(capture.db, "CONFIG_PATH", cfg)
    assert record_prob() == 0.0            # env beats config
    assert record_prob(True) == 1.0        # param beats env
    monkeypatch.delenv("AFR_RECORD")
    assert record_prob() == 1.0            # config true
    cfg.write_text('{"record": 0.25}', encoding="utf-8")
    assert record_prob() == 0.25           # config sampling fraction
    cfg.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("AFR_RECORD", "garbage")
    assert record_prob() == 1.0            # unparseable -> fail open


def test_record_off_zero_overhead_and_nothing_stored(monkeypatch, tmp_path):
    monkeypatch.setenv("AFR_RECORD", "0")
    g = _DummyGraph()
    db_file = tmp_path / "t.db"
    out = run(g, {"q": 1}, db_path=db_file)
    assert out == {"echo": {"q": 1}}
    assert g.calls and g.calls[0][1] is None  # no recorder config attached
    assert not db_file.exists()               # DB never even opened


def test_sampling_allows_and_blocks(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.delenv("AFR_RECORD", raising=False)
    monkeypatch.setattr(capture.random, "random", lambda: 0.99)
    g = _DummyGraph()
    run(g, {"q": 1}, db_path=db_file, record=0.5)   # 0.99 >= 0.5 -> skip
    assert not db_file.exists()
    monkeypatch.setattr(capture.random, "random", lambda: 0.01)
    run(g, {"q": 1}, db_path=db_file, label="s", record=0.5)  # 0.01 -> record
    conn = connect(db_file)
    assert conn.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 1
    conn.close()


def test_retain_days_resolution(monkeypatch, tmp_path):
    monkeypatch.delenv("AFR_RETAIN_DAYS", raising=False)
    cfg = tmp_path / "config.json"
    cfg.write_text('{"retain_days": 14}', encoding="utf-8")
    monkeypatch.setattr(capture.db, "CONFIG_PATH", cfg)
    assert retain_days() == 14
    monkeypatch.setenv("AFR_RETAIN_DAYS", "3")
    assert retain_days() == 3
    monkeypatch.delenv("AFR_RETAIN_DAYS")
    cfg.write_text("{}", encoding="utf-8")
    assert retain_days() is None


def _seed(conn, rid, started, with_children=True):
    conn.execute(
        "INSERT INTO runs(id, label, status, started_at, finished_at)"
        " VALUES(?,?,?,?,?)", (rid, "t", "ok", started, started))
    if with_children:
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)", (rid, 1, 0.0, "node_start", "n", "{}"))
        conn.execute(
            "INSERT INTO llm_calls(run_id, seq, node, model, key_hash)"
            " VALUES(?,?,?,?,?)", (rid, 1, "n", "m", "k"))
        conn.execute(
            "INSERT INTO tool_calls(run_id, seq, node, tool_name, args_hash)"
            " VALUES(?,?,?,?,?)", (rid, 1, "n", "w", "k"))
    conn.commit()


def test_cleanup_deletes_old_keeps_new(tmp_path):
    conn = connect(tmp_path / "t.db")
    old = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 40 * 86400))
    new = time.strftime("%Y-%m-%dT%H:%M:%S")
    _seed(conn, "old", old)
    _seed(conn, "new", new)
    n = cleanup(conn, 30)
    assert n == {"events": 1, "llm_calls": 1, "tool_calls": 1, "runs": 1}
    left = [r["id"] for r in conn.execute("SELECT id FROM runs")]
    assert left == ["new"]
    for t in ("events", "llm_calls", "tool_calls"):
        rows = conn.execute(f"SELECT run_id FROM {t}").fetchall()
        assert [r["run_id"] for r in rows] == ["new"]
    conn.close()


def test_cleanup_nothing_old_is_noop(tmp_path):
    conn = connect(tmp_path / "t.db")
    _seed(conn, "r", time.strftime("%Y-%m-%dT%H:%M:%S"))
    n = cleanup(conn, 7)
    assert n["runs"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 1
    conn.close()


def test_autoclean_runs_when_retain_configured(monkeypatch, tmp_path):
    monkeypatch.delenv("AFR_RECORD", raising=False)
    cfg = tmp_path / "config.json"
    cfg.write_text('{"retain_days": 7}', encoding="utf-8")
    monkeypatch.setattr(capture.db, "CONFIG_PATH", cfg)
    capture._AUTO_CLEAN_AT = 0.0
    conn = connect(tmp_path / "t.db")
    old = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - 40 * 86400))
    _seed(conn, "old", old)
    _seed(conn, "new", time.strftime("%Y-%m-%dT%H:%M:%S"))
    capture._maybe_autoclean(conn)
    left = [r["id"] for r in conn.execute("SELECT id FROM runs")]
    assert left == ["new"]
    conn.close()
