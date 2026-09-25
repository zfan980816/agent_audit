"""T1 — Recorder: LangChain official callbacks -> SQLite (WAL).

Design refs (2026-09-25 eng review):
- D2=A: capture hooks the official callback API; monkeypatching is replay-only.
- A5: a failure inside the recorder must NEVER kill the user's run
  (every callback body is wrapped, errors degrade to stderr).
- A4: WAL + busy_timeout so parallel runs each write safely.
- Cache keys are run-scoped content keys (design Constraints + D3):
  llm  -> (run_id, model, messages_hash, params_hash)
  tool -> (run_id, node_id, tool_name, args_hash)   [R3-1, D4]
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path

from langchain_core.callbacks import BaseCallbackHandler

DEFAULT_DB = Path.home() / ".afr" / "runs.db"

# Same-process serialization for first-time schema creation: executescript
# takes its own transaction and busy_timeout does not reliably cover it,
# so concurrent connect() calls can race into 'database is locked'.
_SCHEMA_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, label TEXT, status TEXT,
  started_at TEXT, finished_at TEXT, error TEXT, fork_of TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER,
  ts REAL, kind TEXT, node TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS llm_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, node TEXT,
  model TEXT, key_hash TEXT, request_json TEXT, response_json TEXT,
  kind TEXT, tokens INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER, node TEXT,
  tool_name TEXT, args_hash TEXT, args_json TEXT, result_json TEXT, kind TEXT);
CREATE INDEX IF NOT EXISTS idx_llm_key ON llm_calls(run_id, key_hash);
CREATE INDEX IF NOT EXISTS idx_tool_key ON tool_calls(run_id, tool_name, args_hash);
CREATE INDEX IF NOT EXISTS idx_ev_run ON events(run_id, seq);
"""


def connect(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open (and migrate) the recording DB. WAL + busy_timeout per review A4."""
    path = Path(db_path) if db_path else DEFAULT_DB
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    with _SCHEMA_LOCK:
        conn.executescript(SCHEMA)
    return conn


def canonical_json(obj) -> str:
    """Stable JSON used for hashing (sorted keys, no whitespace)."""

    def default(o):
        if hasattr(o, "model_dump"):
            return o.model_dump()
        return repr(o)

    return json.dumps(obj, sort_keys=True, ensure_ascii=False, default=default)


def content_hash(*parts) -> str:
    import hashlib

    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def llm_key(run_id: str, model: str, messages_json: str, params_json: str) -> str:
    return content_hash(run_id, model, messages_json, params_json)


def tool_key(run_id: str, node: str, tool_name: str, args_json: str) -> str:
    return content_hash(run_id, node or "-", tool_name, args_json)


def _stderr(msg: str) -> None:
    print(f"[afr] recorder degraded: {msg}", file=sys.stderr)


class Recorder(BaseCallbackHandler):
    """Persists every LLM / tool / node event of one run. Never raises (A5)."""

    def __init__(self, conn: sqlite3.Connection, run_id: str, label: str = ""):
        self.conn = conn
        self.run_id = run_id
        self.label = label
        self._seq = 0
        self._lock = threading.Lock()
        self._pending_llm: dict[str, dict] = {}
        self._pending_tool: dict[str, dict] = {}

    # -- helpers ---------------------------------------------------------
    def _next_seq(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq

    def _safe(self, fn):
        """A5: wrap every callback body; degrade to stderr, never propagate."""
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - deliberate broad catch
            _stderr(f"{exc.__class__.__name__}: {exc}")

    def _event(self, kind: str, node: str | None, payload) -> None:
        self.conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (self.run_id, self._next_seq(), time.time(), kind, node,
             canonical_json(payload)),
        )
        self.conn.commit()

    @staticmethod
    def _node(metadata) -> str:
        return (metadata or {}).get("langgraph_node") or "-"

    # -- LLM callbacks ----------------------------------------------------
    def on_chat_model_start(self, serialized, messages, *, run_id=None,
                            parent_run_id=None, metadata=None, **kwargs):
        model = "?"
        self._safe(lambda: None)  # placeholder no-op keeps symmetry
        try:
            ids = (serialized or {}).get("id") or []
            model = ids[-1] if ids else (serialized or {}).get("name", "?")
        except Exception:
            pass
        # flatten to the last batch (the actual prompt content)
        batch = messages[-1] if messages else []

        def store():
            self._pending_llm[str(run_id)] = {
                "model": model,
                "node": self._node(metadata),
                "request_json": canonical_json([m.model_dump() for m in batch]),
            }

        self._safe(store)

    def on_llm_end(self, response, *, run_id=None, parent_run_id=None,
                   metadata=None, **kwargs):
        pend = self._pending_llm.pop(str(run_id), None)

        def store():
            if pend is None:
                return
            msg = response.generations[0][0].message
            tokens = None
            try:
                usage = (response.llm_output or {}).get("token_usage") or {}
                tokens = int(usage.get("total_tokens", 0)) or None
            except Exception:
                pass
            params = canonical_json({"model": pend["model"]})
            key = llm_key(self.run_id, pend["model"], pend["request_json"], params)
            self.conn.execute(
                "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
                " request_json, response_json, kind, tokens)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["model"], key,
                 pend["request_json"], canonical_json(msg.model_dump()), "ok", tokens),
            )
            self.conn.commit()
            self._event("llm", pend["node"], {"model": pend["model"], "kind": "ok"})

        self._safe(store)

    def on_llm_error(self, error, *, run_id=None, parent_run_id=None,
                     metadata=None, **kwargs):
        pend = self._pending_llm.pop(str(run_id), None)

        def store():
            if pend is None:
                return
            params = canonical_json({"model": pend["model"]})
            key = llm_key(self.run_id, pend["model"], pend["request_json"], params)
            self.conn.execute(
                "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
                " request_json, response_json, kind, tokens)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["model"], key,
                 pend["request_json"],
                 canonical_json({"error": f"{error.__class__.__name__}: {error}"}),
                 "error", None),
            )
            self.conn.commit()
            self._event("llm", pend["node"], {"model": pend["model"], "kind": "error"})

        self._safe(store)

    # -- tool callbacks ----------------------------------------------------
    def on_tool_start(self, serialized, input_str, *, run_id=None,
                      parent_run_id=None, metadata=None, **kwargs):
        def store():
            name = (serialized or {}).get("name") or kwargs.get("name") or "?"
            self._pending_tool[str(run_id)] = {
                "tool_name": name,
                "node": self._node(metadata),
                "args_json": tool_args(input_str),
            }

        self._safe(store)

    def on_tool_end(self, output, *, run_id=None, parent_run_id=None,
                    metadata=None, **kwargs):
        pend = self._pending_tool.pop(str(run_id), None)

        def store():
            if pend is None:
                return
            ah = content_hash(pend["args_json"])
            self.conn.execute(
                "INSERT INTO tool_calls(run_id, seq, node, tool_name, args_hash,"
                " args_json, result_json, kind) VALUES(?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["tool_name"],
                 ah, pend["args_json"], canonical_json(_jsonable(output)), "ok"),
            )
            self.conn.commit()
            self._event("tool", pend["node"],
                        {"tool": pend["tool_name"], "kind": "ok"})

        self._safe(store)

    def on_tool_error(self, error, *, run_id=None, parent_run_id=None,
                      metadata=None, **kwargs):
        pend = self._pending_tool.pop(str(run_id), None)

        def store():
            if pend is None:
                return
            ah = content_hash(pend["args_json"])
            self.conn.execute(
                "INSERT INTO tool_calls(run_id, seq, node, tool_name, args_hash,"
                " args_json, result_json, kind) VALUES(?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["tool_name"],
                 ah, pend["args_json"],
                 canonical_json({"error": f"{error.__class__.__name__}: {error}"}),
                 "error"),
            )
            self.conn.commit()
            self._event("tool", pend["node"],
                        {"tool": pend["tool_name"], "kind": "error"})

        self._safe(store)

    # -- node-level state snapshots (LangGraph nodes surface as chains) ----
    def on_chain_start(self, serialized, inputs, *, run_id=None,
                       parent_run_id=None, metadata=None, **kwargs):
        node = self._node(metadata)
        if node != "-":
            self._safe(lambda: self._event(
                "node_start", node, {"inputs": _jsonable(inputs)}))

    def on_chain_end(self, outputs, *, run_id=None, parent_run_id=None,
                     metadata=None, **kwargs):
        node = self._node(metadata)
        if node != "-":
            self._safe(lambda: self._event(
                "node_output", node, {"outputs": _jsonable(outputs)}))


def tool_args(input) -> str:
    """Canonical tool-args JSON shared by capture AND replay (R3-1 keying).

    Callbacks hand capture a string; replay's patched invoke sees the raw
    object. Both funnel through here so the args_hash always agrees.
    """
    obj = input
    if isinstance(input, str):
        try:
            obj = json.loads(input)
        except (ValueError, TypeError):
            obj = input
    return canonical_json(obj)


def _jsonable(obj):
    """Best-effort conversion of callback payloads to JSON-able values."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_jsonable(o) for o in obj]
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return repr(obj)


def run(graph, inputs, *, label: str = "", db_path=None):
    """The one-function API: run a graph under the flight recorder.

    Mirrors graph.invoke(inputs). The run's own exceptions propagate
    unchanged (the recorder must never mask a real failure); the run row
    is marked failed and the error stored first.
    """
    rid = uuid.uuid4().hex[:12]
    conn = connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
            (rid, label or getattr(graph, "name", "") or "", "running",
             time.strftime("%Y-%m-%dT%H:%M:%S")),
        )
        conn.commit()
        handler = Recorder(conn, rid, label)
        try:
            result = graph.invoke(inputs, config={"callbacks": [handler]})
            conn.execute("UPDATE runs SET status='ok', finished_at=? WHERE id=?",
                         (time.strftime("%Y-%m-%dT%H:%M:%S"), rid))
            conn.commit()
            return result
        except Exception as exc:  # the user's failure: record, then re-raise
            conn.execute(
                "UPDATE runs SET status='failed', finished_at=?, error=? WHERE id=?",
                (time.strftime("%Y-%m-%dT%H:%M:%S"),
                 f"{exc.__class__.__name__}: {exc}", rid))
            conn.commit()
            raise
    finally:
        conn.close()
