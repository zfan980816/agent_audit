"""T6 — viewer tests: three routes render, corrupt DB exits non-zero (C1)."""

import pytest
from fastapi.testclient import TestClient

from afr.capture import canonical_json, connect
from afr.cli import create_app, main


def _seed(db, run_ids):
    conn = connect(db)
    for rid, status, outputs in run_ids:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
            (rid, "t", status, "2026-09-25T00:00:00"))
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (rid, 1, 0.0, "node_start", "researcher",
             canonical_json({"inputs": outputs})))
    conn.commit()
    conn.close()


def test_runs_list_page(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []})])
    client = TestClient(create_app(db))
    r = client.get("/")
    assert r.status_code == 200 and "#fa" in r.text and 'title="失败"' in r.text


def test_aborted_runs_not_counted_as_failures(tmp_path):
    """流中断是 aborted 不是业务失败:失败 banner 只数 failed,列表用
    「已中断」图标区分(否则「停止生成」会把服务失败率虚高到不可信)。"""
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []}),
               ("ab", "aborted", {"sources": []})])
    client = TestClient(create_app(db))
    r = client.get("/")
    assert r.status_code == 200
    assert ">1</b> 次失败" in r.text          # 只数 failed,aborted 不进 banner
    assert ">2</b> 次失败" not in r.text
    assert 'title="已中断"' in r.text           # 列表行可区分
    flt = client.get("/", params={"status": "aborted"})
    # 用 sub">#id</span> 锚定列表行,裸 "#ab" 会撞上 CSS 里的十六进制色值
    assert 'sub">#ab' in flt.text and 'sub">#fa' not in flt.text


def test_tree_falls_back_to_flat_calls_without_langgraph(tmp_path):
    """纯 LangChain 链(无 node_start 事件)的详情页不能空白:LLM/工具调用
    平铺成调用级时间轴——数据在库里,只是没有节点挂载点(合成根节点承载)。"""
    db = tmp_path / "t.db"
    conn = connect(db)
    conn.execute(
        "INSERT INTO runs(id,label,status,started_at) VALUES(?,?,?,?)",
        ("nl", "t", "ok", "2026-09-25T00:00:00"))
    conn.execute(
        "INSERT INTO llm_calls(run_id,seq,node,model,key_hash,request_json,"
        " response_json,kind,tokens,dur) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ("nl", 1, "-", "glm-4.5", "k", '{"type":"human","content":"hi"}',
         '{"type":"ai","content":"ok"}', "ok", 10, 0.2))
    conn.execute(
        "INSERT INTO tool_calls(run_id,seq,node,tool_name,args_hash,"
        " args_json,result_json,kind) VALUES(?,?,?,?,?,?,?,?)",
        ("nl", 2, "-", "echo", "a", "{}", '"ok"', "ok"))
    for seq, kind in ((1, "llm"), (2, "tool")):  # Recorder 总会写这两条事件
        conn.execute(
            "INSERT INTO events(run_id,seq,ts,kind,node,payload)"
            " VALUES(?,?,?,?,?,?)", ("nl", seq, 0.1 * seq, kind, "-", "{}"))
    conn.commit()
    conn.close()
    frag = TestClient(create_app(db)).get("/run/nl/tree")
    assert frag.status_code == 200
    assert "调用序列" in frag.text          # 合成根节点
    assert "glm-4.5" in frag.text           # LLM 调用可见
    assert "echo" in frag.text              # 工具调用可见


def test_run_detail_page(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []})])
    client = TestClient(create_app(db))
    r = client.get("/run/fa")
    assert r.status_code == 200 and "researcher" in r.text
    frag = client.get("/run/fa/tree")
    assert frag.status_code == 200 and "sources" in frag.text


def test_diff_page_first_divergence(tmp_path):
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []}),
               ("pb", "ok", {"sources": ["u1"]})])
    client = TestClient(create_app(db))
    r = client.get("/diff", params={"a": "fa", "b": "pb"})
    assert r.status_code == 200 and "首个分歧" in r.text


def test_diff_page_unaligned(tmp_path):
    db = tmp_path / "t.db"
    conn = connect(db)
    for rid, node in [("a", "writer"), ("b", "critic")]:
        conn.execute(
            "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
            (rid, "t", "ok", "2026-09-25T00:00:00"))
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (rid, 1, 0.0, "node_start", node, canonical_json({"inputs": {}})))
    conn.commit()
    conn.close()
    client = TestClient(create_app(db))
    r = client.get("/diff", params={"a": "a", "b": "b"})
    assert r.status_code == 200 and "不可对齐" in r.text


def test_empty_db_guide_page(tmp_path):
    client = TestClient(create_app(tmp_path / "t.db"))
    r = client.get("/")
    assert r.status_code == 200 and "暂无录制" in r.text


def test_stats_page_and_failure_banner(tmp_path):
    """D17 A+B: monitoring overview renders; failed-run banner appears."""
    db = tmp_path / "t.db"
    _seed(db, [("fa", "failed", {"sources": []}),
               ("pb", "ok", {"sources": ["u1"]})])
    client = TestClient(create_app(db))
    r = client.get("/stats")
    assert r.status_code == 200 and "监控概览" in r.text
    assert "失败" in r.text and "¥" in r.text  # per-flow table + cost column
    home = client.get("/")
    assert "次失败" in home.text  # banner counts the 1 failed run


def test_corrupt_db_clear_error_nonzero_exit(tmp_path):
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"\x00not a sqlite file at all")
    with pytest.raises(SystemExit) as ei:
        main(["--db", str(bad), "diff", "a", "b"])
    assert ei.value.code == 2


def test_parallel_nodes_children_attributed(tmp_path):
    """并行节点的 llm 子行按各自 node 列挂载到同名节点,不得全部堆进
    最后启动的那个(2026-09-26 实战:所有 qwen 调用都进了 weather)。"""
    pytest.importorskip("langgraph")
    import afr
    from langchain_core.language_models.fake_chat_models import (
        FakeListChatModel)
    from langgraph.graph import END, START, StateGraph
    from typing_extensions import TypedDict

    class S(TypedDict):
        q: str
        r: str

    m1 = FakeListChatModel(responses=["a"])
    m2 = FakeListChatModel(responses=["b"])

    def node_a(state, config=None):
        return {"q": m1.invoke(["hi"], config=config).content}

    def node_b(state, config=None):
        return {"r": m2.invoke(["hi"], config=config).content}

    g = StateGraph(S)
    g.add_node("transport", node_a)
    g.add_node("weather", node_b)
    g.add_edge(START, "transport")
    g.add_edge(START, "weather")
    g.add_edge("transport", END)
    g.add_edge("weather", END)
    afr.run(g.compile(), {"q": "x"}, db_path=tmp_path / "p.db", label="par")

    import sqlite3
    from afr.cli import _open_db, _trace_tree
    rid = sqlite3.connect(tmp_path / "p.db").execute(
        "SELECT id FROM runs").fetchone()[0]
    tree = _trace_tree(_open_db(str(tmp_path / "p.db")), rid)
    kids = {n["node"]: [c["type"] for c in n["children"]]
            for n in tree["nodes"]}
    assert kids.get("transport") == ["llm"]  # 各归各,不串门
    assert kids.get("weather") == ["llm"]
