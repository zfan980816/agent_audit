"""Flaky 3-agent demo: researcher -> writer -> critic.

The search tool randomly returns junk. When the researcher's output has
empty sources, the critic raises ValidationError -> the run fails.
Run it a few times to produce a FAILED + PASSING pair, then:

    rec view                      # open the 3-page viewer
    # in the viewer: /diff?a=<failed_id>&b=<passing_id>
    rec replay <failed_id> --entry examples.flaky_demo:build
"""

from __future__ import annotations

import random

from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict


class State(TypedDict):
    topic: str
    sources: list[str]
    draft: str
    final: str


@tool
def web_search(query: str) -> list[str]:
    """Search the web. Flaky on purpose: sometimes returns junk."""
    if random.random() < 0.5:
        return []  # junk -> researcher produces no sources -> critic fails
    return [f"https://example.com/{query.replace(' ', '-')}/{i}"
            for i in range(3)]


def researcher(state: State) -> dict:
    results = web_search.invoke({"query": f"{state['topic']} 2026"})
    return {"sources": results}


def writer(state: State) -> dict:
    src = "\n".join(f"- {s}" for s in state["sources"]) or "(no sources)"
    return {"draft": f"关于「{state['topic']}」的报告\n\n依据:\n{src}"}


def critic(state: State) -> dict:
    if not state["sources"]:
        raise ValueError(
            f"ValidationError: sources 为空，draft 不可信: {state['draft'][:60]}…")
    return {"final": state["draft"]}


def build() -> StateGraph:
    g = StateGraph(State)
    g.add_node("researcher", researcher)
    g.add_node("writer", writer)
    g.add_node("critic", critic)
    g.add_edge(START, "researcher")
    g.add_edge("researcher", "writer")
    g.add_edge("writer", "critic")
    g.add_edge("critic", END)
    return g.compile()


if __name__ == "__main__":
    from afr import run

    for i in range(4):
        try:
            result = run(build(), {"topic": "多智能体可观测性"}, label=f"demo-{i}")
            print(f"demo-{i}: PASS  final[:40]={result['final'][:40]!r}")
        except Exception as exc:
            print(f"demo-{i}: FAILED ({exc})")
