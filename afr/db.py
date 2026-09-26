"""Storage backends: sqlite (default) / mysql / dm (达梦 DM8).

One thin adapter, no ORM. All SQL in the package keeps `?` placeholders and
is written in the MySQL-compatible subset (DM8 runs COMPATIBLE_MODE=4, the
same playbook as the user's Java projects); per-dialect differences are
confined to DDL strings and this module:

- resolve_db_url: param > $AFR_DB_URL > ~/.afr/config.json > sqlite default
- open(url): dispatch to a driver, wrap it in a uniform DB facade
- DB.execute: translates `?` -> the driver's placeholder, returns rows that
  support both dict access (row["kind"]) and positional access (row[0]),
  matching sqlite3.Row — the rest of the codebase is unaware of the backend.

Rules for every future SQL string in this package (enforced by
tests/test_db.py):
- placeholders are always `?`; never put a literal `?` or a bare `%`
  inside SQL text (bind them as parameters instead).

The user only ever provides a connection URL — tables and indexes are
created automatically on first connect (zero manual DDL).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

DEFAULT_DB = Path.home() / ".afr" / "runs.db"
DEFAULT_URL = "sqlite:///" + str(DEFAULT_DB).replace("\\", "/")
CONFIG_PATH = Path.home() / ".afr" / "config.json"


# -- errors (backend-agnostic; cli catches DatabaseError for clean exit) ----
class DatabaseError(Exception):
    """Any backend failure surfaced to the user as a clean error."""


class ConfigurationError(DatabaseError):
    """Bad URL / unknown scheme / unreadable config."""


class DriverMissingError(DatabaseError):
    """Optional driver not installed; message says how to install it."""

    def __init__(self, backend: str, hint: str):
        super().__init__(f"{backend} 后端需要驱动: {hint}")
        self.backend = backend


# -- config resolution -----------------------------------------------------
def _coerce(s) -> str:
    """Bare path (no scheme) -> sqlite:///path; a real URL passes through."""
    s = str(s).replace("\\", "/")  # Windows Paths hand in backslashes
    return s if "://" in s else "sqlite:///" + s


def resolve_db_url(param: str | None = None,
                   env: dict | None = None) -> str:
    """Precedence: explicit param > $AFR_DB_URL > ~/.afr/config.json > default.

    With no param, env or config the result is byte-identical to the
    historical sqlite default, so existing behavior never shifts.
    """
    if param:
        return _coerce(param)
    env = os.environ if env is None else env
    if env.get("AFR_DB_URL"):
        return _coerce(env["AFR_DB_URL"])
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if cfg.get("db_url"):
            return _coerce(str(cfg["db_url"]))
    except (FileNotFoundError, ValueError, OSError):
        pass
    return DEFAULT_URL


def mask_password(url) -> str:
    """Hide the password in error messages: mysql://u:***@host/db."""
    url = str(url)  # callers may hand in a Path (historical sqlite shorthand)
    m = re.match(r"(.*://[^:/@]+:)([^@]+)(@.*)", url)
    return f"{m.group(1)}***{m.group(3)}" if m else url


# -- placeholder translation ------------------------------------------------
class Dialect:
    def __init__(self, name: str, placeholder: str):
        self.name = name
        self.placeholder = placeholder  # dmPython docs use qmark


DIALECTS = {
    "sqlite": Dialect("sqlite", "?"),
    "mysql": Dialect("mysql", "%s"),  # PyMySQL
    "dm": Dialect("dm", "?"),         # dmPython; if real-DM8 testing shows
    # it needs ":n" style, change this entry + add a renumbering translator
}

_QMARK_RE = re.compile(r"\?")


def translate(sql: str, dialect: Dialect) -> str:
    """`?` -> the dialect's placeholder (no-op for sqlite/dm).

    Safe as a blind regex because package rules forbid literal `?` inside
    SQL text (tests/test_db.py asserts this over all SQL constants).
    """
    if dialect.placeholder == "?":
        return sql
    return _QMARK_RE.sub(dialect.placeholder, sql)


# -- row facade (sqlite3.Row parity: dict access + positional access) -------
class Row(dict):
    def __init__(self, cols, values):
        super().__init__(zip(cols, values))
        self._cols = list(cols)

    def __getitem__(self, key):
        if isinstance(key, int):
            return dict.__getitem__(self, self._cols[key])
        return dict.__getitem__(self, key)


class Cursor:
    """Minimal cursor facade: fetchone/fetchall returning Row-compatible."""

    def __init__(self, raw, cols):
        self._raw = raw
        self._cols = cols

    def _wrap(self, r):
        # sqlite rows already carry names (row_factory on the raw conn)
        return r if isinstance(r, (sqlite3.Row, Row)) else Row(self._cols, r)

    def fetchone(self):
        r = self._raw.fetchone()
        return None if r is None else self._wrap(r)

    def fetchall(self):
        return [self._wrap(r) for r in self._raw.fetchall()]

    def __iter__(self):
        # several call sites do `for r in conn.execute(...)` directly
        while True:
            r = self._raw.fetchone()
            if r is None:
                return
            yield self._wrap(r)


class DB:
    """Uniform connection facade over sqlite3 / pymysql / dmPython."""

    def __init__(self, raw, dialect: Dialect):
        self._raw = raw
        self.dialect = dialect
        # mysql/dm connections are not thread-safe; the viewer shares one
        # connection across FastAPI threads, so serialize access (sqlite
        # took care of this via check_same_thread=False + busy_timeout)
        self._lock = threading.RLock()

    def execute(self, sql: str, params=()) -> Cursor:
        with self._lock:
            cur = self._raw.cursor()
            cur.execute(translate(sql, self.dialect), tuple(params))
            cols = [d[0] for d in (cur.description or [])]
            return Cursor(cur, cols)

    def commit(self):
        with self._lock:
            self._raw.commit()

    def rollback(self):
        with self._lock:
            self._raw.rollback()

    def close(self):
        with self._lock:
            self._raw.close()


# -- schema (auto-created on first connect; user runs zero DDL) -------------
SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, label TEXT, status TEXT,
  started_at TEXT, finished_at TEXT, error TEXT, fork_of TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER,
  ts REAL, kind TEXT, node TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS llm_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, node TEXT,
  model TEXT, key_hash TEXT, request_json TEXT, response_json TEXT,
  kind TEXT, tokens INTEGER, dur REAL, params_json TEXT, meta_json TEXT);
CREATE TABLE IF NOT EXISTS tool_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, node TEXT,
  tool_name TEXT, args_hash TEXT, args_json TEXT, result_json TEXT, kind TEXT);
CREATE INDEX IF NOT EXISTS idx_llm_key ON llm_calls(run_id, key_hash);
CREATE INDEX IF NOT EXISTS idx_tool_key ON tool_calls(run_id, tool_name, args_hash);
CREATE INDEX IF NOT EXISTS idx_ev_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
"""

# Same-process serialization for first-time schema creation: concurrent
# connect() calls can race on CREATE/ALTER regardless of backend.
_SCHEMA_LOCK = threading.Lock()

# column migrations shared by every backend; {json_type} renders per dialect
_MIGRATIONS = [
    ("llm_calls", "dur", "ALTER TABLE llm_calls ADD COLUMN dur DOUBLE"),
    ("llm_calls", "params_json",
     "ALTER TABLE llm_calls ADD COLUMN params_json {json_type}"),
    ("llm_calls", "meta_json",
     "ALTER TABLE llm_calls ADD COLUMN meta_json {json_type}"),
]


def _ensure_schema_sqlite(conn: sqlite3.Connection):
    conn.executescript(SCHEMA_SQLITE)
    for _, _, ddl in _MIGRATIONS:  # same try/except as the old capture code
        try:
            conn.execute(ddl.format(json_type="TEXT"))
        except sqlite3.OperationalError:
            pass  # column already exists


def _open_sqlite(path: str) -> DB:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    try:
        raw = sqlite3.connect(path, timeout=5.0, check_same_thread=False)
        raw.execute("PRAGMA journal_mode=WAL")
        raw.execute("PRAGMA busy_timeout=5000")
        raw.row_factory = sqlite3.Row
    except sqlite3.DatabaseError as exc:
        raise DatabaseError(f"sqlite: 无法打开 {path}: "
                            f"{exc.__class__.__name__}: {exc}") from exc
    with _SCHEMA_LOCK:
        _ensure_schema_sqlite(raw)
    return DB(raw, DIALECTS["sqlite"])


# -- outage buffering: sqlite spill + auto flush ----------------------------
# 正式部署时中心库(MySQL/达梦)是不可控依赖:网络抖动/重启期间录制绝不能
# 丢数据、更不能拖挂业务流程。FailoverConn 把每次写入先发往主库,主库一旦
# 写失败,未确认的语句和后续所有写入转存本地 SQLite 缓冲;后台线程一旦探到
# 主库恢复,立即整 run 回灌并清空缓冲。
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


def open_buffer() -> DB:
    """The local spill buffer (always sqlite, same schema as the primary)."""
    return _open_sqlite(str(BUFFER_DB))


class _EmptyCursor:
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter(())


class FailoverConn:
    """Primary-DB facade that spills to the sqlite buffer on outage.

    - every write goes to the primary first; the moment one fails, the
      not-yet-confirmed statements are replayed into BUFFER_DB (with a
      reconstructed run row) and all further writes land there;
    - the journal only ever holds the current unconfirmed batch (the
      recorder commits after every statement), so replaying it can never
      duplicate rows already committed on the primary;
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
        self._buffer: DB | None = None
        self._failed = primary is None
        self._journal: list[tuple[str, tuple]] = []

    def execute(self, sql, params=()):
        if self._failed:
            if self._buffer is None:
                self._spill()
            cur = self._buffer.execute(sql, params)
            self._buffer.commit()
            return cur
        self._journal.append((sql, tuple(params)))
        try:
            return self._primary.execute(sql, params)
        except Exception:
            self._failed = True
            self._spill()  # replays the journal, including this statement
            return _EmptyCursor()

    def commit(self):
        if self._failed:
            self._buffer.commit()
            return
        try:
            self._primary.commit()
            self._journal.clear()
        except Exception:
            self._failed = True
            self._spill()
            self._buffer.commit()

    def close(self):
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
        self._buffer.commit()
        self._journal.clear()
        start_flusher(self._db_url)


def flush_buffer(db_url: str) -> int:
    """Move every buffered run into the primary DB; returns run count.

    Raises when the primary is unreachable (callers retry). Each run moves
    inside one primary transaction, and buffer rows are deleted only after
    that commit — a crash mid-flush leaves the buffer intact, never
    half-lost and never duplicated.
    """
    if not BUFFER_DB.exists():
        return 0
    buf = open_buffer()
    try:
        rids = [r["id"] for r in buf.execute("SELECT id FROM runs").fetchall()]
        if not rids:
            return 0
        primary = open(db_url)
        try:
            for rid in rids:
                _flush_run(buf, primary, rid)
            return len(rids)
        finally:
            primary.close()
    finally:
        buf.close()


def _flush_run(buf: DB, primary: DB, rid: str):
    row = buf.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
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
        for r in rows:
            primary.execute(
                f"INSERT INTO {table}({','.join(cols)}) VALUES({ph})",
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
            if n == 0:  # buffer empty (or file gone) — job done
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


class ConnKeeper:
    """Keeps one viewer connection alive across server-side drops.

    MySQL kills idle connections (wait_timeout, 8h by default); without
    a probe the viewer turns every page into a 500 after a few idle
    hours. get() pings with a cheap SELECT 1 and transparently reopens.

    The probe is followed by rollback(): on a read-only connection with
    autocommit off, MySQL's default REPEATABLE READ freezes the read
    snapshot at the first SELECT — every later page would keep showing
    the data as of viewer startup, and new runs would never appear.
    Ending the read transaction after each probe gives every request a
    fresh snapshot.
    """

    def __init__(self, db_url: str):
        self._url = db_url
        self._conn: DB | None = None
        self._lock = threading.Lock()

    def get(self) -> DB:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.execute("SELECT 1").fetchone()
                    self._conn.rollback()  # fresh snapshot per request
                    return self._conn
                except Exception:
                    try:
                        self._conn.close()
                    except Exception:
                        pass
                    self._conn = None
            self._conn = open(self._url)
            return self._conn


# -- public factory ----------------------------------------------------------
def open(url: str | None = None) -> DB:
    """Open (and auto-migrate) a recording DB from a URL.

    sqlite:///path | mysql://user:pass@host:port/db | dm://user:pass@host:port?schema=X
    """
    url = resolve_db_url(url)
    scheme = url.split("://", 1)[0] if "://" in url else ""
    if scheme == "sqlite":
        return _open_sqlite(url[len("sqlite:///"):])
    if scheme == "mysql":
        return _open_mysql(url)
    if scheme in ("dm", "dm8"):
        return _open_dm(url)
    raise ConfigurationError(
        f"无法识别的数据库 URL: {mask_password(url)}"
        f"（支持 sqlite:///路径、mysql://、dm://）")


def _open_mysql(url: str) -> DB:
    try:
        import pymysql
    except ImportError:
        raise DriverMissingError(
            "mysql", "pip install agent-flight-recorder[mysql]")
    u = urlparse(url)
    database = u.path.lstrip("/")
    if not database:
        raise ConfigurationError(
            f"mysql URL 需要带库名: mysql://user:pass@host:3306/afr")
    try:
        raw = pymysql.connect(
            host=u.hostname or "127.0.0.1", port=u.port or 3306,
            user=unquote(u.username or "root"),
            password=unquote(u.password or ""),
            database=database, autocommit=False, charset="utf8mb4",
            # a half-open network (firewall tarpit) must never hang the
            # business run: fail fast, spill to the buffer, retry later
            connect_timeout=10, read_timeout=10, write_timeout=10)
    except Exception as exc:
        raise DatabaseError(
            f"mysql: 连接失败 ({mask_password(url)}): {exc}") from exc
    conn = DB(raw, DIALECTS["mysql"])
    try:
        with _SCHEMA_LOCK:
            _ensure_schema_probe(conn, "LONGTEXT")
    except Exception as exc:
        conn.close()
        if isinstance(exc, DatabaseError):
            raise
        raise DatabaseError(
            f"mysql: 初始化失败: {exc.__class__.__name__}: {exc}") from exc
    return conn


_IDENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _open_dm(url: str) -> DB:
    try:
        import dmPython
    except ImportError:
        try:
            import dmpython as dmPython  # unofficial PyPI wheel
        except ImportError:
            raise DriverMissingError(
                "dm", "从达梦安装介质 drivers/python 安装 dmPython"
                      "（或 pip install agent-flight-recorder[dm]）")
    u = urlparse(url)
    schema = (parse_qs(u.query).get("schema") or [None])[0]
    if schema and not _IDENT_RE.match(schema):
        raise ConfigurationError(f"dm URL 的 schema 名不合法: {schema}")
    try:
        raw = dmPython.connect(
            user=unquote(u.username or "SYSDBA").upper(),
            password=unquote(u.password or ""),
            server=u.hostname or "127.0.0.1", port=u.port or 5236)
    except Exception as exc:
        raise DatabaseError(
            f"dm: 连接失败 ({mask_password(url)}): {exc}") from exc
    conn = DB(raw, DIALECTS["dm"])
    try:
        if schema:
            conn.execute(f'SET SCHEMA "{schema}"')
            conn.commit()
        with _SCHEMA_LOCK:
            _ensure_schema_probe(conn, "CLOB")
    except Exception as exc:
        conn.close()
        if isinstance(exc, DatabaseError):
            raise
        raise DatabaseError(
            f"dm: 初始化失败: {exc.__class__.__name__}: {exc}") from exc
    return conn


# -- mysql / dm schema: probe-then-create (information_schema-free) --------
# DM8's information_schema completeness in compat mode is unverified, so
# existence is probed with plain SELECTs that work on every backend.
_TABLES = {
    "runs": """
CREATE TABLE runs(
  id VARCHAR(64) PRIMARY KEY, label VARCHAR(256), status VARCHAR(16),
  started_at VARCHAR(32), finished_at VARCHAR(32), error TEXT,
  fork_of VARCHAR(64))""",
    "events": """
CREATE TABLE events(
  id {auto} PRIMARY KEY, run_id VARCHAR(64), seq BIGINT,
  ts DOUBLE, kind VARCHAR(16), node VARCHAR(256), payload {json})""",
    "llm_calls": """
CREATE TABLE llm_calls(
  id {auto} PRIMARY KEY, run_id VARCHAR(64), seq BIGINT, node VARCHAR(256),
  model VARCHAR(256), key_hash VARCHAR(64), request_json {json},
  response_json {json}, kind VARCHAR(16), tokens BIGINT, dur DOUBLE,
  params_json {json}, meta_json {json})""",
    "tool_calls": """
CREATE TABLE tool_calls(
  id {auto} PRIMARY KEY, run_id VARCHAR(64), seq BIGINT, node VARCHAR(256),
  tool_name VARCHAR(256), args_hash VARCHAR(64), args_json {json},
  result_json {json}, kind VARCHAR(16))""",
}

_INDEXES = (
    "CREATE INDEX idx_llm_key ON llm_calls(run_id, key_hash)",
    "CREATE INDEX idx_tool_key ON tool_calls(run_id, tool_name, args_hash)",
    "CREATE INDEX idx_ev_run ON events(run_id, seq)",
    # list/stats pages sort by started_at; without this the home page is a
    # full-table filesort once runs reach tens of thousands
    "CREATE INDEX idx_runs_started ON runs(started_at)",
)

_ALREADY_EXISTS = ("duplicate", "already exist", "已存在", "exists",
                   "名已被使用", "具有该名称")


def _probe_ok(conn: DB, sql: str) -> bool:
    """True = query ran; False = object genuinely missing; else re-raise.

    A dead/half-open connection (InterfaceError, timeouts, MySQL 2006/2013)
    must NOT be mistaken for "table missing" — that would turn an outage
    into bogus DDL attempts. Only clean does-not-exist errors count as
    missing.
    """
    try:
        conn.execute(sql).fetchone()
        return True
    except Exception as exc:
        name = exc.__class__.__name__.lower()
        msg = str(exc).lower()
        if ("table" in msg or "exist" in msg or name == "programmingerror"
                or "42s02" in msg or "no such" in msg):
            return False
        raise


def _ensure_schema_probe(conn: DB, json_type: str):
    """Create missing tables/indexes/columns on mysql / dm.

    Called on every connect; the user never runs DDL by hand.
    """
    # distinguish "server unreachable" from "table missing": a basic query
    # must succeed before any probe result can be trusted
    try:
        conn.execute("SELECT 1").fetchone()
    except Exception as exc:
        raise DatabaseError(
            f"数据库连接后无法执行查询（网络半开或权限问题）: "
            f"{exc.__class__.__name__}: {exc}") from exc
    auto = "BIGINT AUTO_INCREMENT" if conn.dialect.name == "mysql" \
        else "BIGINT IDENTITY(1,1)"  # dm: identity works in every compat mode
    for table, ddl in _TABLES.items():
        if not _probe_ok(conn, f"SELECT COUNT(*) c FROM {table}"):
            try:
                conn.execute(ddl.format(auto=auto, json=json_type))
                conn.commit()
            except Exception as exc:  # another process created it first
                if not any(s in str(exc).lower() for s in _ALREADY_EXISTS):
                    raise DatabaseError(
                        f"建表失败 {table}: {exc.__class__.__name__}: {exc}"
                    ) from exc
    for ddl in _INDEXES:
        try:
            conn.execute(ddl)
            conn.commit()
        except Exception as exc:
            if not any(s in str(exc).lower() for s in _ALREADY_EXISTS):
                raise DatabaseError(f"建索引失败: {exc}") from exc
    for table, col, ddl in _MIGRATIONS:
        if not _probe_ok(conn, f"SELECT {col} FROM {table} LIMIT 1"):
            try:
                conn.execute(ddl.format(json_type=json_type))
                conn.commit()
            except Exception as exc:
                if not any(s in str(exc).lower() for s in _ALREADY_EXISTS):
                    raise DatabaseError(f"迁移失败 {table}.{col}: {exc}") from exc
