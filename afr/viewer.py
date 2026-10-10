"""afr 监控界面:格式化助手、瀑布 span 树装配、stats 聚合、FastAPI 应用。

只做展示,不含命令行(入口在 cli.py)。布局仿 LangSmith 的 Traces 页:
左列 = 执行列表(状态/名称/时间/延迟/token/成本),右栏 = 选中执行的
层级 span 树(节点 -> 内嵌 LLM/工具调用,可展开 IO,错误标红)。

C1: 损坏/锁死的库由 cli.py 在启动前拦截;查看器只绑 localhost、按需
启动,不属于录制路径(设计约束)。
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates

from . import buffer
from . import db as db_mod
from .db import mask_password, resolve_db_url
from .diff import diff

_TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
# render Chinese as-is in {{ x|tojson }} blocks (default escapes to \uXXXX)
_TEMPLATES.env.policies["json.dumps_kwargs"] = {"ensure_ascii": False,
                                                "sort_keys": True}


def _k(n):
    """LangSmith token notation: 190 -> '190', 3297 -> '3.297K'."""
    if not n:
        return "—"
    if n < 1000:
        return str(n)
    s = f"{n / 1000:.3f}".rstrip("0").rstrip(".")
    return f"{s}K"


def _cny(c):
    """Cost cell: ¥0.046 / ¥12.34, '—' when unknown (shared by list page
    and stats so the two never disagree)."""
    if not c:
        return "—"
    return f"¥{c:.3f}" if c < 1 else f"¥{c:.2f}"


def _lat_class(v):
    """LangSmith latency colors: green <10s, amber <60s, red beyond."""
    if v is None:
        return ""
    return "" if v < 10 else ("lat-y" if v < 60 else "lat-r")


_LIST_SQL = """
SELECT r.id, r.label, r.status, r.started_at, r.finished_at, r.error, r.fork_of,
  (SELECT COALESCE(SUM(tokens), 0) FROM llm_calls WHERE run_id = r.id) AS tokens
FROM runs r
{where}
ORDER BY r.started_at DESC, r.id DESC LIMIT 200
"""


_TEMPLATES.env.globals.update(_k=_k, _lat_cls=_lat_class, _cny=_cny)


def _latency(started: str | None, finished: str | None):
    """Wall seconds between the two run timestamps (None if unfinished).

    Computed in Python — not julianday/TIMESTAMPDIFF — so the list page,
    detail page and stats page share ONE identical latency definition on
    every backend (sqlite / mysql / dm).
    """
    if not started or not finished:
        return None
    try:
        s = dt.datetime.strptime(started[:19], "%Y-%m-%dT%H:%M:%S")
        f = dt.datetime.strptime(finished[:19], "%Y-%m-%dT%H:%M:%S")
        return max(0.0, (f - s).total_seconds())
    except ValueError:
        return None


def _like_escape(s: str) -> str:
    """User search text -> LIKE literal: % _ \\ 失去通配符含义(参数化已挡
    注入,这里修的是匹配语义——搜「100%」就该匹配字面 100%)。"""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _run_rows(conn, status: str | None = None, q: str | None = None):
    cond, args = [], []
    if status:
        cond.append("r.status = ?")
        args.append(status)
    if q:
        # ESCAPE '\' 的反斜杠字面量在三后端语义一致:sqlite 不处理 \ 转义、
        # mysql/dm 里 '\\' 即单个反斜杠
        like = f"%{_like_escape(q)}%"
        cond.append("(r.label LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')")
        args += [like, like]
    where = ("WHERE " + " AND ".join(cond)) if cond else ""
    rows = [dict(r) for r in
            conn.execute(_LIST_SQL.format(where=where), tuple(args)).fetchall()]
    # cost per run (LangSmith list column "Total Cost"): same price table
    # and same aggregation as the stats page — int() normalizes MySQL's
    # Decimal SUM back into a number
    prices = _prices()
    cost_by_run: dict[str, float] = {}
    for r in conn.execute(
            "SELECT run_id, model, SUM(tokens) t FROM llm_calls"
            " WHERE tokens IS NOT NULL GROUP BY run_id, model").fetchall():
        cost_by_run[r["run_id"]] = cost_by_run.get(r["run_id"], 0.0) + (
            int(r["t"] or 0) / 1000.0) * _price_for(r["model"], prices)
    for r in rows:
        r["latency"] = _latency(r["started_at"], r["finished_at"])
        r["cost"] = cost_by_run.get(r["id"], 0.0)
    return rows


def _pretty(js: str | None) -> str:
    if not js:
        return ""
    try:
        obj = json.loads(js)
        return json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=1)
    except Exception:
        return js


_ROLE = {"human": "用户", "ai": "AI", "system": "系统", "tool": "工具结果"}


def _msg_cards(request_json: str | None):
    """LangSmith-style message cards from the captured request messages."""
    cards = []
    if not request_json:
        return cards
    try:
        msgs = json.loads(request_json)
    except Exception:
        return cards
    for m in msgs:
        if not isinstance(m, dict):
            continue
        content = m.get("content") or ""
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        cards.append({"role": _ROLE.get(m.get("type"), m.get("type", "?")),
                      "content": content, "tool": None, "err": False})
    return cards


def _resp_card(response_json: str | None):
    """The model's answer as one card (with tool-call args if present)."""
    if not response_json:
        return None
    try:
        m = json.loads(response_json)
    except Exception:
        return None
    if not isinstance(m, dict):
        return {"role": "AI", "content": str(m), "tool": None, "err": False}
    if "error" in m and set(m) <= {"error"}:
        return {"role": "错误", "content": m["error"], "tool": None, "err": True}
    tool = None
    calls = (m.get("additional_kwargs") or {}).get("tool_calls") or []
    if calls:
        fn = calls[-1].get("function", {})
        tool = {"name": fn.get("name"), "args": fn.get("arguments", "")}
    content = m.get("content") or ""
    if not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False)
    return {"role": "AI", "content": content, "tool": tool, "err": False}


def _tool_cards(args_json: str | None, result_json: str | None, name: str):
    args = None
    if args_json:
        try:
            args = json.loads(args_json)
        except Exception:
            args = args_json
    result = result_json
    if result_json:
        try:
            r = json.loads(result_json)
            result = r if isinstance(r, str) else json.dumps(
                r, ensure_ascii=False, indent=1)
        except Exception:
            pass
    return {"args": args, "result": result, "name": name}


def _load_json(js):
    try:
        return json.loads(js) if js else None
    except Exception:
        return None


def _flat_attrs(d, skip=()):
    """[(k, v_str)] for the LangSmith-style attributes table."""
    rows = []
    for k, v in (d or {}).items():
        if k in skip:
            continue
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False, default=str)
        rows.append((k, str(v)))
    return rows


def _pv(obj, prefix="", limit=46):
    """One-line Input/Output/Error cell preview (LangSmith trace table).

    Dicts render as key=value pairs (days=3, destination=长沙 +17字段)
    — a full JSON dump here is what makes the table unreadable."""
    if isinstance(obj, dict) and not prefix:
        parts = []
        for i, (k, v) in enumerate(obj.items()):
            if i >= 3:
                parts.append(f"+{len(obj) - 3}字段")
                break
            if isinstance(v, (list, dict)):
                v = f"[{len(v)}项]" if v else "[]"
            parts.append(f"{k}={str(v)[:14]}")
        s = ", ".join(parts)
    else:
        try:
            s = obj if isinstance(obj, str) else json.dumps(
                obj, ensure_ascii=False, default=str)
        except Exception:
            s = str(obj)
    s = prefix + " ".join(str(s).split())
    return s[:limit] + ("…" if len(s) > limit else "")


def _pretty_obj(o):
    if o is None or isinstance(o, str):
        return o
    try:
        return json.dumps(o, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return str(o)


def _tree_clock(conn, run_id, meta):
    """events + 时间基准:ev_ts 按序配对、t0/span、wall 总时长、gantt 满刻度。

    wall 与列表列同源同算法(_latency),两处数字永远一致;gantt 刻度取
    wall 与 span 的较大者——条形永不过冲,末事件与总时长之间的诚实空隙
    以空轨道呈现。"""
    events = conn.execute(
        "SELECT seq, ts, kind, node, payload FROM events WHERE run_id=?"
        " ORDER BY seq", (run_id,)).fetchall()
    # calls and their 'llm'/'tool' events use interleaved seq values from the
    # same counter, so pair them by order (1st llm_call <-> 1st llm event)
    ev_ts = {"llm": [ev["ts"] for ev in events if ev["kind"] == "llm"],
             "tool": [ev["ts"] for ev in events if ev["kind"] == "tool"]}
    t0 = events[0]["ts"] if events else None
    span = max(0.0, events[-1]["ts"] - events[0]["ts"]) if len(events) > 1 else 0.0
    wall = _latency(meta["started_at"], meta["finished_at"])
    total = wall if wall is not None else span
    return events, ev_ts, t0, span, total, max(total or 0.0, span)


def _gantt_at(t0, gantt_total):
    """生成 (offset%, width%) 计算器;ts=None 或零刻度 = 无条形。"""
    def _gantt(ts, dur):
        if ts is None or t0 is None or gantt_total <= 0:
            return None, (0.0 if dur else None)
        off = min(100.0, max(0.0, (ts - t0) / gantt_total * 100.0))
        wid = (min(100.0 - off, max(0.0, dur / gantt_total * 100.0))
               if dur else None)
        return round(off, 1), (round(wid, 1) if wid is not None else None)
    return _gantt


def _tree_stream(conn, run_id, events, ev_ts, gantt):
    """node_start/node_output 事件与 llm/tool 调用装配成一条 (seq, 类别, 项)
    有序流。llm 事件的 ts 是调用结束时刻,条形起点按 dur 回推。"""
    prices = _prices()
    stream = []
    for ev in events:
        if ev["kind"] == "node_start":
            try:
                inputs = json.loads(ev["payload"]).get("inputs")
            except Exception:
                inputs = ev["payload"]
            stream.append((ev["seq"], 0, {"node": ev["node"], "ts": ev["ts"],
                                           "inputs": inputs, "children": [],
                                           "outputs": None}))
        elif ev["kind"] == "node_output":
            try:
                out = json.loads(ev["payload"]).get("outputs")
            except Exception:
                out = ev["payload"]
            stream.append((ev["seq"], 2, {"node_output": out,
                                          "on": ev["node"]}))
    llm_rows = conn.execute(
        "SELECT seq, node, model, kind, request_json, response_json,"
        " tokens, dur, params_json, meta_json FROM llm_calls"
        " WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
    for i, r in enumerate(llm_rows):
        ts = ev_ts["llm"][i] if i < len(ev_ts["llm"]) else None
        if ts is not None and r["dur"]:
            ts = ts - r["dur"]
        off, wid = gantt(ts, r["dur"])
        params = _load_json(r["params_json"])
        llm_meta = _load_json(r["meta_json"])
        attr_groups = []
        prow = _flat_attrs(params, skip=("_type",))
        if prow:
            attr_groups.append({"name": "调用参数", "rows": prow})
        mrow = _flat_attrs(llm_meta, skip=("token_usage",))
        if mrow:
            attr_groups.append({"name": "返回元数据", "rows": mrow})
        usage = (llm_meta or {}).get("token_usage")
        if isinstance(usage, dict) and usage:
            attr_groups.append({"name": "Token 用量",
                                "rows": _flat_attrs(usage)})
        stream.append((r["seq"], 1, {
            "type": "llm", "name": r["model"], "ok": r["kind"] == "ok",
            "tokens": r["tokens"], "dur": r["dur"], "ts": ts,
            "at": r["node"],
            "cost": ((r["tokens"] or 0) / 1000.0) * _price_for(r["model"], prices),
            "attr_groups": attr_groups,
            "off": off, "wid": wid,
            "cards": _msg_cards(r["request_json"]),
            "resp": _resp_card(r["response_json"]),
            "raw": _pretty(r["request_json"]) + "\n→\n"
                + _pretty(r["response_json"])}))
    tool_rows = conn.execute(
        "SELECT seq, node, tool_name, kind, args_json, result_json"
        " FROM tool_calls WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
    for i, r in enumerate(tool_rows):
        ts = ev_ts["tool"][i] if i < len(ev_ts["tool"]) else None
        off, wid = gantt(ts, None)
        stream.append((r["seq"], 1, {
            "type": "tool", "name": r["tool_name"], "ok": r["kind"] == "ok",
            "tokens": None, "dur": None, "ts": ts,
            "at": r["node"],
            "off": off, "wid": wid,
            "tc": _tool_cards(r["args_json"], r["result_json"],
                              r["tool_name"])}))
    stream.sort(key=lambda x: (x[0], x[1]))
    return stream, llm_rows, tool_rows


def _tree_nodes(stream, events, llm_rows, tool_rows, t0, gantt):
    """把装配流挂成节点:node_output 回填、调用按 node 列归属、时长/汇总、
    同名子行轮次编号、显示名追加实际调用的模型/工具。"""
    nodes, cur, by_name = [], None, {}
    if not any(ev["kind"] == "node_start" for ev in events) and \
            (llm_rows or tool_rows):
        # 无 LangGraph 回退:纯 LangChain 链没有 node_start 挂载点,合成一个
        # 根节点承载全部 LLM/工具调用——数据本来就在库里,详情页不能空白
        cur = {"node": "调用序列", "ts": t0 or 0.0, "inputs": None,
               "children": [], "outputs": None}
        nodes.append(cur)
    for _, kind, item in stream:
        if "node" in item and "ts" in item:
            cur = item
            nodes.append(cur)
            by_name[item["node"]] = item
        elif "node_output" in item:
            tgt = by_name.get(item.get("on")) or cur
            if tgt is not None and tgt.get("outputs") is None:
                tgt["outputs"] = item["node_output"]
        elif cur is not None:
            if item.get("tokens") == 0:
                item["tokens"] = None  # 0 = unknown, display as —
            # 归属挂载:llm/tool 自带 node 列,挂到同名节点上——并行节点
            # 下按"当前节点"挂会全部堆进最后启动的那个(weather 教训);
            # 无归属(普通链)回退 cur 保持旧行为
            (by_name.get(item.get("at")) or cur)["children"].append(item)

    for i, n in enumerate(nodes):
        nxt = nodes[i + 1]["ts"] if i + 1 < len(nodes) else None
        last = events[-1]["ts"] if events else n["ts"]
        # clamp >= 0: non-monotonic capture (e.g. replayed interleavings)
        # must never surface a negative duration to the user
        n["dur"] = max(0.0, ((nxt if nxt is not None else last) - n["ts"]))
        n["tokens"] = sum(c.get("tokens") or 0 for c in n["children"])
        n["cost"] = sum(c.get("cost") or 0.0 for c in n["children"])
        n["slow"] = n["dur"] > 10.0
        n["off"], n["wid"] = gantt(n["ts"], n["dur"])
        # 同名子行编号:ReAct 节点内同一模型的多次调用(决策轮→总结轮)
        # 行名完全一样,不编号无法分辨是第几次(c.turn 渲染为 #N 标签)
        cnt: dict[str, int] = {}
        for c in n["children"]:
            cnt[c["name"]] = cnt.get(c["name"], 0) + 1
        turn: dict[str, int] = {}
        for c in n["children"]:
            if cnt[c["name"]] > 1:
                turn[c["name"]] = turn.get(c["name"], 0) + 1
                c["turn"] = turn[c["name"]]
        # specific display name: append what this node actually invoked
        # (agent -> agent · qwen3.8-flash; tools -> tools · search_nearby_food)
        seen, calls = set(), []
        for c in n["children"]:
            if c["name"] not in seen:
                seen.add(c["name"])
                calls.append(c["name"])
        n["disp"] = n["node"] + (" · " + "、".join(calls[:3]) +
                                 (f" 等{len(calls)}个" if len(calls) > 3
                                  else ""))
    return nodes


def _first_error(nodes):
    """失败诊断:第一个出错的子调用(节点 + 工具/模型 + 消息)。"""
    for n in nodes:
        for c in n["children"]:
            if c.get("ok", True):
                continue
            msg = None
            if c["type"] == "llm" and (c.get("resp") or {}).get("err"):
                msg = c["resp"]["content"]
            elif c["type"] == "tool":
                msg = str((c.get("tc") or {}).get("result"))[:300]
            return {"node": n["node"], "name": c["name"], "msg": msg}
    return None


def _tree_previews(nodes, first_error):
    """列表单元格的单行预览(_pv)+ 展开用的完整 pretty JSON。"""
    for n in nodes:
        n["inp"] = _pv(n["inputs"]) if n["inputs"] is not None else None
        n["out"] = _pv(n["outputs"]) if n["outputs"] is not None else None
        n["err"] = (_pv(first_error["msg"], limit=40)
                    if first_error and first_error["node"] == n["node"]
                    and first_error.get("msg") else None)
        n["inputs_p"] = _pretty_obj(n["inputs"])
        n["outputs_p"] = _pretty_obj(n["outputs"])
        n["inputs_k"] = ([str(k) for k in n["inputs"]][:40]
                         if isinstance(n["inputs"], dict) else [])
        for c in n["children"]:
            if c["type"] == "llm":
                human = next((m for m in c["cards"]
                              if m["role"] in ("用户", "系统")), None)
                c["inp"] = (_pv(human["content"], human["role"] + ": ")
                            if human else None)
                if (c.get("resp") or {}).get("content"):
                    c["out"] = _pv(c["resp"]["content"], c["resp"]["role"] + ": ")
                c["err"] = _pv(c["resp"]["content"], limit=40) \
                    if not c["ok"] and (c.get("resp") or {}).get("err") else None
            else:
                c["inp"] = _pv((c.get("tc") or {}).get("args"))
                res = (c.get("tc") or {}).get("result")
                c["out"] = _pv(res) if res else None
                c["err"] = _pv(res, limit=40) if not c["ok"] and res else None


def _fold_execs(nodes):
    """同名节点的多次执行折叠成一行:food_check 重试 3 次是一个逻辑步骤,
    不该三行各甩一遍全量状态;每次执行保留在 execs 里可逐次下钻。"""
    folded, by_name = [], {}
    for n in nodes:
        f = by_name.get(n["node"])
        if f is None:
            f = {"node": n["node"], "execs": [], "children": []}
            by_name[n["node"]] = f
            folded.append(f)
        f["execs"].append(n)
        f["children"].extend(n["children"])
    for f in folded:
        f["count"] = len(f["execs"])
        f["dur"] = sum(e["dur"] for e in f["execs"])
        f["tokens"] = sum(e["tokens"] for e in f["execs"])
        f["cost"] = sum(e["cost"] for e in f["execs"])
        first = f["execs"][0]
        f["ts"], f["off"], f["wid"] = first["ts"], first["off"], first["wid"]
        f["inp"], f["out"] = first["inp"], first["out"]
        f["err"] = next((e["err"] for e in f["execs"] if e["err"]), None)
        # specific display name: append what this node actually invoked
        seen, calls = set(), []
        for c in f["children"]:
            if c["name"] not in seen:
                seen.add(c["name"])
                calls.append(c["name"])
        f["disp"] = f["node"] + (" · " + "、".join(calls[:3]) +
                                 (f" 等{len(calls)}个" if len(calls) > 3
                                  else ""))
    return folded


def _diff_pair(conn, meta, run_id):
    """最佳 diff 对照:同 label 反状态最近一次,退而求其次同 label 任意最近。

    (LangSmith 没有这种一键跳转——这是首分歧工作流的前门。)"""
    pair = None
    opposite = {"failed": "ok", "ok": "failed"}.get(meta["status"])
    # NULL-safe label match without sqlite's `IS ?` (mysql/dm don't accept
    # a bound param after IS): `= ?` plus an explicit NULL-NULL branch
    _nullsafe = "(label = ? OR (label IS NULL AND ? IS NULL))"
    if opposite:
        r = conn.execute(
            "SELECT id FROM runs WHERE status=? AND " + _nullsafe +
            " AND id != ? ORDER BY started_at DESC, id DESC LIMIT 1",
            (opposite, meta["label"], meta["label"], run_id)).fetchone()
        pair = r["id"] if r else None
    if not pair:
        r = conn.execute(
            "SELECT id FROM runs WHERE " + _nullsafe +
            " AND id != ? ORDER BY started_at DESC, id DESC LIMIT 1",
            (meta["label"], meta["label"], run_id)).fetchone()
        pair = r["id"] if r else None
    return pair


def _trace_tree(conn, run_id: str):
    """LangSmith-style span tree: nodes with nested llm/tool children.

    Children attach to node OCCURRENCES by merged seq order (node_start
    events, llm_calls and tool_calls share one seq counter), so ReAct
    loops (agent→tools→agent) never duplicate calls across visits.
    """
    meta = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if meta is None:
        return None
    events, ev_ts, t0, span, total, gantt_total = _tree_clock(conn, run_id, meta)
    gantt = _gantt_at(t0, gantt_total)
    stream, llm_rows, tool_rows = _tree_stream(conn, run_id, events, ev_ts, gantt)
    nodes = _tree_nodes(stream, events, llm_rows, tool_rows, t0, gantt)
    tokens = sum(n["tokens"] for n in nodes)
    cost = sum(n["cost"] for n in nodes)
    started = (meta["started_at"] or "").replace("T", " ")
    models = [r[0] for r in conn.execute(
        "SELECT DISTINCT model FROM llm_calls WHERE run_id=? AND model != ?"
        " ORDER BY model", (run_id, "?"))]
    first_error = _first_error(nodes)
    _tree_previews(nodes, first_error)
    folded = _fold_execs(nodes)
    pair = _diff_pair(conn, meta, run_id)
    return {"meta": meta, "nodes": folded, "exec_total": len(nodes),
            "total": total, "tokens": tokens,
            "cost": cost, "models": models, "first_error": first_error,
            "diff_pair": pair,
            "span": span, "slow": total > 30.0, "started": started}


_DEFAULT_PRICES = {  # CNY / 1K tokens，混合粗估；~/.afr/prices.json 可覆盖
    "gpt-4o": 0.12, "gpt-4o-mini": 0.01, "gpt-4.1": 0.12,
    "glm-*": 0.06, "glm-4.5-air": 0.002, "glm-4-flash": 0.002,
    "qwen-max": 0.12, "qwen-plus": 0.02, "qwen-turbo": 0.005,
    "qwen*": 0.02, "deepseek-chat": 0.008, "claude-*": 0.18,
}


def _prices():
    prices = dict(_DEFAULT_PRICES)
    try:
        p = Path.home() / ".afr" / "prices.json"
        if p.exists():
            prices.update(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        pass
    return prices


def _price_for(model: str, prices: dict) -> float:
    if model in prices:
        return prices[model]
    m = (model or "").lower()
    for k, v in prices.items():
        if k.endswith("*") and m.startswith(k[:-1].lower()):
            return v
    return 0.0


def _stats(conn):
    """Monitoring overview (D17 A+C): per-flow health + cost estimate."""
    prices = _prices()
    runs = conn.execute("""
      SELECT r.id, r.label, r.status, r.started_at, r.finished_at, r.error
      FROM runs r ORDER BY r.started_at DESC, r.id DESC LIMIT 1000""").fetchall()
    tok_rows = conn.execute(
        "SELECT run_id, model, SUM(tokens) t FROM llm_calls"
        " WHERE tokens IS NOT NULL GROUP BY run_id, model").fetchall()
    tok_by_run: dict[str, dict[str, int]] = {}
    for r in tok_rows:
        tok_by_run.setdefault(r["run_id"], {})[r["model"]] = int(r["t"] or 0)  # SUM:MySQL 回 Decimal,归一成 int

    flows: dict[str, dict] = {}
    models: dict[str, dict] = {}
    total_n = total_fail = total_tokens = 0
    for r in runs:
        label = r["label"] or "(未命名)"
        f = flows.setdefault(label, {"label": label, "n": 0, "fails": 0,
                                     "lat": [], "tokens": 0, "cost": 0.0,
                                     "last": r["started_at"]})
        f["n"] += 1
        total_n += 1
        if r["status"] == "failed":
            f["fails"] += 1
            total_fail += 1
        lat = _latency(r["started_at"], r["finished_at"])
        if lat is not None:
            f["lat"].append(lat)
        for model, tok in tok_by_run.get(r["id"], {}).items():
            cost = (tok / 1000.0) * _price_for(model, prices)
            f["tokens"] += tok
            f["cost"] += cost
            total_tokens += tok
            mm = models.setdefault(model, {"model": model, "tokens": 0,
                                           "cost": 0.0})
            mm["tokens"] += tok
            mm["cost"] += cost

    for f in flows.values():
        lat = sorted(f.pop("lat"))
        f["avg"] = (sum(lat) / len(lat)) if lat else None
        f["p95"] = lat[min(int(0.95 * (len(lat) - 1)), len(lat) - 1)] if lat else None
        f["rate"] = (1 - f["fails"] / f["n"]) if f["n"] else 1.0
    recent_failures = [r for r in runs if r["status"] == "failed"][:8]
    banner_fails = sum(1 for r in runs[:50] if r["status"] == "failed")
    return {
        "flows": sorted(flows.values(), key=lambda x: -x["n"]),
        "models": sorted(models.values(), key=lambda x: -x["tokens"]),
        "total": {"n": total_n, "fails": total_fail, "tokens": total_tokens,
                  "cost": sum(m["cost"] for m in models.values())},
        "recent_failures": recent_failures,
        "banner_fails": banner_fails,
        "price_note": "单价可在 ~/.afr/prices.json 覆盖（CNY/1K tokens）",
    }


def create_app(db_url: str) -> FastAPI:
    app = FastAPI(title="Agent Flight Recorder", docs_url=None, redoc_url=None)
    keeper = db_mod.ConnKeeper(db_url)  # survives server-side idle drops
    shown_db = mask_password(db_url)
    htmx_path = Path(__file__).parent / "templates" / "htmx.min.js"

    @app.get("/static/htmx.min.js", include_in_schema=False)
    def htmx_js():
        # 本地 vendored htmx:内网/离线部署(集中库场景)交互不依赖公网 CDN
        return FileResponse(htmx_path, media_type="application/javascript")

    @app.get("/", response_class=HTMLResponse)
    def traces_page(request: Request, status: str | None = None,
                    q: str | None = None):
        conn = keeper.get()
        rows = _run_rows(conn, status, q)
        banner = conn.execute(
            "SELECT COUNT(*) c FROM (SELECT status FROM runs"
            " ORDER BY started_at DESC, id DESC LIMIT 50) AS recent"
            " WHERE status='failed'").fetchone()["c"]
        return _TEMPLATES.TemplateResponse(request, "traces.html", {
            "runs": rows, "db": shown_db, "status": status or "",
            "q": q or "", "banner_fails": banner,
            "buffer_backlog": buffer.buffer_backlog(),
        })

    @app.get("/stats", response_class=HTMLResponse)
    def stats_page(request: Request):
        return _TEMPLATES.TemplateResponse(request, "stats.html", {
            "s": _stats(keeper.get()), "db": shown_db,
        })

    @app.get("/run/{run_id}/tree", response_class=HTMLResponse)
    def tree_partial(request: Request, run_id: str):
        t = _trace_tree(keeper.get(), run_id)
        return _TEMPLATES.TemplateResponse(request, "tree.html", {"t": t})

    @app.get("/run/{run_id}", response_class=HTMLResponse)
    def run_page(request: Request, run_id: str):
        conn = keeper.get()
        t = _trace_tree(conn, run_id)
        rows = _run_rows(conn)
        return _TEMPLATES.TemplateResponse(request, "traces.html", {
            "runs": rows, "db": shown_db, "status": "",
            "selected": run_id, "tree": t,
        })

    @app.get("/diff", response_class=HTMLResponse)
    def diff_page(request: Request, a: str, b: str):
        result = diff(keeper.get(), a, b)
        return _TEMPLATES.TemplateResponse(request, "diff.html",
                                           {"d": result})

    return app


def start_viewer(db_url: str | None = None, port: int = 7231,
                 host: str = "127.0.0.1") -> str | None:
    """Serve the viewer inside a daemon thread; returns its URL (or None).

    Lets an application embed the monitoring page — afr.setup(view=True) at
    startup, then browse http://127.0.0.1:port, no separate command. A port
    already taken (e.g. a second app process on the same machine) is noted
    on stderr and skipped; recording is unaffected.
    """
    import socket
    import threading

    import uvicorn
    with socket.socket() as s:
        try:
            s.bind((host, port))
        except OSError:
            print(f"[afr] 监控页面端口 {host}:{port} 已被占用，"
                  f"本进程不启动内嵌查看器", file=sys.stderr)
            return None
    url = resolve_db_url(db_url)
    server = uvicorn.Server(uvicorn.Config(
        create_app(url), host=host, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True,
                     name="afr-viewer").start()
    page = f"http://{host}:{port}"
    print(f"[afr] 监控页面: {page}", file=sys.stderr)
    return page
