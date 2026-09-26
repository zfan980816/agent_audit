"""Nested-agent demo: TravelPlanning 结构最小复刻。

外层编排图的两个节点(transport/scenic)各自内嵌一个 create_react_agent
react 子图 —— 2026-09-26 实战里把瀑布图污染成 agent ×40 的正是这种结构。
录制修复后的预期:时间轴只有 transport/scenic 两行,内层循环不出现,
LLM/工具调用作为子行归属外层节点。

    AFR_DB_URL=mysql://… python examples/nested_demo.py   # 或默认 sqlite
"""

from __future__ import annotations

from langchain_core.language_models.fake_chat_models import (
    FakeMessagesListChatModel)
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import create_react_agent
from typing_extensions import TypedDict


class _ToolFake(FakeMessagesListChatModel):  # react agent 需要 bind_tools
    def bind_tools(self, tools, **kw):
        return self  # 工具调用已写死在脚本消息里


@tool
def query_train(origin: str, dest: str) -> str:
    """查询两地之间的火车班次与票价"""
    return f"{origin}→{dest} G102 09:30-13:45 二等座 ¥553"


def make_agent(final: str):
    # response_metadata 模拟真实 GLM 接口回传的型号——录制端会优先用它
    meta = {"model_name": "glm-4.5(模拟)", "total_cost": 0.01}
    return create_react_agent(_ToolFake(responses=[
        AIMessage("", tool_calls=[{"name": "query_train",
                                   "args": {"origin": "武汉", "dest": "西安"},
                                   "id": "c1"}],
                   response_metadata=meta),
        AIMessage(final, response_metadata=meta),
    ]), tools=[query_train])


class State(TypedDict):
    q: str
    transport_md: str
    scenic_md: str


def transport(state, config=None):  # config 透传,内层回调才可见
    r = make_agent("G102 已确认,午饭后抵达").invoke(
        {"messages": [("user", f"{state['q']} 火车")]}, config=config)
    return {"transport_md": r["messages"][-1].content}


def scenic(state, config=None):
    r = make_agent("Day1 兵马俑 → Day2 大唐不夜城").invoke(
        {"messages": [("user", f"{state['q']} 景点")]}, config=config)
    return {"scenic_md": r["messages"][-1].content}


def build():
    g = StateGraph(State)
    g.add_node("transport", transport)
    g.add_node("scenic", scenic)
    g.add_edge(START, "transport")
    g.add_edge("transport", "scenic")
    g.add_edge("scenic", END)
    return g.compile()


if __name__ == "__main__":
    from afr import run

    for i in range(2):
        result = run(build(), {"q": "武汉去西安三日游"}, label="nested-demo")
        print(f"nested-demo-{i}: PASS scenic={result['scenic_md']!r}")
