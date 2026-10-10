"""T6 — capture tests: event recording, A5 exception isolation, failures."""
import time

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


def test_concurrent_runs_both_recorded(tmp_path, monkeypatch):
    """A4/WAL: two parallel runs on one db file, both land intact.

    Under heavy machine load a statement can exhaust even the lock retries
    and spill to the buffer — the contract is every run EVENTUALLY lands
    (spill + flush is part of the pipeline), so drain before counting."""
    from afr import buffer as afr_buffer
    monkeypatch.setattr(afr_buffer, "BUFFER_DB", tmp_path / "buffer.db")
    monkeypatch.setattr(afr_buffer, "start_flusher", lambda *a, **k: None)
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
    backlog = 1
    for _ in range(40):  # 排空也可能撞锁,有界重试(生产由 flusher 线程兜底)
        backlog = afr_buffer.flush_buffer_best_effort(db)
        if not backlog:
            break
        time.sleep(0.25)
    conn = sqlite3.connect(db)
    got = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    conn.close()
    buf_state = ""
    if backlog or got != 4:  # 失败现场:数据是还在缓冲,还是真丢了
        buf = sqlite3.connect(afr_buffer.BUFFER_DB)
        buf_state = f"; buffer runs={buf.execute('SELECT COUNT(*) FROM runs').fetchone()[0]}"
        buf.close()
    assert got == 4, f"主库 {got}/4, 缓冲积压 {backlog}{buf_state}"


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


def test_setup_survives_viewer_startup_failure(monkeypatch):
    """监控页起不来(缺依赖等)只能降级,不能拖死宿主应用的启动。"""
    import afr.viewer as viewer
    from afr import capture as cap

    def boom(*a, **k):
        raise RuntimeError("no jinja2")

    monkeypatch.setattr(viewer, "start_viewer", boom)
    assert cap.setup(view=True) is None  # 吞掉并降级,不抛


def test_nested_react_agent_stays_out_of_timeline(tmp_path):
    """外层节点里跑 create_react_agent(TravelPlanning 实战结构):内层
    agent/tools 循环节点不得成为时间轴行;其 LLM/工具调用归属外层节点。
    2026-09-26 接入实战教训:内层每轮循环曾以 agent ×N 平铺污染瀑布图。"""
    pytest.importorskip("langgraph")
    from langchain_core.language_models.fake_chat_models import (
        FakeMessagesListChatModel)
    from langchain_core.messages import AIMessage
    from langchain_core.tools import tool
    from langgraph.graph import END, START, StateGraph
    from langgraph.prebuilt import create_react_agent
    from typing_extensions import TypedDict

    @tool
    def lookup(q: str) -> str:
        """Look something up in the fake database."""
        return "42"

    class _ToolFake(FakeMessagesListChatModel):  # react agent 需要 bind_tools
        def bind_tools(self, tools, **kw):
            return self  # 工具调用已写死在脚本消息里,绑定空实现即可

    model = _ToolFake(responses=[
        AIMessage("", tool_calls=[{"name": "lookup", "args": {"q": "x"},
                                   "id": "c1"}],
                  response_metadata={"model_name": "fake-glm"}),
        AIMessage("done", response_metadata={"model_name": "fake-glm"}),
    ])
    agent = create_react_agent(model, tools=[lookup])

    class S(TypedDict):
        q: str

    def outer(state, config=None):  # config 透传,内层回调才可见
        r = agent.invoke({"messages": [("user", state["q"])]}, config=config)
        return {"q": r["messages"][-1].content}

    g = StateGraph(S)
    g.add_node("transport", outer)
    g.add_edge(START, "transport")
    g.add_edge("transport", END)
    afr.run(g.compile(), {"q": "hi"}, db_path=tmp_path / "n.db",
            label="nested")

    conn = sqlite3.connect(tmp_path / "n.db")
    starts = [r[0] for r in conn.execute(
        "SELECT DISTINCT node FROM events WHERE kind='node_start'")]
    assert starts == ["transport"]  # 内层 'agent'/'tools' 不得出现
    outs = conn.execute(
        "SELECT COUNT(*) FROM events WHERE kind='node_output'").fetchone()[0]
    assert outs == 1  # graph task + node callable 双层 chain 只记一次输出
    assert conn.execute(  # 2 次模型调用(带工具调用 + 收尾)归属外层节点
        "SELECT COUNT(*) FROM llm_calls WHERE node='transport'"
    ).fetchone()[0] == 2
    assert conn.execute(  # 1 次工具调用归属外层节点
        "SELECT COUNT(*) FROM tool_calls WHERE node='transport'"
    ).fetchone()[0] == 1
    assert [r[0] for r in conn.execute(  # 真实型号优先于序列化类名
            "SELECT DISTINCT model FROM llm_calls")] == ["fake-glm"]
    conn.close()


def test_run_stream_abandoned_marks_aborted(tmp_path):
    """消费方提前关掉流(浏览器断开 SSE → GeneratorExit)必须落 aborted
    终态,不得永久卡 running。2026-09-26 实战教训;aborted 而非 failed——
    取消不是业务失败,不能虚高 banner/stats 的失败率。"""
    import asyncio
    pytest.importorskip("langgraph")
    from afr import run_stream
    from examples.flaky_demo import build

    async def abandon():
        gen = run_stream(build(), {"topic": "s"},
                         db_path=tmp_path / "a.db", label="stream-abandon")
        async for _ in gen:  # 拿到第一块就撤
            break
        await gen.aclose()   # 模拟 StreamingResponse 关闭生成器

    asyncio.run(abandon())
    conn = sqlite3.connect(tmp_path / "a.db")
    row = conn.execute(
        "SELECT status, error FROM runs WHERE label='stream-abandon'").fetchone()
    assert row is not None and row[0] == "aborted" and "提前中断" in row[1]
    conn.close()
