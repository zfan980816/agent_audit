"""T2 — `rec` CLI: LangSmith-style trace viewer, diff, replay.

Viewer layout imitates LangSmith's Traces tab (minus the platform):
left pane = per-execution list (status dot / label / time / latency /
tokens), right pane = hierarchical span tree of the selected execution
(nodes -> nested LLM/tool calls, expandable IO, errors in red).

C1: a corrupt/locked DB surfaces as a clear error + non-zero exit,
never a raw traceback. The viewer binds localhost only and is started
on demand — it is NOT part of the capture path (design constraint).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from .capture import DEFAULT_DB, connect
from . import db as db_mod
from .db import DatabaseError, mask_password, resolve_db_url
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


_TEMPLATES.env.globals.update(_k=_k, _lat_cls=_lat_class)


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


def _run_rows(conn, status: str | None = None, q: str | None = None):
    cond, args = [], []
    if status:
        cond.append("r.status = ?")
        args.append(status)
    if q:
        cond.append("(r.label LIKE ? OR r.id LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    where = ("WHERE " + " AND ".join(cond)) if cond else ""
    rows = [dict(r) for r in
            conn.execute(_LIST_SQL.format(where=where), tuple(args)).fetchall()]
    for r in rows:
        r["latency"] = _latency(r["started_at"], r["finished_at"])
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


def _trace_tree(conn, run_id: str):
    """LangSmith-style span tree: nodes with nested llm/tool children.

    Children attach to node OCCURRENCES by merged seq order (node_start
    events, llm_calls and tool_calls share one seq counter), so ReAct
    loops (agent→tools→agent) never duplicate calls across visits.
    """
    meta = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if meta is None:
        return None
    events = conn.execute(
        "SELECT seq, ts, kind, node, payload FROM events WHERE run_id=?"
        " ORDER BY seq", (run_id,)).fetchall()
    # calls and their 'llm'/'tool' events use interleaved seq values from the
    # same counter, so pair them by order (1st llm_call <-> 1st llm event)
    ev_ts = {"llm": [ev["ts"] for ev in events if ev["kind"] == "llm"],
             "tool": [ev["ts"] for ev in events if ev["kind"] == "tool"]}
    t0 = events[0]["ts"] if events else None
    span = max(0.0, events[-1]["ts"] - events[0]["ts"]) if len(events) > 1 else 0.0
    # wall latency from the runs table — same source and same helper as the
    # list column, so the two numbers can never disagree. The gantt scale is
    # the larger of the two so bars never overshoot the track and the honest
    # gap between last event and wall time stays visible as empty track.
    wall = _latency(meta["started_at"], meta["finished_at"])
    total = wall if wall is not None else span
    gantt_total = max(total or 0.0, span)

    def _gantt(ts, dur):
        """(offset%, width%) on the gantt timeline; None = no bar."""
        if ts is None or t0 is None or gantt_total <= 0:
            return None, (0.0 if dur else None)
        off = min(100.0, max(0.0, (ts - t0) / gantt_total * 100.0))
        wid = (min(100.0 - off, max(0.0, dur / gantt_total * 100.0))
               if dur else None)
        return round(off, 1), (round(wid, 1) if wid is not None else None)

    stream = []
    prices = _prices()

    def _cost(model, tokens):
        return ((tokens or 0) / 1000.0) * _price_for(model, prices)

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
            stream.append((ev["seq"], 2, {"node_output": out}))
    llm_rows = conn.execute(
        "SELECT seq, node, model, kind, request_json, response_json,"
        " tokens, dur, params_json, meta_json FROM llm_calls"
        " WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
    for i, r in enumerate(llm_rows):
        # the llm event fires in on_llm_end, so its ts is the END of the
        # call; subtract dur to get the true bar start
        ts = ev_ts["llm"][i] if i < len(ev_ts["llm"]) else None
        if ts is not None and r["dur"]:
            ts = ts - r["dur"]
        off, wid = _gantt(ts, r["dur"])

        def _load(js):
            try:
                return json.loads(js) if js else None
            except Exception:
                return None

        def _flat(d, skip=()):
            """[(k, v_str)] for the LangSmith-style attributes table."""
            rows = []
            for k, v in (d or {}).items():
                if k in skip:
                    continue
                if isinstance(v, (dict, list)):
                    v = json.dumps(v, ensure_ascii=False, default=str)
                rows.append((k, str(v)))
            return rows

        params = _load(r["params_json"])
        llm_meta = _load(r["meta_json"])
        attr_groups = []
        prow = _flat(params, skip=("_type",))
        if prow:
            attr_groups.append({"name": "调用参数", "rows": prow})
        mrow = _flat(llm_meta, skip=("token_usage",))
        if mrow:
            attr_groups.append({"name": "返回元数据", "rows": mrow})
        usage = (llm_meta or {}).get("token_usage")
        if isinstance(usage, dict) and usage:
            attr_groups.append({"name": "Token 用量",
                                "rows": _flat(usage)})

        stream.append((r["seq"], 1, {
            "type": "llm", "name": r["model"], "ok": r["kind"] == "ok",
            "tokens": r["tokens"], "dur": r["dur"], "ts": ts,
            "cost": _cost(r["model"], r["tokens"]),
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
        off, wid = _gantt(ts, None)
        stream.append((r["seq"], 1, {
            "type": "tool", "name": r["tool_name"], "ok": r["kind"] == "ok",
            "tokens": None, "dur": None, "ts": ts,
            "off": off, "wid": wid,
            "tc": _tool_cards(r["args_json"], r["result_json"],
                              r["tool_name"])}))
    stream.sort(key=lambda x: (x[0], x[1]))

    nodes, cur = [], None
    for _, kind, item in stream:
        if "node" in item and "ts" in item:
            cur = item
            nodes.append(cur)
        elif "node_output" in item:
            if cur is not None and cur.get("outputs") is None:
                cur["outputs"] = item["node_output"]
        elif cur is not None:
            if item.get("tokens") == 0:
                item["tokens"] = None  # 0 = unknown, display as —
            cur["children"].append(item)

    for i, n in enumerate(nodes):
        nxt = nodes[i + 1]["ts"] if i + 1 < len(nodes) else None
        last = events[-1]["ts"] if events else n["ts"]
        # clamp >= 0: non-monotonic capture (e.g. replayed interleavings)
        # must never surface a negative duration to the user
        n["dur"] = max(0.0, ((nxt if nxt is not None else last) - n["ts"]))
        n["tokens"] = sum(c.get("tokens") or 0 for c in n["children"])
        n["cost"] = sum(c.get("cost") or 0.0 for c in n["children"])
        n["slow"] = n["dur"] > 10.0
        n["off"], n["wid"] = _gantt(n["ts"], n["dur"])
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
    tokens = sum(n["tokens"] for n in nodes)
    cost = sum(n["cost"] for n in nodes)
    started = (meta["started_at"] or "").replace("T", " ")
    models = [r[0] for r in conn.execute(
        "SELECT DISTINCT model FROM llm_calls WHERE run_id=? AND model != ?"
        " ORDER BY model", (run_id, "?"))]
    # failure diagnosis: first child that errored (node + tool/llm + message)
    first_error = None
    for n in nodes:
        for c in n["children"]:
            if c.get("ok", True):
                continue
            msg = None
            if c["type"] == "llm" and (c.get("resp") or {}).get("err"):
                msg = c["resp"]["content"]
            elif c["type"] == "tool":
                msg = str((c.get("tc") or {}).get("result"))[:300]
            first_error = {"node": n["node"], "name": c["name"], "msg": msg}
            break
        if first_error:
            break

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

    for n in nodes:
        n["inp"] = _pv(n["inputs"]) if n["inputs"] is not None else None
        n["out"] = _pv(n["outputs"]) if n["outputs"] is not None else None
        n["err"] = (_pv(first_error["msg"], limit=40)
                    if first_error and first_error["node"] == n["node"]
                    and first_error.get("msg") else None)

        def _pretty_obj(o):
            if o is None or isinstance(o, str):
                return o
            try:
                return json.dumps(o, ensure_ascii=False, indent=2,
                                  default=str)
            except Exception:
                return str(o)

        n["inputs_p"] = _pretty_obj(n["inputs"])
        n["outputs_p"] = _pretty_obj(n["outputs"])
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
    # Fold repeated executions of the same node into ONE row: food_check
    # running 3x in a retry loop is one logical step, not three rows each
    # dumping the full state again. Each visit stays drillable per-exec.
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

    # best diff counterpart: latest same-label run of the OPPOSITE status,
    # falling back to any latest same-label run (LangSmith has no such
    # one-click jump — this is our first-divergence workflow's front door)
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
    return {"meta": meta, "nodes": folded, "exec_total": len(nodes),
            "total": total, "tokens": tokens,
            "cost": cost, "models": models, "first_error": first_error,
            "diff_pair": pair,
            "span": span, "slow": total > 30.0, "started": started}


_DEFAULT_PRICES = {  # CNY / 1K tokens，混合粗估；~/.afr/prices.json 可覆盖
    "gpt-4o": 0.12, "gpt-4o-mini": 0.01, "gpt-4.1": 0.12,
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
        tok_by_run.setdefault(r["run_id"], {})[r["model"]] = r["t"]

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
            "buffer_backlog": db_mod.buffer_backlog(),
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


def _open_db(url: str):
    try:
        return connect(db_url=url)
    except DatabaseError as exc:
        print(f"[afr] 无法打开录制库 {mask_password(url)}: {exc}\n"
              f"       连接信息可能不正确，或库文件已损坏。", file=sys.stderr)
        sys.exit(2)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rec",
                                 description="Agent Flight Recorder")
    ap.add_argument("--db", default=None,
                    help="数据库 URL 或 sqlite 路径（默认走 $AFR_DB_URL /"
                         f" ~/.afr/config.json / {DEFAULT_DB}）")
    sub = ap.add_subparsers(dest="cmd")

    v = sub.add_parser("view", help="启动三页查看器（列表/详情/diff）")
    v.add_argument("--port", type=int, default=7231)

    d = sub.add_parser("diff", help="对比两个 run（失败 vs 成功）")
    d.add_argument("a"); d.add_argument("b")

    r = sub.add_parser("replay", help="确定性重放某个 run")
    r.add_argument("run_id")
    r.add_argument("--entry", default="examples.flaky_demo:build",
                   help="graph 的 import 路径（module:func）")
    r.add_argument("--yes", action="store_true",
                   help="工具未命中时默认同意真实执行（跳过征询）")

    args = ap.parse_args(argv)
    url = resolve_db_url(args.db)  # param > $AFR_DB_URL > config > default

    if args.cmd == "view":
        _open_db(url)  # fail fast on a bad DB before starting uvicorn
        import uvicorn
        uvicorn.run(create_app(url), host="127.0.0.1",
                    port=args.port, log_level="warning")
        return 0
    if args.cmd == "diff":
        conn = _open_db(url)
        result = diff(conn, args.a, args.b)
        if not result["aligned"]:
            print(f"不可对齐: {result['reason']}")
            return 1
        for row in result["rows"]:
            mark = "=" if row["same"] else ("▶ 首分歧" if row["index"] ==
                                            result["first_divergence"] else "≠")
            print(f"[{row['index']:>2}] {row['node']:<24} {mark}")
            if not row["same"]:
                print("\n".join(row["diff"][:12]))
        return 0
    if args.cmd == "replay":
        conn = _open_db(url)
        meta = conn.execute("SELECT id FROM runs WHERE id=?",
                            (args.run_id,)).fetchone()
        conn.close()
        if meta is None:
            print(f"[afr] run {args.run_id} 不存在于 {mask_password(url)}",
                  file=sys.stderr)
            return 2
        mod_name, func_name = args.entry.split(":")
        import importlib
        build = getattr(importlib.import_module(mod_name), func_name)
        from .replay import replay as do_replay
        graph = build()
        _, tel = do_replay(graph, {}, source_run_id=args.run_id,
                           db_url=url, assume_yes=args.yes)
        print(f"重放完成，fork run = {tel['fork_run']}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
