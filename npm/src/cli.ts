#!/usr/bin/env node
// agentaudit CLI entry point. Faithful port of src/agentaudit/cli.py
// (typer -> commander; Python implementation is the spec).
//
// MUST keep `import "./tty-gate.js"` as the first import: ESM evaluates
// imports in declaration order, and picocolors (via report.js) decides color
// support ONCE at import time — the gate needs to set NO_COLOR before that
// for piped (non-TTY) runs (ledger M).
import "./tty-gate.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, type OptionValues } from "commander";
import Table from "cli-table3";

import { writeDemoSession } from "./demo.js";
import { DataDirNotFoundError, findSessionFiles } from "./discovery.js";
import { runAudit } from "./engine.js";
import { SEVERITY_ORDER, type Severity } from "./events.js";
import type { WriteFn } from "./report.js";
import { SEV_LABEL, renderTerminal, shareCard, toDict } from "./report.js";
import { CATEGORY_TITLES, allRules } from "./rules/index.js";

// Keep in sync with npm/package.json "version" (importing package.json would
// need JSON import attributes, which Node 18 does not support).
export const VERSION = "0.2.0";

export interface MainIo {
  stdout?: WriteFn;
  stderr?: WriteFn;
}

// camelCased commander view of the audit flags
interface AuditFlags {
  json?: boolean;
  severity: string;
  session?: string;
  rules?: string;
  listRules?: boolean;
  share?: boolean;
  demo?: boolean;
  version?: boolean;
}

const description =
  "npm audit for your AI coding agents - audit dangerous actions in agent history.";

export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  let exitCode: number | undefined;
  const program = new Command();
  program
    .name("agent-audit")
    .description(description)
    // main() never calls process.exit; commander's exit paths (help, usage
    // errors) are surfaced as CommanderError instead
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr })
    .argument(
      "[path]",
      "Claude Code projects dir (default ~/.claude/projects) or a .jsonl file",
    )
    .option("--json", "JSON output for scripts/CI")
    .option(
      "--severity <level>",
      "Minimum severity to show: critical|high|medium|low|info",
      "low",
    )
    .option("--session <id>", "Audit one session id")
    .option(
      "--rules <prefixes>",
      "Rule category prefixes, comma separated (D,C,E,B,U)",
    )
    .option("--list-rules", "List all rules and exit")
    .option("--share", "Print a shareable summary card")
    .option("--demo", "Run on built-in demo data")
    .option("--version", "Show version")
    .action(async (pathArg: string | undefined, opts: OptionValues) => {
      exitCode = await auditCommand(pathArg, opts as AuditFlags, stdout, stderr);
    });

  try {
    // argv is user-typed args only (bin wrapper slices process.argv)
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version paths exit 0; click/typer (the spec) uses exit code 2
      // for every usage error (unknown option, bad value), commander uses 1
      return err.exitCode === 0 ? 0 : 2;
    }
    throw err;
  }
  return exitCode ?? 0;
}

// Python: audit(...) — the single typer command body
async function auditCommand(
  pathArg: string | undefined,
  opts: AuditFlags,
  stdout: WriteFn,
  stderr: WriteFn,
): Promise<number> {
  if (opts.version) {
    stdout(`agent-audit ${VERSION}\n`);
    return 0;
  }

  if (opts.listRules) {
    // Python: rich Table(title=f"agentaudit rules ({len(all_rules())})")
    const rules = allRules();
    stdout(`agentaudit rules (${rules.length})\n`);
    const table = new Table({
      head: ["ID", "SEVERITY", "CATEGORY", "TITLE"],
      style: { head: [], border: [] },
    });
    for (const rule of rules) {
      table.push([
        rule.id,
        SEV_LABEL[rule.severity],
        CATEGORY_TITLES.get(rule.id[0]) ?? "",
        rule.title,
      ]);
    }
    stdout(`${table.toString()}\n`);
    return 0;
  }

  // Python: _parse_severity — typer.BadParameter exits 2 with this message
  const severityValue = opts.severity.toLowerCase();
  if (!(SEVERITY_ORDER as readonly string[]).includes(severityValue)) {
    stderr(`error: must be one of: ${SEVERITY_ORDER.join("|")}\n`);
    return 2;
  }
  const floor = severityValue as Severity;

  // Python: {c.strip().upper() for c in rules.split(",") if c.strip()} or None
  const prefixes = opts.rules
    ? new Set(
        opts.rules
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c)
          .map((c) => c.toUpperCase()),
      )
    : undefined;

  let result;
  if (opts.demo) {
    // Python: tempfile.TemporaryDirectory() context manager
    const tmp = mkdtempSync(join(tmpdir(), "agentaudit-demo-"));
    try {
      const files = [writeDemoSession(tmp)];
      result = await runAudit(files, prefixes, opts.session);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    // Python: if path is not None and path.is_file() -> [path], else
    // find_session_files(path); DataDirNotFound -> "error: ..." + exit 2
    let files: string[] | null = null;
    if (pathArg !== undefined) {
      try {
        if (statSync(pathArg).isFile()) {
          files = [pathArg];
        }
      } catch {
        // not stat-able == Python's is_file() False -> fall through to discovery
      }
    }
    if (files === null) {
      try {
        files = findSessionFiles(pathArg);
      } catch (err) {
        if (err instanceof DataDirNotFoundError) {
          stderr(`error: ${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    // stderr keeps --json stdout pure; real dirs can take ~10s before output
    stderr(`scanning ${files.length} session file(s)...\n`);
    result = await runAudit(files, prefixes, opts.session);
  }

  // (ADJUSTMENT B) severity floor applies to BOTH terminal and JSON modes
  result.findings = result.findings.filter(
    (f) =>
      SEVERITY_ORDER.indexOf(f.severity) >= SEVERITY_ORDER.indexOf(floor),
  );

  if (opts.json) {
    // plain stdout, no color; JSON.stringify is natively unicode, matching
    // Python's json.dumps(ensure_ascii=False)
    stdout(`${JSON.stringify(toDict(result), null, 2)}\n`);
  } else {
    renderTerminal(result, floor, stdout);
  }
  if (opts.share && !opts.json) {
    // card would corrupt the machine-readable JSON stream on stdout
    stdout("\n");
    stdout(`${shareCard(result)}\n`);
  }
  return 0;
}

// Bin wiring: run only when invoked directly as `node dist/cli.js` (or via the
// npm bin shim), never when imported (tests call main() with injected writers).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
