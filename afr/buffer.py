"""Outage buffering: sqlite spill while the primary DB is down, whole-run
flush + buffer clear the moment it recovers.

正式部署时中心库(MySQL/达梦)是不可控依赖:网络抖动/重启期间录制绝不能
丢数据、更不能拖挂业务流程。FailoverConn 把每次写入先发往主库,主库一旦
写失败,未确认的语句和后续所有写入转存本地 SQLite 缓冲;后台线程一旦探到
主库恢复,立即整 run 回灌并清空缓冲。
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from pathlib import Path

from . import db

BUFFER_DB = Path.home() / ".afr" / "buffer.db"

_RUNS_COLS = ("id", "label", "status", "started_at", "finished_at", "error",
              "fork_of")
_TABLE_COLS = {
    "events": ("run_id", "seq", "ts", "kind", "node", "payload"),
    "llm_calls": ("run_id", "seq", "node", "model", "key_hash",
                  "request_json", "response_json", "kind", "tokens", "dur",
                  "params_json", "meta_json"),
    "tool_calls": ("run_id", "seq", "node", "tool_name", "args_hash",
                   "args_json", "result_json", "kind"),
}


def open_buffer() -> db.DB:
    """The local spill buffer (always sqlite, same schema as the primary).

    Plus a buffer-only column: runs.db_url — each buffered run remembers
    which database it belongs to, so a flush can never deliver it to a
    different application's database.
    """
    conn = db._open_sqlite(str(BUFFER_DB))
    try:
        conn.execute("ALTER TABLE runs ADD COLUMN db_url TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already there
    return conn


class _EmptyCursor:
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter(())


_LOCK_RETRIES = 3
_LOCK_RETRY_DELAY = 0.3


def _transient_lock(exc: Exception) -> bool:
    """Busy-contention errors are NOT an outage: sqlite 'database is locked'
    under concurrent writers, MySQL 1205 (lock wait timeout) / 1213
    (deadlock). Retry a few times before even considering a spill."""
    code = getattr(exc, "args", [None])[0]
    if code in (1205, 1213):
        return True
    msg = str(exc).lower()
    return "is locked" in msg or "lock wait" in msg or "deadlock" in msg


def _retry_locks(fn, exc: Exception):
    """Retry fn while it keeps failing with transient lock errors.

    Returns (True, result) on success; (False, last_exc) when the retries
    run out or the failure is not lock-shaped.
    """
    for _ in range(_LOCK_RETRIES):
        if not _transient_lock(exc):
            return False, exc
        time.sleep(_LOCK_RETRY_DELAY)
        try:
            return True, fn()
        except Exception as next_exc:
            exc = next_exc
    return False, exc


class FailoverConn:
    """Primary-DB facade that spills to the sqlite buffer on outage.

    - every write goes to the primary first; the moment one fails, the
      not-yet-confirmed statements are replayed into BUFFER_DB (with a
      reconstructed run row) and all further writes land there;
    - one RLock serializes execute/commit/close: LangGraph parallel branches
      hit one run's Recorder from several threads, and the
      check-then-journal-then-send sequence must be atomic or a concurrent
      spill can swallow a statement (lost) or double-write it (the dup half
      is now also caught by the unique indexes at flush time);
    - transient lock contention (sqlite busy / MySQL 1205/1213) is retried
      first — it is not an outage, and spilling here would misroute the
      run when the buffer later flushes;
    - the journal only ever holds the current unconfirmed batch (the
      recorder commits after every statement), so replaying it can never
      duplicate rows already committed on the primary — and the one
      ambiguity a journal cannot see (commit succeeded but the ack was
      lost) is absorbed by the unique indexes when the buffer flushes;
    - buffered rows are tagged with the db_url they belong to: a flush
      only ever returns runs to THEIR database, never to whichever
      process happens to recover first;
    - a background flusher moves buffered runs back into the primary and
      clears them as soon as it is reachable again.
    """

    def __init__(self, primary, run_id: str, label: str, started: str,
                 db_url: str):
        self._primary = primary          # None = primary down at run start
        self._rid = run_id
        self._label = label or ""
        self._started = started
        self._db_url = db_url
        self._buffer: db.DB | None = None
        self._failed = primary is None
        self._journal: list[tuple[str, tuple]] = []
        self._lock = threading.RLock()   # execute/commit/close/_spill 串行化

    def execute(self, sql, params=()):
        with self._lock:
            if self._failed:
                if self._buffer is None:
                    self._spill()
                cur = self._buffer.execute(sql, params)
                self._buffer.commit()
                return cur
            self._journal.append((sql, tuple(params)))
            try:
                return self._primary.execute(sql, params)
            except Exception as exc:
                ok, res = _retry_locks(
                    lambda: self._primary.execute(sql, params), exc)
                if ok:
                    return res
                self._failed = True
                self._spill()  # replays the journal, including this statement
                return _EmptyCursor()

    def commit(self):
        with self._lock:
            if self._failed:
                self._buffer.commit()
                return
            try:
                self._primary.commit()
                self._journal.clear()
            except Exception as exc:
                ok, _ = _retry_locks(self._primary.commit, exc)
                if ok:
                    self._journal.clear()
                    return
                self._failed = True
                self._spill()
                self._buffer.commit()

    def close(self):
        with self._lock:
            # Down-at-start runs insert their run row only AFTER _spill() ran,
            # so the db_url tag inside _spill() found no row yet — tag it now
            # (the IS NULL/'' guard keeps this idempotent with _spill's tag).
            if self._buffer is not None:
                try:
                    self._buffer.execute(
                        "UPDATE runs SET db_url=? WHERE id=?"
                        " AND (db_url IS NULL OR db_url='')",
                        (self._db_url, self._rid))
                    self._buffer.commit()
                except Exception:
                    pass
            for c in (self._primary, self._buffer):
                if c is not None:
                    try:
                        c.close()
                    except Exception:
                        pass

    def _spill(self):
        if self._buffer is None:
            self._buffer = open_buffer()
        for sql, params in self._journal:
            self._buffer.execute(sql, params)
        # Only reconstruct the run row when statements were actually sent to
        # the primary (mid-run failure): it may already be committed there,
        # and flush upserts the final status onto it. With an empty journal
        # (primary down at run start) the very statement triggering this
        # spill is the run INSERT itself — pre-writing the row here would
        # collide with it (UNIQUE constraint), and an ambiguous commit
        # failure must not resurrect a 'running' row over the final status.
        if self._journal:
            self._buffer.execute(
                "INSERT OR REPLACE INTO runs(id, label, status, started_at)"
                " VALUES(?,?,?,?)",
                (self._rid, self._label, "running", self._started))
        # Tag this run with the database it belongs to (covers both the
        # replayed INSERT row and the reconstruction above): flush delivers
        # runs only to their own db.
        self._buffer.execute(
            "UPDATE runs SET db_url=? WHERE id=?"
            " AND (db_url IS NULL OR db_url='')",
            (self._db_url, self._rid))
        self._buffer.commit()
        self._journal.clear()
        start_flusher(self._db_url)


def flush_buffer(db_url: str) -> int:
    """Move every buffered run into the primary DB; returns moved run count.

    Raises when the primary is unreachable (callers retry). Each run moves
    inside one primary transaction, and buffer rows are deleted only after
    that commit — a crash mid-flush leaves the buffer intact. Idempotency
    against crashes/racing flushers comes from the (run_id, seq) unique
    indexes + IGNORE inserts in _flush_run. A single bad run (e.g. an
    oversized payload the primary rejects) is skipped so it can never block
    the healthy runs behind it.
    """
    if not BUFFER_DB.exists():
        return 0
    db_url = db._coerce(db_url)  # bare Path (historical shorthand) -> sqlite:///…
    buf = open_buffer()
    try:
        # Only this db's runs (NULL/'' = rows spilled by older versions,
        # which carry no tag and stay flushable anywhere)
        rids = [r["id"] for r in buf.execute(
            "SELECT id FROM runs WHERE db_url=? OR db_url IS NULL"
            " OR db_url=''", (db_url,)).fetchall()]
        if not rids:
            return 0
        primary = db.open(db_url)
        try:
            moved = 0
            for rid in rids:
                try:
                    _flush_run(buf, primary, rid)
                    moved += 1
                except Exception:
                    continue  # poison run must not block the healthy ones
            return moved
        finally:
            primary.close()
    finally:
        buf.close()


def _flush_run(buf: db.DB, primary: db.DB, rid: str):
    row = buf.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
    if row is None:
        return  # 另一个进程刚把这个 run 灌完并清了缓冲
    vals = [row[c] for c in _RUNS_COLS]
    if primary.execute("SELECT id FROM runs WHERE id=?", (rid,)).fetchone():
        primary.execute(
            "UPDATE runs SET label=?, status=?, started_at=?, finished_at=?,"
            " error=?, fork_of=? WHERE id=?",
            (vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], rid))
    else:
        primary.execute(
            "INSERT INTO runs(id, label, status, started_at, finished_at,"
            " error, fork_of) VALUES(?,?,?,?,?,?,?)", vals)
    for table, cols in _TABLE_COLS.items():
        rows = buf.execute(
            f"SELECT {','.join(cols)} FROM {table} WHERE run_id=?",
            (rid,)).fetchall()
        ph = ",".join("?" * len(cols))
        # IGNORE 插入 + (run_id, seq) 唯一索引 = 幂等:「已提交但未收到确认」
        # 的 journal 重放、flush 中途崩溃后的重试、多进程并发回灌,第二次
        # 写同一行都是无害 no-op。dm 走 MySQL 兼容模式,支持 INSERT IGNORE
        ignore = " OR IGNORE" if primary.dialect.name == "sqlite" else " IGNORE"
        for r in rows:
            primary.execute(
                f"INSERT{ignore} INTO {table}({','.join(cols)}) VALUES({ph})",
                tuple(r[c] for c in cols))
    primary.commit()
    for table in _TABLE_COLS:  # success → clear this run from the buffer
        buf.execute(f"DELETE FROM {table} WHERE run_id=?", (rid,))
    buf.execute("DELETE FROM runs WHERE id=?", (rid,))
    buf.commit()


_FLUSHER: threading.Thread | None = None
_FLUSHER_LOCK = threading.Lock()


def start_flusher(db_url: str):
    """Spawn (once) the daemon thread retrying flush every few seconds."""
    global _FLUSHER
    with _FLUSHER_LOCK:
        if _FLUSHER and _FLUSHER.is_alive():
            return
        _FLUSHER = threading.Thread(target=_flush_loop, args=(db_url,),
                                    daemon=True, name="afr-buffer-flush")
        _FLUSHER.start()


def _flush_loop(db_url: str):
    while True:
        time.sleep(3)
        try:
            n = flush_buffer(db_url)
            if n:
                print(f"[afr] 数据库已恢复，缓冲数据已回灌 {n} 个 run",
                      file=sys.stderr)
            if buffer_backlog() == 0:  # 缓冲真正清空才算完工(坏 run 不退出)
                return
        except Exception:
            continue  # primary still down; keep retrying


def buffer_backlog() -> int:
    """Runs currently sitting in the local buffer (0 when none/healthy)."""
    if not BUFFER_DB.exists():
        return 0
    try:
        buf = open_buffer()
        try:
            return buf.execute("SELECT COUNT(*) c FROM runs").fetchone()["c"]
        finally:
            buf.close()
    except Exception:
        return 0


def flush_buffer_best_effort(db_url: str) -> int:
    """Recover outage leftovers opportunistically; returns backlog count.

    Called at every afr.run(): a healthy primary drains the buffer (0);
    an unreachable one leaves the backlog reported so callers can warn.
    """
    try:
        flush_buffer(db_url)
    except Exception:
        pass  # still down — this run's writes will spill to the buffer again
    return buffer_backlog()
