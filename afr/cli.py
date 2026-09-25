"""T2 — `rec` CLI: view (3-page FastAPI+htmx viewer), diff, replay.

C1: a corrupt/locked DB surfaces as a clear error + non-zero exit,
never a raw traceback. The viewer binds localhost only and is started
on demand — it is NOT part of the capture path (design constraint).
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from .capture import DEFAULT_DB, connect
from .diff import diff

_TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def create_app(db_path) -> FastAPI:
    app = FastAPI(title="Agent Flight Recorder", docs_url=None, redoc_url=None)
    conn = connect(db_path)

    @app.get("/", response_class=HTMLResponse)
    def runs_page(request: Request):
        rows = conn.execute(
            "SELECT id, label, status, started_at, finished_at, error, fork_of"
            " FROM runs ORDER BY started_at DESC, id DESC LIMIT 200").fetchall()
        return _TEMPLATES.TemplateResponse(request, "runs.html",
                                           {"runs": rows, "db": str(db_path)})

    @app.get("/run/{run_id}", response_class=HTMLResponse)
    def run_page(request: Request, run_id: str):
        meta = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        events = conn.execute(
            "SELECT seq, ts, kind, node, payload FROM events WHERE run_id=?"
            " ORDER BY seq", (run_id,)).fetchall()
        llm = conn.execute(
            "SELECT seq, node, model, kind, tokens FROM llm_calls WHERE run_id=?"
            " ORDER BY seq", (run_id,)).fetchall()
        tools = conn.execute(
            "SELECT seq, node, tool_name, kind FROM tool_calls WHERE run_id=?"
            " ORDER BY seq", (run_id,)).fetchall()
        return _TEMPLATES.TemplateResponse(request, "detail.html", {
            "meta": meta, "events": events, "llm": llm, "tools": tools,
        })

    @app.get("/run/{run_id}/io/{seq}", response_class=HTMLResponse)
    def io_fragment(request: Request, run_id: str, seq: int):
        ev = conn.execute(
            "SELECT payload FROM events WHERE run_id=? AND seq=?",
            (run_id, seq)).fetchone()
        return _TEMPLATES.TemplateResponse(request, "io.html",
                                           {"ev": ev, "seq": seq})

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
