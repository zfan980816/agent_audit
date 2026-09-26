"""T6 — capture tests: event recording, A5 exception isolation, failures."""

import sqlite3
import threading

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

import afr
from afr.capture import Recorder, connect


def test_run_records_ok(tmp_path):
    db = tmp_path / "t.db"
    g = RunnableLambda(lambda x: {"n": x["n"] + 1})
    assert afr.run(g, {"n": 1}, db_path=db) == {"n": 2}
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT status FROM runs").fetchone()[0] == "ok"


def test_run_failure_propagates_and_is_recorded(tmp_path):
    db = tmp_path / "t.db"

    def boom(x):
        raise RuntimeError("kaput")

    with pytest.raises(RuntimeError, match="kaput"):
        afr.run(RunnableLambda(boom), {"n": 1}, db_path=db)
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT status, error FROM runs").fetchone()
    assert row[0] == "failed"
    assert "kaput" in row[1]


def test_llm_call_recorded_via_official_callbacks(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    handler = Recorder(conn, "run1")
    handler.on_chat_model_start(
        {"id": ["langchain", "FakeListChatModel"]},
        [[HumanMessage(content="hi")]], run_id="c1", metadata={})
    handler.on_llm_end(
        LLMResult(generations=[[ChatGeneration(message=AIMessage("hello"))]]),
        run_id="c1")
    rows = conn.execute("SELECT * FROM llm_calls").fetchall()
    assert len(rows) == 1 and rows[0]["kind"] == "ok"
    assert "FakeListChatModel" in rows[0]["model"]
    assert "hi" in rows[0]["request_json"]
    assert "hello" in rows[0]["response_json"]
    conn.close()


def test_tool_call_recorded(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    handler = Recorder(conn, "run1")
    handler.on_tool_start({"name": "web_search"}, "query text", run_id="t1",
                          metadata={})
    handler.on_tool_end(["r1"], run_id="t1")
    rows = conn.execute("SELECT * FROM tool_calls").fetchall()
    assert len(rows) == 1 and rows[0]["tool_name"] == "web_search"
    assert rows[0]["kind"] == "ok" and "r1" in rows[0]["result_json"]
    conn.close()


def test_llm_error_recorded_as_error_kind(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    handler = Recorder(conn, "run1")
    handler.on_chat_model_start({"id": ["M"]}, [[HumanMessage("x")]],
                                run_id="e1", metadata={})
    handler.on_llm_error(ValueError("boom"), run_id="e1")
    row = conn.execute("SELECT kind, response_json FROM llm_calls").fetchone()
    assert row["kind"] == "error" and "boom" in row["response_json"]
    conn.close()


def test_chain_capture_end_to_end(tmp_path):
    """prompt | FakeModel through rec.run(): official callbacks fire."""
    db = tmp_path / "t.db"
    model = FakeListChatModel(responses=["hello world"])
    chain = ChatPromptTemplate.from_messages([("human", "{q}")]) | model
    afr.run(chain, {"q": "ping"}, db_path=db, label="e2e")
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM llm_calls").fetchone()[0] == 1
    conn.close()


def test_callback_exception_never_propagates(tmp_path):
    """A5: garbage payloads degrade to stderr; the user's run survives."""
    db = tmp_path / "t.db"
    conn = connect(db)
    handler = Recorder(conn, "run1")
    handler.on_llm_end(object(), run_id="garbage")          # no pending + junk
    handler.on_tool_end(object(), run_id="nope")            # junk output
    handler.on_chat_model_start(None, None, run_id="j2", metadata=None)  # junk
    assert True  # reaching here means nothing propagated
    conn.close()


def test_concurrent_runs_both_recorded(tmp_path):
    """A4/WAL: two parallel runs on one db file, both land intact."""
    db = tmp_path / "t.db"
    g = RunnableLambda(lambda x: {"n": x["n"] + 1})
    results = []
    errs = []

    def worker(i):
        try:
            results.append(afr.run(g, {"n": i}, db_path=db, label=f"w{i}"))
        except Exception as exc:  # noqa: BLE001
            errs.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errs and len(results) == 4
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 4
    conn.close()


def test_run_stream_records_langgraph_astream(tmp_path):
    """run_stream mirrors graph.astream chunk-for-chunk (stream_mode
    passthrough) while recording the run — the live API/UI integration."""
    import asyncio
    pytest.importorskip("langgraph")
    from afr import run_stream
    from examples.flaky_demo import build

    chunks = []

    async def consume():
        async for chunk in run_stream(build(), {"topic": "s"},
                                      db_path=tmp_path / "s.db",
                                      label="stream-lg"):
            chunks.append(chunk)

    try:
        asyncio.run(consume())
        final = "ok"
    except Exception:
        final = "failed"  # the demo fails ~50% by design — either way must record
    assert chunks  # updates 模式:节点每完成一个就 yield 一块,透传未吞
    conn = sqlite3.connect(tmp_path / "s.db")
    assert conn.execute(
        "SELECT status FROM runs WHERE label='stream-lg'").fetchone()[0] == final
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= 1
    conn.close()


def test_run_stream_records_failure_and_reraises(tmp_path):
    import asyncio
    pytest.importorskip("langgraph")
    from afr import run_stream
    from examples.flaky_demo import build, web_search

    def boom(query: str) -> list[str]:
        raise RuntimeError("search exploded")

    orig = web_search.func
    web_search.func = boom
    try:

        async def consume():
            async for _ in run_stream(build(), {"topic": "s"},
                                      db_path=tmp_path / "s.db",
                                      label="stream-err"):
                pass

        with pytest.raises(RuntimeError):
            asyncio.run(consume())
    finally:
        web_search.func = orig
    conn = sqlite3.connect(tmp_path / "s.db")
    row = conn.execute(
        "SELECT status, error FROM runs WHERE label='stream-err'").fetchone()
    assert row[0] == "failed" and "search exploded" in row[1]
    conn.close()
