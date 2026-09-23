#!/usr/bin/env node
// agentaudit CLI entry point. Faithful port of src/agentaudit/cli.py
// (typer -> commander; Python implementation is the spec).
//
// MUST keep `import "./tty-gate.js"` as the first import: ESM evaluates
// imports in declaration order, and picocolors (via report.js) decides color
// support ONCE at import time — the gate needs to set NO_COLOR before that
// for piped (non-TTY) runs (ledger M).
import "./tty-gate.js";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, type OptionValues } from "commander";
import Table from "cli-table3";

import { AGENTS, type AgentFileEntry } from "./agents.js";
import {
  DEFAULT_MARKER,
  canaryCheck,
  canaryExitCode,
  defaultCanaryDir,
  renderCanary,
} from "./canary.js";
import { writeDemoSession } from "./demo.js";
import { DataDirNotFoundError, comparePaths } from "./discovery.js";
import { runAudit } from "./engine.js";
import { SEVERITY_ORDER, type Severity } from "./events.js";
import { qoderFootprint, renderFootprint } from "./footprint.js";
import type { WriteFn } from "./report.js";
import { SEV_LABEL, renderTerminal, shareCard, toDict } from "./report.js";
import { CATEGORY_TITLES, allRules } from "./rules/index.js";
import { defaultWatchDeps } from "./watch-poller.js";
import {
  DEFAULT_WATCH_PROCS,
  WATCH_DEFAULT_SECONDS,
  WatchUnsupportedError,
  parseWatchProcs,
  renderWatchSummary,
  runWatch,
  type WatchDeps,
} from "./watch.js";

// Keep in sync with npm/package.json "version" (importing package.json would
// need JSON import attributes, which Node 18 does not support).
export const VERSION = "0.4.1";

export interface MainIo {
  stdout?: WriteFn;
  stderr?: WriteFn;
  // M5 test seam: partial override of the watch deps (poll/now/sleep/...)
  // so CLI tests never spawn powershell. CLI-only; audit ignores it.
  watchDeps?: Partial<WatchDeps>;
  // v0.4.1 test seam: replaces the canary store registry so CLI tests run on
  // tmpdir fixtures instead of walking the real (multi-GB) tool data dirs.
  canaryStores?: Array<[string, string]>;
}

// camelCased commander view of the audit flags
interface AuditFlags {
  json?: boolean;
  severity: string;
  session?: string;
  rules?: string;
  listRules?: boolean;
  agent: string;
  listAgents?: boolean;
  share?: boolean;
  demo?: boolean;
  version?: boolean;
  // M5 watch mode (TS-only, Windows-first)
  watch?: boolean;
  proc?: string;
  seconds?: string;
  csv?: string;
  // M6 footprint mode (TS-only inventory report)
  footprint?: boolean;
  // v0.4.1 canary mode (TS-only covert-scanning detector)
  canary?: boolean;
  canaryDir?: string;
  marker?: string;
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
    .option(
      "--agent <ids>",
      "Agents to audit, comma separated: claude-code|kimi|codex|zcode|all (--footprint: qoder only)",
      "all",
    )
    .option("--list-agents", "List known agents and exit")
    .option("--share", "Print a shareable summary card")
    .option("--demo", "Run on built-in demo data")
    // M5 watch mode: live per-process TCP egress monitoring (Windows only
    // in v0.2.x; watch is a MODE on the single-command CLI, not a
    // subcommand). Audit flags are ignored in watch mode and vice versa.
    .option("--watch", "Watch AI-tool processes' live TCP egress (Windows only)")
    .option(
      "--proc <names>",
      "Watch: process names, comma separated (.exe stripped); default: all known AI tools",
    )
    .option(
      "--seconds <n>",
      "Watch: how long to poll, seconds",
      String(WATCH_DEFAULT_SECONDS),
    )
    .option("--csv <path>", "Watch: append one CSV row per new connection")
    // M6 footprint mode: local-data inventory report (Qoder CN only in
    // v0.2.x). Like --watch, a MODE on the single-command CLI: audit flags
    // do not apply. The positional [path] overrides the Qoder data root.
    .option(
      "--footprint",
      "Inventory what a tool collected locally (Qoder index stores)",
    )
    // v0.4.1 canary mode: a marker-carrying throwaway project you NEVER open
    // in any AI tool; the marker turning up in a tool's data dir is hard
    // proof it scanned your disk on its own (content-level, unlike --watch).
    .option(
      "--canary",
      "Canary check: did any AI tool secretly scan your local projects?",
    )
    .option(
      "--canary-dir <path>",
      "Canary: path to the marker project (default ~/canary-project)",
    )
    .option(
      "--marker <s>",
      `Canary: override the marker string (default ${DEFAULT_MARKER}; use a per-machine one — see README recipe)`,
    )
    .option("--version", "Show version")
    .action(async (pathArg: string | undefined, opts: OptionValues) => {
      exitCode = await auditCommand(
        pathArg,
        opts as AuditFlags,
        stdout,
        stderr,
        io.watchDeps,
        io.canaryStores,
      );
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
  watchInject?: Partial<WatchDeps>,
  canaryStores?: Array<[string, string]>,
): Promise<number> {
  if (opts.version) {
    stdout(`agent-audit ${VERSION}\n`);
    return 0;
  }

  // v0.4.1: canary is a mode too, checked first — the monitoring loop runs
  // it before everything else (fast, independent of watch/audit machinery).
  if (opts.canary) {
    return canaryCommand(opts, stdout, stderr, canaryStores);
  }
  // M5: watch is a mode on this command; audit flags below do not apply.
  if (opts.watch) {
    return watchCommand(opts, stdout, stderr, watchInject);
  }
  // M6: footprint is a mode too (checked before the watch-flag hint below so
  // `--footprint` never falls through into an audit).
  if (opts.footprint) {
    return footprintCommand(opts, pathArg, stdout, stderr);
  }
  if (
    opts.proc !== undefined ||
    opts.csv !== undefined ||
    opts.canaryDir !== undefined ||
    opts.marker !== undefined
  ) {
    // common typo guard: mode flags silently doing nothing would confuse
    stderr(
      "note: --proc/--seconds/--csv apply to --watch mode; --canary-dir/--marker apply to --canary mode; ignored\n",
    );
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

  if (opts.listAgents) {
    // v0.2.x (TS-only flag, no Python parity): informational listing of the
    // agent registry with per-agent default-root file counts. A missing data
    // root just shows 0 — this is a listing, not an audit.
    const agents = Object.values(AGENTS);
    stdout(`agentaudit agents (${agents.length})\n`);
    const table = new Table({
      head: ["ID", "NAME", "SESSION FILES"],
      style: { head: [], border: [] },
    });
    for (const agent of agents) {
      let count = 0;
      try {
        count = agent.find().length;
      } catch {
        count = 0;
      }
      table.push([agent.id, agent.displayName, String(count)]);
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

  // v0.2.x: --agent id[,id...]|all (default all = every registered agent).
  // "all" expands to registry order; unknown ids exit 2 (typer usage-error code).
  const agentNames = [...new Set(
    opts.agent.split(",").map((s) => s.trim()).filter(Boolean),
  )];
  const ids = agentNames.includes("all") ? Object.keys(AGENTS) : agentNames;
  if (ids.length === 0) {
    stderr(`error: no agent ids given (known: ${Object.keys(AGENTS).join(", ")})\n`);
    return 2;
  }
  const unknownId = ids.find((id) => !AGENTS[id]);
  if (unknownId) {
    stderr(`error: unknown agent "${unknownId}" (known: ${Object.keys(AGENTS).join(", ")})\n`);
    return 2;
  }

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
    // find_session_files(path); DataDirNotFound -> "error: ..." + exit 2.
    // v0.2.x: discovery runs per selected agent over {agent, path} entries so
    // the engine can route each file to the right parser.
    let entries: AgentFileEntry[] | null = null;
    if (pathArg !== undefined) {
      try {
        if (statSync(pathArg).isFile()) {
          // explicit file: route through the FIRST selected agent (default
          // "all" -> claude-code, preserving v0.1 behavior for file args)
          entries = [{ agent: ids[0]!, path: pathArg }];
        }
      } catch {
        // not stat-able == Python's is_file() False -> fall through to discovery
      }
    }
    if (entries === null) {
      entries = [];
      try {
        for (const id of ids) {
          try {
            for (const path of AGENTS[id].find(pathArg)) {
              entries.push({ agent: id, path });
            }
          } catch (err) {
            // Error policy: an explicitly given path that cannot be scanned
            // still fails loudly (v0.1 behavior, asserted by tests). Only a
            // MISSING DEFAULT root (no path argument) demotes a single agent
            // to a stderr hint when several were selected.
            if (err instanceof DataDirNotFoundError && pathArg === undefined && ids.length > 1) {
              stderr(`skipping ${id}: data directory not found\n`);
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof DataDirNotFoundError) {
          // Python: DataDirNotFound -> "error: ..." + exit 2
          stderr(`error: ${err.message}\n`);
          return 2;
        }
        throw err;
      }
      // deterministic interleaving of per-agent discoveries (pathlib compare)
      entries.sort((a, b) => comparePaths(a.path, b.path));
    }
    // stderr keeps --json stdout pure; real dirs can take ~10s before output
    stderr(`scanning ${entries.length} session file(s)...\n`);
    result = await runAudit(entries, prefixes, opts.session);
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

// M5 watch mode: poll Get-NetTCPConnection via a PowerShell child once per
// ~700ms, label targets against the domain registry, print a live line per
// NEW connection, a summary at the end (and on Ctrl+C), append CSV rows.
// Windows-only in v0.2.x — anything else exits 2 with the reason.
async function watchCommand(
  opts: AuditFlags,
  stdout: WriteFn,
  stderr: WriteFn,
  inject?: Partial<WatchDeps>,
): Promise<number> {
  // default list = every known AI-tool process name; --proc replaces it
  const procs =
    opts.proc !== undefined ? parseWatchProcs(opts.proc) : [...DEFAULT_WATCH_PROCS];
  if (procs.length === 0) {
    stderr("error: --proc must name at least one process (comma separated)\n");
    return 2;
  }
  const seconds = Number(opts.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    stderr(`error: --seconds must be a positive number (got "${opts.seconds}")\n`);
    return 2;
  }

  const deps: WatchDeps = {
    ...defaultWatchDeps(),
    // live lines go through the SAME injected writer as everything else
    writeLine: (line) => stdout(`${line}\n`),
    ...(inject ?? {}),
  };
  // Ctrl+C: abort the watch, runWatch returns the partial result and the
  // summary below still prints (same output as a natural end).
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    stdout(
      `watching ${procs.join(", ")} for ${seconds}s (Ctrl+C to stop) — ` +
        "unknown targets are flagged [!]\n",
    );
    const result = await runWatch(
      { procs, seconds, csvPath: opts.csv, signal: controller.signal },
      deps,
    );
    stdout(renderWatchSummary(result, opts.csv));
    return 0;
  } catch (err) {
    if (err instanceof WatchUnsupportedError) {
      stderr(`${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

// M6 footprint mode: inventory the local index stores of one tool (Qoder CN
// only in v0.2.x — anything else exits 2 with the reason). NOT an audit: the
// report lists what the tool collected (repos, file paths, counts, times);
// see src/footprint.ts for the privacy posture. The positional [path]
// overrides the tool's default data root (also how tests point at fixtures).
function footprintCommand(
  opts: AuditFlags,
  pathArg: string | undefined,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const ids = opts.agent
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // "all" is the commander default, i.e. literally the bare `--footprint`
  // form — it maps to the only supported tool, qoder.
  const unsupported = ids.filter((id) => id !== "qoder" && id !== "all");
  if (unsupported.length > 0) {
    stderr(
      `error: footprint only supports --agent qoder in v0.2.x (got: ${unsupported.join(", ")})\n`,
    );
    return 2;
  }
  const report = qoderFootprint(pathArg);
  if (opts.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(renderFootprint(report));
  }
  return 0;
}

// v0.4.1 canary mode: scan every known tool's data dir for the canary
// project's marker (read-only, binary-safe). Exit codes 0/1/2/3 = clean /
// dirty / no canary dir / detector self-test failed. `canaryStores` is the
// MainIo test seam — real runs use the built-in registry.
function canaryCommand(
  opts: AuditFlags,
  stdout: WriteFn,
  stderr: WriteFn,
  canaryStores?: Array<[string, string]>,
): number {
  const canaryDir = opts.canaryDir ?? defaultCanaryDir();
  if (!existsSync(canaryDir)) {
    // friendly setup error, not a stack trace: point at the README recipe
    stderr(
      `error: canary project not found at ${canaryDir}\n\n` +
        "Create one (the canary recipe):\n" +
        "  1. make the dir and drop a couple of innocuous files in it (README.md, package.json)\n" +
        `  2. hide your marker string inside, e.g.: echo "canary-marker: <marker>" > "${canaryDir}\\CANARY.txt"\n` +
        "  3. generate a per-machine marker, e.g.:\n" +
        '       powershell -Command "ZCANARY-" + [guid]::NewGuid().ToString("N").Substring(0,12).ToUpper()\n' +
        "     pass it via --marker, and NEVER open this project in any AI tool —\n" +
        "     the marker appearing in a tool's data dir is proof it scanned your disk.\n",
    );
    return 2;
  }
  const report = canaryCheck({
    canaryDir,
    marker: opts.marker ?? DEFAULT_MARKER,
    stores: canaryStores,
  });
  if (opts.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(renderCanary(report));
  }
  return canaryExitCode(report.status);
}

// Bin wiring: run only when invoked directly as `node dist/cli.js` (or via the
// npm bin shim), never when imported (tests call main() with injected writers).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
