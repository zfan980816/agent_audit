"""`rec` 命令行入口:view / diff / replay。

C1: 损坏或锁死的库要报清晰错误并以非零码退出,绝不甩原始 traceback。
展示层(FastAPI 应用、瀑布 span 树装配、stats)在 viewer.py——本模块
只做参数解析和命令路由。
"""

from __future__ import annotations

import argparse
import sys

from .capture import DEFAULT_DB, connect
from .db import DatabaseError, mask_password, resolve_db_url
from .diff import diff
from .viewer import create_app, start_viewer  # noqa: F401  (afr.setup 与既有引用)

__all__ = ["main", "create_app", "start_viewer"]


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
        # inputs 缺省 = 从源 run 自己捕获的入口 state 起跑(确定性重放)
        _, tel = do_replay(graph, source_run_id=args.run_id,
                           db_url=url, assume_yes=args.yes)
        print(f"重放完成，fork run = {tel['fork_run']}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
