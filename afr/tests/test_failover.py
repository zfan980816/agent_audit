"""Outage buffering: sqlite spill while the primary DB is down, whole-run
flush + buffer clear the moment it recovers."""

from afr import db


class _Graph:
    def invoke(self, inputs, config=None):
        return {"ok": True}


def _url(path):
    return "sqlite:///" + str(path).replace("\\", "/")


def test_db_down_at_start_buffers_then_flushes(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "buffer.db")
    monkeypatch.setattr(db, "start_flusher", lambda *a, **k: None)
    url = _url(tmp_path / "primary.db")
    real_open = db.open
    down = {"yes": True}

    def flaky_open(u=None):
        if down["yes"] and u == url:
            raise db.DatabaseError("primary down")
        return real_open(u)

    monkeypatch.setattr(db, "open", flaky_open)

    from afr.capture import run
    result = run(_Graph(), {"q": 1}, db_url=url, label="outage-run")
    assert result == {"ok": True}

    buf = db.open_buffer()
    assert buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 1
    assert buf.execute(
        "SELECT status FROM runs WHERE label=?", ("outage-run",)
    ).fetchone()["status"] == "ok"
    buf.close()

    down["yes"] = False  # primary recovers
    assert db.flush_buffer(url) == 1

    primary = real_open(url)
    row = primary.execute(
        "SELECT label, status FROM runs WHERE label=?", ("outage-run",)
    ).fetchone()
    assert row["status"] == "ok"
    primary.close()

    buf = db.open_buffer()
    assert buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 0
    buf.close()


def test_midrun_failure_spills_tail_and_upserts_status(tmp_path):
    monkeybuffer = tmp_path / "buffer.db"

    import afr.db as dbmod
    orig_buffer = dbmod.BUFFER_DB
    orig_flusher = dbmod.start_flusher
    dbmod.BUFFER_DB = monkeybuffer
    dbmod.start_flusher = lambda *a, **k: None
    try:
        real = db.open(_url(tmp_path / "primary.db"))

        class FlakyPrimary:
            def __init__(self, inner, fail_after):
                self.inner, self.n, self.fail_after = inner, 0, fail_after

            def execute(self, sql, params=()):
                self.n += 1
                if self.n > self.fail_after:
                    raise db.DatabaseError("connection lost")
                return self.inner.execute(sql, params)

            def commit(self):
                self.inner.commit()

            def close(self):
                self.inner.close()

        conn = db.FailoverConn(FlakyPrimary(real, 3), "rid1", "L",
                               "2026-09-26T10:00:00",
                               _url(tmp_path / "primary.db"))
        # 1-3 reach the primary; 4+ spill to the buffer
        conn.execute("INSERT INTO runs(id,label,status,started_at)"
                     " VALUES(?,?,?,?)", ("rid1", "L", "running",
                                          "2026-09-26T10:00:00"))
        conn.commit()
        conn.execute("INSERT INTO events(run_id,seq,ts,kind,node,payload)"
                     " VALUES(?,?,?,?,?,?)", ("rid1", 1, 0.0, "node_start",
                                              "n1", "{}"))
        conn.commit()
        conn.execute("INSERT INTO events(run_id,seq,ts,kind,node,payload)"
                     " VALUES(?,?,?,?,?,?)", ("rid1", 2, 0.1, "node_start",
                                              "n2", "{}"))
        conn.commit()
        conn.execute("INSERT INTO events(run_id,seq,ts,kind,node,payload)"
                     " VALUES(?,?,?,?,?,?)", ("rid1", 3, 0.2, "node_start",
                                              "n3", "{}"))
        conn.commit()
        conn.execute("UPDATE runs SET status=?, finished_at=? WHERE id=?",
                     ("ok", "2026-09-26T10:00:05", "rid1"))
        conn.commit()
        conn.close()

        # primary: run still 'running' with only the first two events
        # (FailoverConn.close() closed the wrapped handle — reopen)
        primary = db.open(_url(tmp_path / "primary.db"))
        assert primary.execute(
            "SELECT status FROM runs WHERE id=?", ("rid1",)
        ).fetchone()["status"] == "running"
        assert primary.execute(
            "SELECT COUNT(*) c FROM events WHERE run_id=?",
            ("rid1",)).fetchone()["c"] == 2
        primary.close()

        buf = db.open_buffer()
        assert buf.execute(
            "SELECT COUNT(*) c FROM events WHERE run_id=?",
            ("rid1",)).fetchone()["c"] == 1  # only event 3 (never confirmed)
        assert buf.execute(
            "SELECT status FROM runs WHERE id=?", ("rid1",)
        ).fetchone()["status"] == "ok"
        buf.close()

        # recovery: flush merges tail + final status, clears buffer
        assert db.flush_buffer(_url(tmp_path / "primary.db")) == 1
        primary = db.open(_url(tmp_path / "primary.db"))
        assert primary.execute(
            "SELECT status FROM runs WHERE id=?", ("rid1",)
        ).fetchone()["status"] == "ok"
        assert primary.execute(
            "SELECT COUNT(*) c FROM events WHERE run_id=?",
            ("rid1",)).fetchone()["c"] == 3  # 2 + merged tail, no dupes
        primary.close()
        buf = db.open_buffer()
        assert buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 0
        assert buf.execute("SELECT COUNT(*) c FROM events"
                           ).fetchone()["c"] == 0
        buf.close()
    finally:
        dbmod.BUFFER_DB = orig_buffer
        dbmod.start_flusher = orig_flusher


def test_flush_no_buffer_file_is_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "nonexistent.db")
    assert db.flush_buffer(_url(tmp_path / "p.db")) == 0


def test_backlog_reported_while_down_cleared_after_flush(tmp_path,
                                                         monkeypatch):
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "buffer.db")
    monkeypatch.setattr(db, "start_flusher", lambda *a, **k: None)
    url = _url(tmp_path / "primary.db")
    real_open = db.open
    down = {"yes": True}

    def flaky_open(u=None):
        if down["yes"] and u == url:
            raise db.DatabaseError("primary down")
        return real_open(u)

    monkeypatch.setattr(db, "open", flaky_open)
    from afr.capture import run
    run(_Graph(), {"q": 1}, db_url=url)          # spills to the buffer

    down["yes"] = False
    assert db.flush_buffer_best_effort(url) == 0  # drained -> no backlog
    down["yes"] = True
    run(_Graph(), {"q": 1}, db_url=url)          # buffers again
    assert db.flush_buffer_best_effort(url) == 1  # backlog visible while down


def test_transient_lock_is_retried_not_spilled(tmp_path, monkeypatch):
    """sqlite 'database is locked' is contention, not an outage — retrying
    must keep the run on the primary instead of spilling it to the buffer."""
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "buffer.db")
    monkeypatch.setattr(db, "start_flusher", lambda *a, **k: None)
    import sqlite3 as sq

    real = db.open(_url(tmp_path / "primary.db"))

    class LockyPrimary:
        def __init__(self, inner):
            self.inner, self.first = inner, True

        def execute(self, sql, params=()):
            if self.first and sql.startswith("INSERT INTO events"):
                self.first = False
                raise sq.OperationalError("database is locked")
            return self.inner.execute(sql, params)

        def commit(self):
            self.inner.commit()

        def close(self):
            self.inner.close()

    conn = db.FailoverConn(LockyPrimary(real), "rid9", "L",
                           "2026-09-26T10:00:00", _url(tmp_path / "p.db"))
    conn.execute("INSERT INTO runs(id,label,status,started_at)"
                 " VALUES(?,?,?,?)",
                 ("rid9", "L", "running", "2026-09-26T10:00:00"))
    conn.commit()
    conn.execute("INSERT INTO events(run_id,seq,ts,kind,node,payload)"
                 " VALUES(?,?,?,?,?,?)",
                 ("rid9", 1, 0.0, "node_start", "n1", "{}"))
    conn.commit()
    conn.close()

    primary = db.open(_url(tmp_path / "primary.db"))
    assert primary.execute("SELECT COUNT(*) c FROM events WHERE run_id=?",
                           ("rid9",)).fetchone()["c"] == 1
    primary.close()
    buf = db.open_buffer()
    assert buf.execute("SELECT COUNT(*) c FROM runs"
                       ).fetchone()["c"] == 0  # never spilled
    buf.close()


def test_buffer_flush_is_routed_to_its_own_db(tmp_path, monkeypatch):
    """A buffered run is tagged with its db: another application's flush
    must not pull it into a foreign database."""
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "buffer.db")
    monkeypatch.setattr(db, "start_flusher", lambda *a, **k: None)
    url_a = _url(tmp_path / "a.db")
    url_b = _url(tmp_path / "b.db")
    real_open = db.open
    down = {"a": True}

    def flaky_open(u=None):
        if u == url_a and down["a"]:
            raise db.DatabaseError("down")
        return real_open(u)

    monkeypatch.setattr(db, "open", flaky_open)
    from afr.capture import run
    run(_Graph(), {"q": 1}, db_url=url_a, label="for-a")

    assert db.flush_buffer(url_b) == 0  # b 的回灌碰不动 a 的数据
    buf = db.open_buffer()
    assert buf.execute("SELECT db_url FROM runs").fetchone()["db_url"] \
        == url_a
    buf.close()

    down["a"] = False
    assert db.flush_buffer(url_a) == 1  # a 恢复后自己的回灌生效
    buf = db.open_buffer()
    assert buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 0
    buf.close()


def test_flush_buffer_accepts_bare_path(tmp_path, monkeypatch):
    """flush_buffer 的 db_url 参数没归一化时,裸 Path 绑定参数会抛异常且被
    best_effort 吞掉——排空循环看起来在跑,实际一次都没执行过。"""
    monkeypatch.setattr(db, "BUFFER_DB", tmp_path / "buffer.db")
    primary_path = tmp_path / "p.db"
    url = _url(primary_path)
    buf = db.open_buffer()
    buf.execute("INSERT INTO runs(id, label, status, started_at, db_url)"
                " VALUES(?,?,?,?,?)", ("rid20", "L", "ok", url, url))
    buf.commit()
    buf.close()
    assert db.flush_buffer(primary_path) == 1  # 裸 Path,不是字符串
    buf = db.open_buffer()
    assert buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"] == 0
    buf.close()
