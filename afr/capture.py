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
import sys
import threading
import time
import uuid

from langchain_core.callbacks import BaseCallbackHandler

from . import db

DEFAULT_DB = db.DEFAULT_DB  # re-export: cli/__init__ import this


def connect(db_path=None, db_url: str | None = None) -> db.DB:
    """Open (and migrate) the recording DB on any configured backend.

    Resolution lives in afr.db: explicit arg > $AFR_DB_URL > config file >
    sqlite default. `db_path` is the historical positional form (a path or
    None); `db_url` accepts a full backend URL.
    """
    return db.open(db_url or db_path)


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

    def __init__(self, conn: db.DB, run_id: str, label: str = ""):
        self.conn = conn
        self.run_id = run_id
        self.label = label
        self._seq = 0
        self._lock = threading.Lock()
        self._pending_llm: dict[str, dict] = {}
        self._pending_tool: dict[str, dict] = {}
        # run_id -> node name, captured at chain START (langchain ≥1.x only
        # puts langgraph_node in on_chain_start's metadata; chain ends and
        # llm/tool children must be attributed through their parent run)
        self._run_node: dict[str, str] = {}
        # checkpoint namespaces of node chains we already recorded — kills
        # duplicate chain layers (graph task vs node callable) and, together
        # with the '|' rule in _outer_node, keeps nested ReAct-agent
        # internals ('agent'/'tools' loop nodes) out of the node timeline
        self._seen_ns: set[str] = set()
        self._ended_ns: set[str] = set()

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

    @staticmethod
    def _outer_node(metadata) -> str:
        """Outer-graph node name. checkpoint_ns of an outer node is
        '<node>:<task-uuid>'; anything nested inside a subgraph (a ReAct
        agent's internal 'agent'/'tools' loop) carries
        '<outer>:<uuid>|<inner>:<uuid>' — those attribute to their OUTER
        node instead of polluting the timeline with loop nodes."""
        md = metadata or {}
        ns = md.get("langgraph_checkpoint_ns") or ""
        if ns:
            return ns.split("|")[0].split(":")[0] or "-"
        return (md.get("langgraph_node") or "-")

    @classmethod
    def _timeline_node(cls, metadata) -> str:
        """Node for the timeline: chains INSIDE a nested subgraph (ns
        contains '|') are not timeline rows — their llm/tool calls appear
        as children of the outer node instead (verified identical on
        langchain-core 1.3.2 and 1.4.8)."""
        if "|" in ((metadata or {}).get("langgraph_checkpoint_ns") or ""):
            return "-"
        return cls._outer_node(metadata)

    def _node_from(self, metadata, run_id=None, parent_run_id=None) -> str:
        """Node attribution for llm/tool callbacks: the outer node derived
        from checkpoint_ns (nested ReAct internals attribute outward), else
        the parent chain's mapped node (an llm/tool run's parent is the
        node chain that invoked it, mapped at its on_chain_start)."""
        node = self._outer_node(metadata)
        if node != "-":
            return node
        if parent_run_id is not None:
            node = self._run_node.get(str(parent_run_id), "-")
        if node == "-" and run_id is not None:
            node = self._run_node.get(str(run_id), "-")
        return node

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
                "node": self._node_from(metadata, run_id, parent_run_id),
                "t0": time.time(),
                "request_json": canonical_json([m.model_dump() for m in batch]),
                # invocation_params: temperature / max_tokens / stream ...
                # (LangSmith Attributes > Invocation Params 区)
                "params_json": canonical_json(
                    kwargs.get("invocation_params") or {}),
            }

        self._safe(store)

    def on_llm_end(self, response, *, run_id=None, parent_run_id=None,
                   metadata=None, **kwargs):
        pend = self._pending_llm.pop(str(run_id), None)

        def store():
            if pend is None:
                return
            msg = response.generations[0][0].message
            # 真实型号优先:OpenAI 兼容接口在 message.response_metadata 带回
            # model_name/model(glm-4.5 等);序列化类名(ChatOpenAI/FakeXxx)
            # 只做兜底——8 行全叫 ChatOpenAI 的瀑布图没法看
            rmeta = getattr(msg, "response_metadata", None) or {}
            real = rmeta.get("model_name") or rmeta.get("model")
            if real:
                pend["model"] = str(real)
            tokens = None
            try:
                usage = (response.llm_output or {}).get("token_usage") or {}
                tokens = int(usage.get("total_tokens", 0)) or None
            except Exception:
                pass
            # key stays model-only so replay lookup (same key recipe) matches;
            # params_json is display data (Attributes), not part of the key
            params = canonical_json({"model": pend["model"]})
            key = llm_key(self.run_id, pend["model"], pend["request_json"], params)
            self.conn.execute(
                "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
                " request_json, response_json, kind, tokens, dur,"
                " params_json, meta_json)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["model"], key,
                 pend["request_json"], canonical_json(msg.model_dump()), "ok",
                 tokens, max(0.0, time.time() - pend.get("t0", time.time())),
                 pend.get("params_json"),
                 canonical_json(response.llm_output or {})),
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
            # key stays model-only so replay lookup (same key recipe) matches;
            # params_json is display data (Attributes), not part of the key
            params = canonical_json({"model": pend["model"]})
            key = llm_key(self.run_id, pend["model"], pend["request_json"], params)
            self.conn.execute(
                "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
                " request_json, response_json, kind, tokens, params_json)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (self.run_id, self._next_seq(), pend["node"], pend["model"], key,
                 pend["request_json"],
                 canonical_json({"error": f"{error.__class__.__name__}: {error}"}),
                 "error", None, pend.get("params_json")),
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
                "node": self._node_from(metadata, run_id, parent_run_id),
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
        node = self._timeline_node(metadata)
        ns = (metadata or {}).get("langgraph_checkpoint_ns") or ""
        if node != "-" and ns not in self._seen_ns:
            self._seen_ns.add(ns)
            self._run_node[str(run_id)] = node
            self._safe(lambda: self._event(
                "node_start", node, {"inputs": _jsonable(inputs)}))

    def on_chain_end(self, outputs, *, run_id=None, parent_run_id=None,
                     metadata=None, **kwargs):
        node = self._timeline_node(metadata)
        if node == "-":
            node = self._run_node.get(str(run_id), "-")
        ns = (metadata or {}).get("langgraph_checkpoint_ns") or ""
        if node != "-" and (not ns or (ns in self._seen_ns
                                       and ns not in self._ended_ns)):
            if ns:
                self._ended_ns.add(ns)
            self._safe(lambda: self._event(
                "node_output", node, {"outputs": _jsonable(outputs)}))


def tool_args(input) -> str:
    """Canonical tool-args JSON shared by capture AND replay (R3-1 keying).

    Callbacks hand capture a string; replay's patched invoke sees the raw
    object. Both funnel through here so the args_hash always agrees.
    langchain's on_tool_start hands us str(dict) — a Python repr with
    single quotes — so after json.loads fails we retry literal_eval before
    falling back to the raw string (real-graph runs hit this; replay would
    otherwise never match a captured tool call).
    """
    obj = input
    if isinstance(input, str):
        try:
            obj = json.loads(input)
        except (ValueError, TypeError):
            try:
                import ast
                obj = ast.literal_eval(input)
            except (ValueError, SyntaxError):
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


def setup(db_url=None, *, view: bool = False, view_port: int = 7231):
    """One-call, in-code configuration: afr.setup(db_url=..., view=True).

    db_url then applies to every afr.run() in this process (an explicit
    db_url= argument to run() still wins). view=True serves the monitoring
    page inside the process — start the app, browse http://127.0.0.1:port.
    Returns the viewer URL when view=True (None if the port was taken).
    """
    if db_url:
        db.configure(db_url)
    if view:
        try:
            from .cli import start_viewer
            return start_viewer(db_url, view_port)
        except Exception as exc:  # 查看器起不来(缺 jinja2/uvicorn 等)只降级提示,
            # 绝不能让宿主应用因为监控页起不来而启动失败
            print(f"[afr] 内嵌监控页启动失败（录制不受影响）: {exc}", file=sys.stderr)
            return None
    return None


def _begin_run(label, db_path, db_url):
    """Shared preamble of run() / run_stream(): resolve the URL, recover
    outage leftovers, open a failover connection (primary=None = the db is
    down at start; writes spill to the local buffer)."""
    url = db.resolve_db_url(db_url or db_path)
    backlog = db.flush_buffer_best_effort(url)  # recover outage leftovers
    if backlog:
        print(f"[afr] 注意：{backlog} 个 run 仍在本地缓冲等待回灌"
              f"（主库不可达），恢复后自动写入", file=sys.stderr)
    rid = uuid.uuid4().hex[:12]
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        primary = db.open(url)
    except db.DatabaseError:
        primary = None
        print(f"[afr] 数据库不可达（{db.mask_password(url)}），"
              f"本次运行暂存本地缓冲，恢复后自动回灌", file=sys.stderr)
    conn = db.FailoverConn(primary, rid, label, started, url)
    return conn, rid, started


def _mark(conn, rid, status, error=None):
    """Finalize the run row. Bookkeeping must never kill the business flow
    — a failure here would otherwise replace the user's own exception."""
    try:
        conn.execute(
            "UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?",
            (status, time.strftime("%Y-%m-%dT%H:%M:%S"), error, rid))
        conn.commit()
    except Exception:
        pass


def _insert_run_row(conn, rid, label, started, graph):
    conn.execute(
        "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
        (rid, label or getattr(graph, "name", "") or "", "running", started),
    )
    conn.commit()


def run(graph, inputs, *, label: str = "", db_path=None, db_url=None):
    """The one-function API: run a graph under the flight recorder.

    Mirrors graph.invoke(inputs). The run's own exceptions propagate
    unchanged (the recorder must never mask a real failure); the run row
    is marked failed and the error stored first. `db_url` targets any
    backend (mysql://…, dm://…); `db_path` stays the sqlite shorthand.

    If the configured DB is unreachable (or dies mid-run), recording
    spills to the local sqlite buffer and a background flusher writes it
    back — and clears the buffer — the moment the DB recovers.
    """
    conn, rid, started = _begin_run(label, db_path, db_url)
    try:
        _insert_run_row(conn, rid, label, started, graph)
        handler = Recorder(conn, rid, label)
        try:
            result = graph.invoke(inputs, config={"callbacks": [handler]})
            _mark(conn, rid, "ok")
            return result
        except Exception as exc:  # the user's failure: record, then re-raise
            _mark(conn, rid, "failed", f"{exc.__class__.__name__}: {exc}")
            raise
    finally:
        conn.close()


async def run_stream(graph, inputs, *, label: str = "", db_path=None,
                     db_url=None, stream_mode="updates"):
    """Streaming twin of run(): mirrors graph.astream(inputs, stream_mode=…)
    chunk-for-chunk while the flight recorder listens on the same callbacks.

    Drop-in replacement for the astream loop of a live API/UI:

        async for chunk in afr.run_stream(g, state, stream_mode="updates"):

    stream_mode passes through untouched (single mode yields chunks, a
    mode list yields (mode, chunk) pairs — exactly what the consumer gets
    from the graph). The run row is finalized when the generator finishes;
    the consumer's exceptions propagate unchanged (recorded as failed).
    """
    conn, rid, started = _begin_run(label, db_path, db_url)
    try:
        _insert_run_row(conn, rid, label, started, graph)
        handler = Recorder(conn, rid, label)
        try:
            async for chunk in graph.astream(
                    inputs, stream_mode=stream_mode,
                    config={"callbacks": [handler]}):
                yield chunk
            _mark(conn, rid, "ok")
        except Exception as exc:  # the user's failure: record, then re-raise
            _mark(conn, rid, "failed", f"{exc.__class__.__name__}: {exc}")
            raise
        except BaseException as exc:  # GeneratorExit/CancelledError:消费方提前
            # 关闭了流(浏览器断开 SSE、任务取消)——同步落终态(此处不得 await),
            # 否则 run 永久卡 running;随后原样重抛保持关闭协议
            _mark(conn, rid, "failed", f"{exc.__class__.__name__}: 流被提前中断")
            raise
    finally:
        conn.close()
