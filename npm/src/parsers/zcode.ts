// Parser: ZCode (Z.ai desktop IDE) local sqlite session store -> unified
// events. v0.2.x multi-agent plan (M4); TS-only (no Python parity). Ground
// truth: docs/superpowers/research/2026-09-20-zcode-forensics.md + live schema
// introspection (PRAGMA table_info over a copy of ~/.zcode/cli/db/db.sqlite,
// 2026-09-20 — schema complete, every DATA table 0 rows on this machine, so
// fixtures are synthetic db files built with the real schema:
// test/zcode-fixtures.ts).
//
// PRIVACY RED LINE (binding M4 decision): this parser touches ONLY the store
// given to it plus its "-wal"/"-shm" siblings (copied, see below). It must
// NEVER open ~/.zcode/v2/credentials.json, v2/tasks-index.sqlite, or any
// JWT/token/cookie data. Columns read are exactly: session(id, directory,
// slug), part(data: tool parts only), tool_usage(identity/timing). Message
// text, input_history and permission rows are never read.
//
// SQLite access:
//   - Needs the node:sqlite builtin (Node >= 22.5, flag-free on current
//     builds). Discovery (agents.ts) gates on loadNodeSqlite() and skips the
//     agent with a single stderr hint where it is missing; calling iterEvents
//     directly without it REJECTS.
//   - WAL copy strategy: ZCode keeps its db in journal_mode=wal and may be
//     running while we read; a plain mode=ro open can miss -wal content or
//     hit locks. Each parse run therefore copies db.sqlite (+ -wal/-shm when
//     present) into a fresh os.tmpdir() directory (TMP/TEMP respected) and
//     opens THE COPY read-write — a private file whose WAL is replayed there;
//     the original is never written. Copies are removed in a finally block.
//     A torn copy (store written between the copyFileSync calls) yields a
//     stale-but-consistent snapshot at worst; SQLite guarantees the original
//     cannot be corrupted by this.
//
// Schema -> events:
//   The driver is tool_usage — ZCode's per-execution ledger (tool_call_id,
//   tool_name, session_id, started_at, exit/bytes telemetry). It carries NO
//   payload columns; tool INPUT lives in part.data JSON as a tool part
//   (shape grep-verified in the zcode.cjs CLI bundle):
//     {"type":"tool","callID":...,"tool":...,"state":{"status":...,
//      "input":{...},"output":...,"title":...,"time":{...}}}
//   so the parser preloads a callID -> input map from part (rows prefiltered
//   with LIKE '%"type":"tool"%'; last row wins for retried/streamed parts)
//   and joins on tool_usage.tool_call_id. message.data holds only role/time
//   scaffolding (opencode lineage) — never read.
//
//   sessionId   : tool_usage.session_id (the FK itself; a missing session row
//                 degrades project resolution, not the event).
//   project     : session.directory -> session.slug -> session_id.
//   ShellCommand.cwd: input.workdir -> input.cwd -> session.directory.
//   timestamp   : tool_usage.started_at (action start). INTEGER time columns
//                 are epoch values; >= 10^12 reads as milliseconds, else as
//                 seconds (the unit is not observable on the 0-row live db;
//                 opencode lineage is ms and the heuristic keeps both
//                 parseable). NULL/0/garbage -> null timestamp, as elsewhere.
//   ordering    : ORDER BY started_at ASC, rowid ASC (deterministic; SQLite
//                 sorts NULL first on ASC).
//   Reads are paged (LIMIT ? OFFSET ?) to bound memory; the generator stays
//   async for the shared parser signature although sqlite reads are sync.
//
// Tool mapping (tool_name lowercased; payload from the joined part):
//   shell-class  (bash, shell, code_execution, run_command, execute_command)
//                 -> ShellCommand(input.command; string or string[] joined)
//   file-class   (read, view, write, edit, multiedit, notebookedit, patch,
//                 apply_patch, str_replace_editor,
//                 str_replace_based_edit_tool)
//                 -> FileWrite(filePath|path|file_path|notebook_path,
//                              content = content|file_text|new_string).
//                 READS are audited as content-less FileWrites on purpose
//                 (kimi M1 precedent: the event model has no FileRead and
//                 sensitive-config reads gate the same rules via isConfigPath).
//                 todowrite is deliberately NOT file-class: todo lists are
//                 not files.
//   network-class(web_fetch, webfetch, fetchurl, fetch, web_search, websearch)
//                 -> NetworkRequest(input.url | input.query)
//   "mcp__<server>__<tool>" / "<server>__<tool>" -> McpToolCall (same split
//                 as the codex parser); MCP identity lives entirely in the
//                 tool name, so its event does not need the joined part —
//                 argsHint is empty when the payload is missing.
//   everything else (grep, glob, list, skill, task, agent, computer, ...)
//                 -> skipped SILENTLY, counted as nothing (codex parser's
//                 unknown-record policy: benign/navigational tools are most
//                 of the traffic and are not "skipped data").
//
// Stats semantics (sqlite is not jsonl, so the line_* fields are redefined
// here and ONLY here):
//   linesTotal   = tool_usage rows read (candidate actions).
//   linesSkipped = tool_usage rows that are corrupt/unmappable: a missing
//                  session_id or tool_name, or an AUDITABLE-CLASS row whose
//                  joined payload cannot yield its required field (part row
//                  missing / part.data unparseable / input field mistyped).
//   events       = events emitted (same aggregate as every other parser).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Event,
  FileWrite,
  McpToolCall,
  NetworkRequest,
  ShellCommand,
} from "../events.js";
import { ParseStats, pyJsonDumps } from "./claude-code.js";

// --- node:sqlite availability gate -------------------------------------------

// Minimal structural surface of node:sqlite this parser uses (kept local so
// @types/node does not need the node:sqlite typings).
interface SqliteStatement {
  all(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export type SqliteLoader = (id: string) => unknown;

// createRequire works in ESM and require()s the builtin synchronously — the
// agent registry's find() is sync, so import() is not an option here.
export const defaultSqliteLoader: SqliteLoader = (id) => createRequire(import.meta.url)(id);

let sqliteLoader: SqliteLoader = defaultSqliteLoader;

// Tests stub this to simulate a Node without the builtin.
export function setSqliteLoaderForTests(loader: SqliteLoader): void {
  sqliteLoader = loader;
}

export function loadNodeSqlite(): NodeSqliteModule | null {
  try {
    const mod = sqliteLoader("node:sqlite") as Partial<NodeSqliteModule> | null | undefined;
    return mod && typeof mod.DatabaseSync === "function" ? (mod as NodeSqliteModule) : null;
  } catch {
    return null; // ERR_UNKNOWN_BUILTIN_MODULE on Node < 22.5, odd embedded builds
  }
}

// --- tool classification -------------------------------------------------------

// Exact lowercase sets (kimi/codex precedent: names are matched exactly, so a
// future unrelated tool whose name happens to contain "read" can't mis-map).
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash", "shell", "code_execution", "run_command", "execute_command",
]);
const FILE_TOOLS: ReadonlySet<string> = new Set([
  "read", "view", "write", "edit", "multiedit", "notebookedit", "patch",
  "apply_patch", "str_replace_editor", "str_replace_based_edit_tool",
]);
const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch", "webfetch", "fetchurl", "fetch", "web_search", "websearch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// ShellCommand.raw: a string passes through, an array of strings joins with
// spaces (codex parity); anything else -> null (unmappable).
function joinCmd(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw ? raw : null;
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((p): p is string => typeof p === "string");
    if (parts.length === 0 || parts.length !== raw.length) {
      return null;
    }
    return parts.join(" ");
  }
  return null;
}

// INTEGER epoch columns: >= 10^12 -> ms, else seconds (see header). Note the
// seconds branch must come out at the SAME wall clock for pre-2001 values;
// audit data is contemporary, so the split point is safe in practice.
function parseEpochMs(raw: unknown): Date | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return new Date(raw >= 1e12 ? raw : raw * 1000);
}

// One mapped event or the verdict "unmappable" (counted) vs null (benign,
// silent). `name` is the lowercased tool_name; `input` the joined part payload
// (null when no part row parsed for this call).
function toZcodeEvent(
  name: string,
  input: Record<string, unknown> | null,
  sessionId: string,
  project: string,
  ts: Date | null,
  sessionDir: string | null,
): { event: Event } | { skip: true } | null {
  if (SHELL_TOOLS.has(name)) {
    const cmd = joinCmd(input ? input["command"] : undefined);
    if (cmd === null) {
      return { skip: true }; // shell execution whose command never landed
    }
    const cwd = str(input?.["workdir"]) ?? str(input?.["cwd"]) ?? sessionDir;
    return { event: new ShellCommand(sessionId, project, ts, cmd, cwd) };
  }
  if (FILE_TOOLS.has(name)) {
    const path =
      str(input?.["filePath"]) ?? str(input?.["path"]) ??
      str(input?.["file_path"]) ?? str(input?.["notebook_path"]);
    if (path === null) {
      return { skip: true };
    }
    // "" is a legitimate (empty) write; only non-strings fall back to null.
    const raw = input?.["content"] ?? input?.["file_text"] ?? input?.["new_string"];
    const content = typeof raw === "string" ? raw : null;
    return { event: new FileWrite(sessionId, project, ts, path, null, content) };
  }
  if (NETWORK_TOOLS.has(name)) {
    const url = str(input?.["url"]) ?? str(input?.["query"]);
    if (url === null) {
      return { skip: true };
    }
    return { event: new NetworkRequest(sessionId, project, ts, url) };
  }
  if (name.startsWith("mcp__") || name.includes("__")) {
    const body = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
    const parts = body.split("__");
    if (parts.length < 2 || !parts[0]) {
      return { skip: true }; // not splittable into server__tool
    }
    const hint = input
      ? pyJsonDumps(input).slice(0, 200)
      : ""; // payload never landed; the name still identifies the call
    return { event: new McpToolCall(sessionId, project, ts, parts[0], parts.slice(1).join("__"), hint) };
  }
  return null; // benign/navigational tool — silent, uncounted
}

// --- paged reads ----------------------------------------------------------------

const PAGE_SIZE = 500;

function eachRow(
  db: SqliteDatabase,
  sql: string,
  visit: (row: Record<string, unknown>) => void,
): void {
  const stmt = db.prepare(sql);
  let offset = 0;
  for (;;) {
    const rows = stmt.all(PAGE_SIZE, offset);
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }
    for (const row of rows) {
      if (isRecord(row)) {
        visit(row);
      }
    }
    if (rows.length < PAGE_SIZE) {
      return;
    }
    offset += PAGE_SIZE;
  }
}

// Loads callID -> state.input from tool parts (prefiltered in SQL; the JSON
// parse is the real check). Corrupt/untool part rows are ignored: they are not
// tool_usage rows, and the join simply misses — an auditable usage row whose
// payload is corrupt is counted by the caller instead.
function loadToolInputs(db: SqliteDatabase): Map<string, Record<string, unknown>> {
  const inputs = new Map<string, Record<string, unknown>>();
  eachRow(
    db,
    `SELECT data FROM part WHERE data LIKE '%"type":"tool"%' ORDER BY rowid ASC LIMIT ? OFFSET ?`,
    (row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof row["data"] === "string" ? row["data"] : "");
      } catch {
        return;
      }
      if (!isRecord(parsed) || parsed["type"] !== "tool") {
        return; // prefilter false positive (text quoting a tool part)
      }
      const callId = str(parsed["callID"]);
      if (!callId) {
        return;
      }
      const state = isRecord(parsed["state"]) ? parsed["state"] : {};
      // Last row wins: retried/streamed parts append newer versions.
      inputs.set(callId, isRecord(state["input"]) ? state["input"] : {});
    },
  );
  return inputs;
}

function loadSessions(
  db: SqliteDatabase,
): Map<string, { directory: string | null; slug: string | null }> {
  const sessions = new Map<string, { directory: string | null; slug: string | null }>();
  eachRow(db, `SELECT id, directory, slug FROM session ORDER BY rowid ASC LIMIT ? OFFSET ?`, (row) => {
    const id = str(row["id"]);
    if (id) {
      sessions.set(id, { directory: str(row["directory"]), slug: str(row["slug"]) });
    }
  });
  return sessions;
}

function* readStore(db: SqliteDatabase, stats: ParseStats): Generator<Event> {
  const inputs = loadToolInputs(db);
  const sessions = loadSessions(db);
  const stmt = db.prepare(
    `SELECT session_id AS sessionId, tool_call_id AS callId, tool_name AS toolName,
            started_at AS startedAt
     FROM tool_usage ORDER BY started_at ASC, rowid ASC LIMIT ? OFFSET ?`,
  );
  let offset = 0;
  for (;;) {
    const rows = stmt.all(PAGE_SIZE, offset);
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }
    for (const row of rows) {
      if (!isRecord(row)) {
        stats.linesSkipped += 1;
        continue;
      }
      stats.linesTotal += 1;
      const sessionId = str(row["sessionId"]);
      const name = str(row["toolName"]);
      if (sessionId === null || name === null) {
        stats.linesSkipped += 1; // identity/classification impossible
        continue;
      }
      const sess = sessions.get(sessionId);
      const project = str(sess?.directory) ?? str(sess?.slug) ?? sessionId;
      const ts = parseEpochMs(row["startedAt"]);
      const input = str(row["callId"]) ? inputs.get(row["callId"] as string) ?? null : null;
      const mapped = toZcodeEvent(
        name.trim().toLowerCase(), input, sessionId, project, ts,
        sess?.directory ?? null,
      );
      if (mapped === null) {
        continue; // benign tool: silent (see header skip policy)
      }
      if ("skip" in mapped) {
        stats.linesSkipped += 1; // auditable class, unusable payload
        continue;
      }
      stats.events += 1;
      yield mapped.event;
    }
    if (rows.length < PAGE_SIZE) {
      return;
    }
    offset += PAGE_SIZE;
  }
}

// --- entry point -----------------------------------------------------------------

export async function* iterEvents(
  path: string,
  stats: ParseStats = new ParseStats(),
): AsyncGenerator<Event> {
  const mod = loadNodeSqlite();
  if (mod === null) {
    throw new Error(
      "node:sqlite is required to parse the ZCode session store (Node >= 22.5)",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "agentaudit-zcode-"));
  const copyPath = join(work, "db.sqlite");
  let db: SqliteDatabase | null = null;
  try {
    copyFileSync(path, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) {
        copyFileSync(path + suffix, copyPath + suffix);
      }
    }
    // Open the COPY read-write on purpose: replaying its WAL may write (and
    // close checkpoints); the original store is never touched.
    db = new mod.DatabaseSync(copyPath);
    yield* readStore(db, stats);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // already closed / failed open — the rmSync below is what matters
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}
