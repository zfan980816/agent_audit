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
import threading
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
            database=database, autocommit=False, charset="utf8mb4")
    except Exception as exc:
        raise DatabaseError(
            f"mysql: 连接失败 ({mask_password(url)}): {exc}") from exc
    conn = DB(raw, DIALECTS["mysql"])
    with _SCHEMA_LOCK:
        _ensure_schema_probe(conn, "LONGTEXT")
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
    except Exception:
        conn.close()
        raise
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
)

_ALREADY_EXISTS = ("duplicate", "already exist", "已存在", "exists",
                   "名已被使用", "具有该名称")


def _probe_ok(conn: DB, sql: str) -> bool:
    try:
        conn.execute(sql).fetchone()
        return True
    except Exception:
        return False


def _ensure_schema_probe(conn: DB, json_type: str):
    """Create missing tables/indexes/columns on mysql / dm.

    Called on every connect; the user never runs DDL by hand.
    """
    auto = "BIGINT AUTO_INCREMENT" if conn.dialect.name == "mysql" \
        else "BIGINT IDENTITY(1,1)"  # dm: identity works in every compat mode
    for table, ddl in _TABLES.items():
        if not _probe_ok(conn, f"SELECT COUNT(*) c FROM {table}"):
            try:
                conn.execute(ddl.format(auto=auto, json=json_type))
                conn.commit()
            except Exception as exc:  # another process created it first
                if not any(s in str(exc).lower() for s in _ALREADY_EXISTS):
                    raise DatabaseError(f"建表失败 {table}: {exc}") from exc
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
