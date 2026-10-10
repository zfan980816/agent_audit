"""T6 — replay tests: run-scoped hits, misses, consent, fork isolation.

Covers the three review decisions:
- D3=A hit path: replay reads only the source run's rows, zero real calls
- D4=B consent: tool miss asks; default NO aborts, YES executes + records
- D5=A telemetry: hit counters + mismatch list are raw facts
- 失败重放语义: captured error rows re-raise, never silently re-call
"""

import json
from typing import ClassVar

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult, LLMResult
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from pydantic import ConfigDict

from afr.capture import Recorder, canonical_json, connect
from afr.replay import (ReplayReproducedError, ReplaySession, ToolMissDeclined,
                        _patched, replay)

MODEL_NAME = "CountingFake"


class CountingFake(BaseChatModel):
    n_real_calls: ClassVar[int] = 0

    @property
    def _llm_type(self):
        return "counting"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        type(self).n_real_calls += 1
        return ChatResult(generations=[
            ChatGeneration(message=AIMessage("real:" + messages[-1].content))])


class AliasFake(BaseChatModel):
    """ChatOpenAI-shaped fake: model_name is the REQUESTED alias, the served
    response echoes a different snapshot name via response_metadata."""
    model_config = ConfigDict(protected_namespaces=())  # 'model_name' field

    model_name: str = "gpt-4o"
    n_real_calls: ClassVar[int] = 0
    SERVED: ClassVar[str] = "gpt-4o-2024-08-06"

    @property
    def _llm_type(self):
        return "alias"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        type(self).n_real_calls += 1
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            "real:" + messages[-1].content,
            response_metadata={"model_name": self.SERVED}))])


@tool
def echo(query: str) -> str:
    """Echo the query."""
    return "echo:" + query


def _capture_llm(conn, run_id, human_text, reply, kind="ok", resp_meta=None):
    """Fabricate a captured LLM call exactly as Recorder would store it."""
    handler = Recorder(conn, run_id)
    handler.on_chat_model_start({"id": [MODEL_NAME]},
                                [[HumanMessage(content=human_text)]],
                                run_id="cap", metadata={})
    msg = AIMessage(reply, response_metadata=resp_meta) if resp_meta \
        else AIMessage(reply)
    if kind == "ok":
        handler.on_llm_end(LLMResult(generations=[[
            ChatGeneration(message=msg)]]), run_id="cap")
    else:
        handler.on_llm_error(ValueError(reply), run_id="cap")


def _chain():
    return ChatPromptTemplate.from_messages([("human", "{q}")]) | CountingFake()


def test_hit_zero_real_calls(tmp_path):
    """D3 hit path: same prompt -> stub serves, _generate never runs."""
    CountingFake.n_real_calls = 0
    db = tmp_path / "t.db"
    conn = connect(db)
    _capture_llm(conn, "src", "hi", "cached-answer")
    conn.close()

    result, tel = replay(_chain(), {"q": "hi"}, source_run_id="src",
                         db_path=db, assume_yes=True)
    assert CountingFake.n_real_calls == 0
    assert result.content == "cached-answer"
    assert tel["llm_hits"] == 1 and tel["llm_misses"] == 0
    assert tel["hit_rate"] == 1.0


def test_hit_when_served_model_differs_from_alias(tmp_path):
    """capture 的 key 在 response_metadata 覆盖之后计算(服务端实际型号,
    如 gpt-4o-2024-08-06),重放按请求别名(gpt-4o)查找——必须仍能命中,
    否则本应走缓存的调用会触发真实执行。"""
    AliasFake.n_real_calls = 0
    db = tmp_path / "t.db"
    conn = connect(db)
    _capture_llm(conn, "src", "hi", "cached-answer",
                 resp_meta={"model_name": AliasFake.SERVED})
    conn.close()

    chain = ChatPromptTemplate.from_messages([("human", "{q}")]) | AliasFake()
    result, tel = replay(chain, {"q": "hi"}, source_run_id="src",
                         db_path=db, assume_yes=True)
    assert AliasFake.n_real_calls == 0  # 缓存命中,零真实调用
    assert result.content == "cached-answer"
    assert tel["llm_hits"] == 1 and tel["llm_misses"] == 0


def test_miss_real_call_and_fork_written(tmp_path):
    """Changed prompt -> miss -> real call; new response lands in fork only."""
    CountingFake.n_real_calls = 0
    db = tmp_path / "t.db"
    conn = connect(db)
    _capture_llm(conn, "src", "hi", "cached-answer")
    conn.close()

    _, tel = replay(_chain(), {"q": "DIFFERENT"}, source_run_id="src",
                    db_path=db, assume_yes=True)
    assert CountingFake.n_real_calls == 1
    assert tel["llm_misses"] == 1 and tel["mismatches"] == [f"llm:{MODEL_NAME}"]

    conn = connect(db)
    src_rows = conn.execute(
        "SELECT COUNT(*) c FROM llm_calls WHERE run_id='src'").fetchone()["c"]
    fork_rows = conn.execute(
        "SELECT COUNT(*) c FROM llm_calls WHERE run_id=?", (tel["fork_run"],)
    ).fetchone()["c"]
    assert src_rows == 1 and fork_rows == 1  # source untouched, fork grew
    conn.close()


def test_run_scoping_never_crosses_runs(tmp_path):
    """D3 core: the passing run's answer must NOT leak into failed-run replay."""
    CountingFake.n_real_calls = 0
    db = tmp_path / "t.db"
    conn = connect(db)
    _capture_llm(conn, "passed", "hi", "answer-from-PASSING-run")
    conn.close()

    result, tel = replay(_chain(), {"q": "hi"}, source_run_id="failed",
                         db_path=db, assume_yes=True)
    assert CountingFake.n_real_calls == 1  # real call, not the other run's cache
    assert tel["llm_misses"] == 1
    assert result.content.startswith("real:")


def test_captured_error_reraised(tmp_path):
    """失败重放语义: error rows re-raise; no silent real call past the failure."""
    CountingFake.n_real_calls = 0
    db = tmp_path / "t.db"
    conn = connect(db)
    _capture_llm(conn, "src", "hi", "model exploded", kind="error")
    conn.close()

    with pytest.raises(ReplayReproducedError):
        replay(_chain(), {"q": "hi"}, source_run_id="src", db_path=db,
               assume_yes=True)
    assert CountingFake.n_real_calls == 0


def test_tool_hit_served_from_capture(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    handler = Recorder(conn, "src")
    handler.on_tool_start({"name": "echo"}, canonical_json({"query": "x"}),
                          run_id="t", metadata={})
    handler.on_tool_end("echo:x", run_id="t")
    conn.close()

    session = ReplaySession(connect(db), "src", assume_yes=True)
    with _patched(session):
        out = echo.invoke({"query": "x"})
    assert out == "echo:x"
    tel = session.telemetry()
    assert tel["tool_hits"] == 1 and tel["tool_misses"] == 0


def test_tool_miss_declined_by_default(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    conn = connect(db)  # no captured tool rows at all
    conn.close()

    session = ReplaySession(connect(db), "src", assume_yes=False)
    monkeypatch.setattr("builtins.input", lambda *a: "n")
    with _patched(session):
        with pytest.raises(ToolMissDeclined):
            echo.invoke({"query": "x"})


def test_tool_miss_consent_executes_and_records(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    conn = connect(db)
    conn.close()

    session = ReplaySession(connect(db), "src", assume_yes=False)
    monkeypatch.setattr("builtins.input", lambda *a: "y")
    with _patched(session):
        out = echo.invoke({"query": "y"})
    assert out == "echo:y"
    tel = session.telemetry()
    assert tel["tool_misses"] == 1
    conn = connect(db)
    fork = conn.execute(
        "SELECT result_json FROM tool_calls WHERE run_id=?",
        (tel["fork_run"],)).fetchone()
    assert "echo:y" in fork["result_json"]
    conn.close()


def test_replay_restores_source_entry_state(tmp_path):
    """inputs 缺省时,重放从源 run 捕获的首个 node_start 入口 state 起跑,
    而不是空 dict——否则重放从第 0 步就与源 run 分叉,「确定性重放」对
    真实生产 run 不成立。"""
    db = tmp_path / "t.db"
    conn = connect(db)
    conn.execute(
        "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
        ("src", "t", "ok", "2026-09-25T00:00:00"))
    conn.execute(
        "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
        " VALUES(?,?,?,?,?,?)",
        ("src", 1, 0.0, "node_start", "researcher",
         canonical_json({"inputs": {"topic": "多智能体", "sources": ["u1"]}})))
    conn.commit()
    conn.close()

    class ProbeGraph:
        def __init__(self):
            self.seen = "<untouched>"

        def invoke(self, inputs, config=None):
            self.seen = inputs
            return {"ok": True}

    probe = ProbeGraph()
    result, tel = replay(probe, source_run_id="src", db_path=db,
                         assume_yes=True)
    assert probe.seen == {"topic": "多智能体", "sources": ["u1"]}
    assert result == {"ok": True}


def test_multiple_tool_misses_get_unique_fork_seqs(tmp_path, monkeypatch):
    """fork 行也受 (run_id, seq) 唯一索引约束:同一 fork 里多次工具未命中
    必须各拿各的 seq,第二次写入不得撞唯一约束。"""
    db = tmp_path / "t.db"
    conn = connect(db)
    conn.close()

    session = ReplaySession(connect(db), "src", assume_yes=True)
    session.record_tool("n", "echo", canonical_json({"q": "1"}), '"1"', "ok")
    session.record_tool("n", "echo", canonical_json({"q": "2"}), '"2"', "ok")
    rows = session.conn.execute(
        "SELECT seq FROM tool_calls WHERE run_id=? ORDER BY seq",
        (session.fork_id,)).fetchall()
    assert [r["seq"] for r in rows] == [1, 2]
    session.conn.close()
