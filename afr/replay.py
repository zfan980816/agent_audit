"""T4 — deterministic replay with run-scoped stubs.

Review decisions implemented here:
- D3=A: lookups read ONLY the replayed run's own capture rows
  (content key within run scope). A replay of the FAILED run can never
  fetch the PASSING run's response. New responses write to a fork
  session; the source run stays read-only.
- D4=B: tool-stub key = (run_id, node_id, tool_name, args_hash);
  a miss triggers interactive consent (side-effect warning, default
  NO). Declining aborts; consenting executes for real and records.
- D5=A: no threshold warning. Every replay ends with raw hit-rate
  telemetry + the mismatch list; judgement stays with the user.
- Design "失败重放语义": a captured error response is re-raised
  verbatim on replay — it is NEVER treated as a cache miss (no real
  call is silently made past the failure point).
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from contextlib import contextmanager

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import BaseTool

from . import db
from .capture import canonical_json, content_hash, llm_key, tool_args


class ToolMissDeclined(Exception):
    """User declined a real tool execution during replay (default answer)."""


class ReplayReproducedError(Exception):
    """The captured record at this point was an error; re-raised verbatim."""


def _to_messages_json(input) -> str:
    """Normalize invoke() input to the same shape capture stored."""
    if isinstance(input, str):
        from langchain_core.messages import HumanMessage
        return canonical_json([HumanMessage(input).model_dump()])
    if isinstance(input, ChatPromptTemplate):
        msgs = input.format_messages()
        return canonical_json([m.model_dump() for m in msgs])
    if hasattr(input, "to_messages"):
        msgs = input.to_messages()
        return canonical_json([m.model_dump() for m in msgs])
    if isinstance(input, (list, tuple)):
        return canonical_json([m.model_dump() if hasattr(m, "model_dump") else m
                               for m in input])
    return canonical_json([{"role": "user", "content": repr(input)}])


def _node_from_config(config) -> str:
    """Node name for stub keys — matching how capture recorded it.

    User code inside a node calls tool.invoke(...) WITHOUT config; the
    node's metadata travels in langchain's contextvar instead. Capture's
    callbacks see it, so replay must read the same source or the
    (run_id, node, ...) keys never agree.
    """
    try:
        md = (config or {}).get("metadata") or {}
    except Exception:
        md = {}
    if not md:
        try:
            # langchain_core 1.x renamed runnable.config -> runnables.config
            from langchain_core.runnables.config import var_child_runnable_config
            md = ((var_child_runnable_config.get() or {}).get("metadata")) or {}
        except Exception:
            md = {}
    return md.get("langgraph_node") or "-"


class ReplaySession:
    """Fork session: reads source run, writes only its own fork run."""

    def __init__(self, conn: db.DB, source_run_id: str,
                 assume_yes: bool = False):
        self.conn = conn
        self.source = source_run_id
        self.assume_yes = assume_yes
        self.fork_id = uuid.uuid4().hex[:12]
        self.llm_hits = self.llm_misses = 0
        self.tool_hits = self.tool_misses = 0
        self.mismatches: list[str] = []
        self.conn.execute(
            "INSERT INTO runs(id, label, status, started_at, fork_of)"
            " VALUES(?,?,?,?,?)",
            (self.fork_id, f"replay:{source_run_id}", "replaying",
             time.strftime("%Y-%m-%dT%H:%M:%S"), source_run_id))
        self.conn.commit()

    # -- lookups (source run only — D3) ----------------------------------
    def lookup_llm(self, model: str, messages_json: str):
        key = llm_key(self.source, model, messages_json,
                      canonical_json({"model": model}))
        return self.conn.execute(
            "SELECT * FROM llm_calls WHERE run_id=? AND key_hash=? LIMIT 1",
            (self.source, key)).fetchone()

    def lookup_tool(self, node: str, tool_name: str, args_json: str):
        ah = content_hash(args_json)
        return self.conn.execute(
            "SELECT * FROM tool_calls WHERE run_id=? AND node=? AND tool_name=?"
            " AND args_hash=? LIMIT 1",
            (self.source, node, tool_name, ah)).fetchone()

    # -- fork writes (source stays read-only) ------------------------------
    def record_llm(self, node, model, messages_json, response_json, kind):
        self.conn.execute(
            "INSERT INTO llm_calls(run_id, seq, node, model, key_hash,"
            " request_json, response_json, kind, tokens)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (self.fork_id, self.llm_hits + self.llm_misses + 1, node, model,
             llm_key(self.fork_id, model, messages_json,
                     canonical_json({"model": model})),
             messages_json, response_json, kind, None))
        self.conn.commit()

    def record_tool(self, node, tool_name, args_json, result_json, kind):
        self.conn.execute(
            "INSERT INTO tool_calls(run_id, seq, node, tool_name, args_hash,"
            " args_json, result_json, kind) VALUES(?,?,?,?,?,?,?,?)",
            (self.fork_id, 0, node, tool_name, content_hash(args_json),
             args_json, result_json, kind))
        self.conn.commit()

    # -- telemetry (D5: raw facts only, no threshold judgement) -------------
    def telemetry(self) -> dict:
        total = self.llm_hits + self.llm_misses + self.tool_hits + self.tool_misses
        hits = self.llm_hits + self.tool_hits
        return {
            "fork_run": self.fork_id,
            "total_calls": total,
            "hits": hits,
            "hit_rate": (hits / total) if total else 1.0,
            "llm_hits": self.llm_hits, "llm_misses": self.llm_misses,
            "tool_hits": self.tool_hits, "tool_misses": self.tool_misses,
            "mismatches": self.mismatches,
        }

    def _consent(self, kind: str, detail: str) -> bool:
        if self.assume_yes:
            return True
        print(f"\n[afr replay] {kind} 缓存未命中: {detail}")
        print("  真实执行可能有副作用（外部请求/写操作/费用）。")
        try:
            ans = input("  真实执行? [y/N] ").strip().lower()
        except EOFError:
            ans = ""
        return ans in ("y", "yes")


@contextmanager
def _patched(session: ReplaySession):
    orig_chat = BaseChatModel.invoke
    orig_tool = BaseTool.invoke

    def chat_invoke(self, input, config=None, *, stop=None, **kwargs):
        model = getattr(self, "model_name", None) or type(self).__name__
        mj = _to_messages_json(input)
        row = session.lookup_llm(model, mj)
        if row is not None:
            if row["kind"] == "error":
                session.llm_hits += 1
                raise ReplayReproducedError(row["response_json"])
            session.llm_hits += 1
            return AIMessage(**json.loads(row["response_json"]))
        session.llm_misses += 1
        session.mismatches.append(f"llm:{model}")
        out = orig_chat(self, input, config, stop=stop, **kwargs)
        msg = out if hasattr(out, "model_dump") else AIMessage(str(out))
        session.record_llm(_node_from_config(config), model, mj,
                           canonical_json(msg.model_dump()), "ok")
        return out

    def tool_invoke(self, input, config=None, **kwargs):
        name = getattr(self, "name", type(self).__name__)
        aj = tool_args(input)
        node = _node_from_config(config)
        row = session.lookup_tool(node, name, aj)
        if row is not None:
            if row["kind"] == "error":
                session.tool_hits += 1
                raise ReplayReproducedError(row["result_json"])
            session.tool_hits += 1
            return json.loads(row["result_json"])
        session.tool_misses += 1
        session.mismatches.append(f"tool:{node}/{name}")
        if not session._consent("tool", f"node={node} tool={name} args={aj[:120]}"):
            raise ToolMissDeclined(f"{node}/{name}")
        out = orig_tool(self, input, config, **kwargs)
        session.record_tool(node, name, aj, canonical_json(out), "ok")
        return out

    BaseChatModel.invoke = chat_invoke
    BaseTool.invoke = tool_invoke
    try:
        yield session
    finally:
        BaseChatModel.invoke = orig_chat
        BaseTool.invoke = orig_tool


def replay(graph, inputs, *, source_run_id: str, db_path=None, db_url=None,
           assume_yes: bool = False):
    """Deterministically replay a captured run against (possibly edited) code.

    Returns (result, telemetry). LLM/tool hits come from the source run's
    capture; misses either ask consent (tools) or execute for real (LLM),
    and all new responses land in the fork session.
    """
    from .capture import connect

    conn = connect(db_path, db_url=db_url)
    try:
        session = ReplaySession(conn, source_run_id, assume_yes=assume_yes)
        with _patched(session):
            try:
                result = graph.invoke(inputs)
                status = "ok"
            except Exception as exc:
                status = "failed"
                conn.execute(
                    "UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?",
                    (status, time.strftime("%Y-%m-%dT%H:%M:%S"),
                     f"{exc.__class__.__name__}: {exc}", session.fork_id))
                conn.commit()
                raise
            finally:
                conn.execute(
                    "UPDATE runs SET finished_at=? WHERE id=?",
                    (time.strftime("%Y-%m-%dT%H:%M:%S"), session.fork_id))
                conn.commit()
        tel = session.telemetry()
        print(_telemetry_text(tel), file=sys.stderr)
        return result, tel
    finally:
        conn.close()


def _telemetry_text(t: dict) -> str:
    lines = [
        "[afr replay telemetry]",
        f"  fork run   : {t['fork_run']}",
        f"  hit rate   : {t['hit_rate']:.0%} "
        f"({t['hits']}/{t['total_calls']})",
        f"  llm  hit/miss: {t['llm_hits']}/{t['llm_misses']}"
        f"   tool hit/miss: {t['tool_hits']}/{t['tool_misses']}",
    ]
    if t["mismatches"]:
        lines.append("  未命中清单  :")
        lines += [f"    - {m}" for m in t["mismatches"]]
        lines.append("  提示: 若你未做任何修改却出现大量未命中，"
                     "说明代码里存在隐藏非确定性（时间戳/random 等）。")
    return "\n".join(lines)
