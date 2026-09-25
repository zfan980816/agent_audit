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
import json
import sqlite3
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from .capture import DEFAULT_DB, connect
from .diff import diff

_TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

_LIST_SQL = """
SELECT r.id, r.label, r.status, r.started_at, r.finished_at, r.error, r.fork_of,
  CASE WHEN r.finished_at IS NULL THEN NULL
       ELSE CAST((julianday(r.finished_at) - julianday(r.started_at)) * 86400
                 AS REAL) END AS latency,
  (SELECT COALESCE(SUM(tokens), 0) FROM llm_calls WHERE run_id = r.id) AS tokens
FROM runs r
{where}
ORDER BY r.started_at DESC, r.id DESC LIMIT 200
"""


def _run_rows(conn, status: str | None = None):
    where = "WHERE r.status = ?" if status else ""
    args = (status,) if status else ()
    return conn.execute(_LIST_SQL.format(where=where), args).fetchall()


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
    """LangSmith-style span tree: nodes with nested llm/tool children."""
    meta = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if meta is None:
        return None
    events = conn.execute(
        "SELECT seq, ts, kind, node, payload FROM events WHERE run_id=?"
        " ORDER BY seq", (run_id,)).fetchall()
    llm_by_node: dict[str, list] = {}
    for r in conn.execute(
            "SELECT seq, node, model, kind, request_json, response_json, tokens"
            " FROM llm_calls WHERE run_id=? ORDER BY seq", (run_id,)):
        llm_by_node.setdefault(r["node"], []).append({
            "type": "llm", "name": r["model"], "ok": r["kind"] == "ok",
            "tokens": r["tokens"] or 0,
            "cards": _msg_cards(r["request_json"]),
            "resp": _resp_card(r["response_json"]),
            "raw": _pretty(r["request_json"]) + "\n→\n"
                + _pretty(r["response_json"]),
        })
    tool_by_node: dict[str, list] = {}
    for r in conn.execute(
            "SELECT seq, node, tool_name, kind, args_json, result_json"
            " FROM tool_calls WHERE run_id=? ORDER BY seq", (run_id,)):
        tool_by_node.setdefault(r["node"], []).append({
            "type": "tool", "name": r["tool_name"], "ok": r["kind"] == "ok",
            "tokens": 0,
            "tc": _tool_cards(r["args_json"], r["result_json"], r["tool_name"]),
        })

    nodes, cur = [], None
    for ev in events:
        if ev["kind"] == "node_start":
            try:
                inputs = json.loads(ev["payload"]).get("inputs")
            except Exception:
                inputs = ev["payload"]
            cur = {"node": ev["node"], "ts": ev["ts"], "inputs": inputs,
                   "children": []}
            nodes.append(cur)
        elif ev["kind"] == "node_output" and cur is not None:
            cur["outputs"] = json.loads(ev["payload"]).get("outputs")
    for i, n in enumerate(nodes):
        nxt = nodes[i + 1]["ts"] if i + 1 < len(nodes) else None
        last = events[-1]["ts"] if events else n["ts"]
        n["dur"] = ((nxt if nxt is not None else last) - n["ts"]) or 0.0
        n["children"] = llm_by_node.get(n["node"], []) + \
            tool_by_node.get(n["node"], [])
        n["tokens"] = sum(c.get("tokens") or 0 for c in n["children"])
        n["slow"] = n["dur"] > 10.0
    total = (events[-1]["ts"] - events[0]["ts"]) if len(events) > 1 else 0.0
    tokens = sum(n["tokens"] for n in nodes)
    return {"meta": meta, "nodes": nodes, "total": total, "tokens": tokens,
            "slow": total > 30.0}


_DEFAULT_PRICES = {  # CNY / 1K tokens，混合粗估；~/.afr/prices.json 可覆盖
    "gpt-4o": 0.12, "gpt-4o-mini": 0.01, "gpt-4.1": 0.12,
    "qwen-max": 0.12, "qwen-plus": 0.02, "qwen-turbo": 0.005,
    "deepseek-chat": 0.008, "claude-*": 0.18,
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
      SELECT r.id, r.label, r.status, r.started_at, r.error,
        CASE WHEN r.finished_at IS NULL THEN NULL
             ELSE CAST((julianday(r.finished_at) - julianday(r.started_at))
                       * 86400 AS REAL) END AS latency
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
        if r["latency"] is not None:
            f["lat"].append(r["latency"])
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


def create_app(db_path) -> FastAPI:
    app = FastAPI(title="Agent Flight Recorder", docs_url=None, redoc_url=None)
    conn = connect(db_path)

    @app.get("/", response_class=HTMLResponse)
    def traces_page(request: Request, status: str | None = None):
        rows = _run_rows(conn, status)
        banner = conn.execute(
            "SELECT COUNT(*) c FROM (SELECT status FROM runs"
            " ORDER BY started_at DESC, id DESC LIMIT 50)"
            " WHERE status='failed'").fetchone()["c"]
        return _TEMPLATES.TemplateResponse(request, "traces.html", {
            "runs": rows, "db": str(db_path), "status": status or "",
            "banner_fails": banner,
        })

    @app.get("/stats", response_class=HTMLResponse)
    def stats_page(request: Request):
        return _TEMPLATES.TemplateResponse(request, "stats.html", {
            "s": _stats(conn), "db": str(db_path),
        })

    @app.get("/run/{run_id}/tree", response_class=HTMLResponse)
    def tree_partial(request: Request, run_id: str):
        t = _trace_tree(conn, run_id)
        return _TEMPLATES.TemplateResponse(request, "tree.html", {"t": t})

    @app.get("/run/{run_id}", response_class=HTMLResponse)
    def run_page(request: Request, run_id: str):
        t = _trace_tree(conn, run_id)
        rows = _run_rows(conn)
        return _TEMPLATES.TemplateResponse(request, "traces.html", {
            "runs": rows, "db": str(db_path), "status": "",
            "selected": run_id, "tree": t,
        })

    @app.get("/diff", response_class=HTMLResponse)
    def diff_page(request: Request, a: str, b: str):
        result = diff(conn, a, b)
        return _TEMPLATES.TemplateResponse(request, "diff.html",
                                           {"d": result})

    return app


def _open_db(path: str):
    try:
        return connect(path)
    except sqlite3.DatabaseError as exc:
        print(f"[afr] 无法打开录制库 {path}: {exc.__class__.__name__}: {exc}\n"
              f"       文件可能已损坏或不是 afr 数据库。", file=sys.stderr)
        sys.exit(2)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rec",
                                 description="Agent Flight Recorder")
    ap.add_argument("--db", default=str(DEFAULT_DB),
                    help=f"SQLite 记录库路径（默认 {DEFAULT_DB}）")
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

    if args.cmd == "view":
        _open_db(args.db)  # fail fast on corrupt DB before starting uvicorn
        import uvicorn
        uvicorn.run(create_app(args.db), host="127.0.0.1",
                    port=args.port, log_level="warning")
        return 0
    if args.cmd == "diff":
        conn = _open_db(args.db)
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
        conn = _open_db(args.db)
        meta = conn.execute("SELECT id FROM runs WHERE id=?",
                            (args.run_id,)).fetchone()
        conn.close()
        if meta is None:
            print(f"[afr] run {args.run_id} 不存在于 {args.db}", file=sys.stderr)
            return 2
        mod_name, func_name = args.entry.split(":")
        import importlib
        build = getattr(importlib.import_module(mod_name), func_name)
        from .replay import replay as do_replay
        graph = build()
        _, tel = do_replay(graph, {}, source_run_id=args.run_id,
                           db_path=args.db, assume_yes=args.yes)
        print(f"重放完成，fork run = {tel['fork_run']}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
