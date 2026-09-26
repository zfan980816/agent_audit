"""T3 — run-pair diff: node alignment + first divergence.

Known v0 limitation (design, R1-2): only topology-identical run pairs
align; branch/parallel/loop-divergent pairs render an explicit
"unaligned" placeholder instead of a wrong answer.
"""

from __future__ import annotations

import difflib
import json

MAX_DISPLAY_BYTES = 8 * 1024  # C2: truncate huge states in display layer


def node_timeline(conn, run_id: str):
    """Ordered [(node, state_at_entry)] from node_start events.

    A node's entry state IS the previous node's output — the handoff
    payload. Aligning on node_start is version-robust (function nodes
    don't reliably emit node_output) and pinpoints exactly the first
    divergent handoff: the first node whose INPUTS differ between runs.
    """
    rows = conn.execute(
        "SELECT node, payload FROM events WHERE run_id=? AND kind='node_start'"
        " ORDER BY seq", (run_id,)).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except Exception:
            payload = {"inputs": r["payload"]}
        out.append((r["node"], payload.get("inputs")))
    return out


def align(a_nodes, b_nodes):
    if [n for n, _ in a_nodes] == [n for n, _ in b_nodes]:
        return True, ""
    return False, (
        f"节点序列不一致：A={[n for n, _ in a_nodes]} B={[n for n, _ in b_nodes]}"
        "（v0 仅支持拓扑一致的 run 对，条件分支/并行/循环差异显示为不可对齐）")


def _pretty(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=1,
                      default=repr)


def _truncated(text: str) -> str:
    if len(text.encode("utf-8")) <= MAX_DISPLAY_BYTES:
        return text
    cut = text.encode("utf-8")[:MAX_DISPLAY_BYTES].decode("utf-8", "ignore")
    return cut + "\n…[truncated by afr — 原始状态超过 8KB]"


def diff(conn, run_a: str, run_b: str) -> dict:
    """Compare a failed run (A) against a passing run (B)."""
    rows = {r["id"]: r["status"] for r in conn.execute(
        "SELECT id, status FROM runs WHERE id IN (?,?)", (run_a, run_b))}
    a, b = node_timeline(conn, run_a), node_timeline(conn, run_b)
    aligned, reason = align(a, b)

    result = {
        "run_a": run_a, "run_b": run_b,
        "status_a": rows.get(run_a, "?"),
        "status_b": rows.get(run_b, "?"),
        "aligned": aligned, "reason": reason,
        "first_divergence": None, "rows": [],
    }
    if not aligned:
        return result

    for idx, ((na, oa), (nb, ob)) in enumerate(zip(a, b)):
        pa, pb = _pretty(oa), _pretty(ob)
        same = pa == pb
        dlines = [] if same else list(difflib.unified_diff(
            pa.splitlines(), pb.splitlines(),
            fromfile=f"A#{run_a}:{na}", tofile=f"B#{run_b}:{nb}", lineterm=""))
        if not same and result["first_divergence"] is None:
            result["first_divergence"] = idx
        result["rows"].append({
            "index": idx, "node": na, "same": same,
            "a": _truncated(pa) if not same else pa,
            "b": _truncated(pb) if not same else pb,
            "diff": dlines,
        })
    return result
