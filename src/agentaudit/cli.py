"""agentaudit CLI entry point."""
from __future__ import annotations

import json as _json
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.table import Table

from agentaudit import __version__
from agentaudit.demo import write_demo_session
from agentaudit.discovery import DataDirNotFound, find_session_files
from agentaudit.engine import run_audit
from agentaudit.events import SEVERITY_ORDER, Severity
from agentaudit.report import SEV_LABEL, render_terminal, share_card, to_dict

app = typer.Typer(
    add_completion=False,
    help="npm audit for your AI coding agents - audit dangerous actions in agent history.",
    no_args_is_help=False,
)
console = Console()
err_console = Console(stderr=True)


def _parse_severity(value: str) -> Severity:
    try:
        return Severity(value.lower())
    except ValueError:
        valid = "|".join(s.value for s in SEVERITY_ORDER)
        raise typer.BadParameter(f"must be one of: {valid}") from None


@app.command()
def audit(
    path: Annotated[Optional[Path], typer.Argument(
        help="Claude Code projects dir (default ~/.claude/projects) or a .jsonl file")] = None,
    json_out: Annotated[bool, typer.Option("--json", help="JSON output for scripts/CI")] = False,
    severity: Annotated[str, typer.Option(
        "--severity", help="Minimum severity to show: critical|high|medium|low|info")] = "low",
    session: Annotated[Optional[str], typer.Option("--session", help="Audit one session id")] = None,
    rules: Annotated[Optional[str], typer.Option(
        "--rules", help="Rule category prefixes, comma separated (D,C,E,B,U)")] = None,
    list_rules: Annotated[bool, typer.Option("--list-rules", help="List all rules and exit")] = False,
    share: Annotated[bool, typer.Option("--share", help="Print a shareable summary card")] = False,
    demo: Annotated[bool, typer.Option("--demo", help="Run on built-in demo data")] = False,
    version: Annotated[bool, typer.Option("--version", help="Show version")] = False,
) -> None:
    if version:
        console.print(f"agentaudit {__version__}")
        raise typer.Exit(0)

    from agentaudit.rules import CATEGORY_TITLES, all_rules

    if list_rules:
        table = Table(title=f"agentaudit rules ({len(all_rules())})")
        for col in ("ID", "SEVERITY", "CATEGORY", "TITLE"):
            table.add_column(col)
        for rule in all_rules():
            table.add_row(rule.id, SEV_LABEL[rule.severity],
                          CATEGORY_TITLES[rule.id[0]], rule.title)
        console.print(table)
        raise typer.Exit(0)

    floor = _parse_severity(severity)
    prefixes = ({c.strip().upper() for c in rules.split(",") if c.strip()}
                if rules else None)

    if demo:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            files = [write_demo_session(Path(tmp))]
            result = run_audit(files, rule_prefixes=prefixes, session_id=session)
    else:
        if path is not None and path.is_file():
            files = [path]
        else:
            try:
                files = find_session_files(path)
            except DataDirNotFound as exc:
                err_console.print(f"[red]error:[/red] {exc}")
                raise typer.Exit(code=2) from None
        # stderr keeps --json stdout pure; real dirs can take ~10s before output
        err_console.print(f"scanning {len(files)} session file(s)...")
        result = run_audit(files, rule_prefixes=prefixes, session_id=session)

    # (ADJUSTMENT B) severity floor applies to BOTH terminal and JSON modes
    result.findings = [f for f in result.findings
                       if SEVERITY_ORDER.index(f.severity) >= SEVERITY_ORDER.index(floor)]

    if json_out:
        # (ADJUSTMENT A) markup=False: evidence may contain rich markup-like
        # text ([/...]) which Console.print would parse and crash on;
        # highlight=False avoids JSON recoloring noise when piping.
        # soft_wrap: Console default width is 80 and it inserts real newlines
        # mid-string, which corrupts the JSON (strict_parse fails on raw \n
        # inside literals) — emit each line unwrapped.
        console.print(_json.dumps(to_dict(result), ensure_ascii=False, indent=2),
                      markup=False, highlight=False, soft_wrap=True)
    else:
        render_terminal(result, floor=floor)
    if share and not json_out:
        # card would corrupt the machine-readable JSON stream on stdout
        console.print()
        console.print(share_card(result))
