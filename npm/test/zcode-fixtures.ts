// ZCode sqlite session-store fixtures (M4). The live db on this machine has a
// complete schema but ZERO data rows (ZCode never ran an agent session here),
// so fixtures are synthetic sqlite files built with node:sqlite using the REAL
// schema columns (introspected 2026-09-20 via `PRAGMA table_info` on a copy of
// ~/.zcode/cli/db/db.sqlite) and the REAL part.data JSON shape (grep-verified
// against the zcode.cjs CLI bundle: tool parts are
//   {type:"tool", callID, tool, state:{status, input, output, title, ...}}
// joined to tool_usage rows by callID == tool_usage.tool_call_id).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadNodeSqlite } from "../src/parsers/zcode.js";

export const ZCODE_SESSION = "ses_zcode_demo_0001";
export const ZCODE_DIR = "D:\\demo\\zcode-proj";
// INTEGER time columns are epoch values (opencode lineage: milliseconds).
export const ZCODE_TS = 1789711026000;

// Minimal structural surface of node:sqlite used here (avoids a hard
// @types/node dependency on the node:sqlite typings).
export interface ZcodeStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
export interface ZcodeDb {
  prepare(sql: string): ZcodeStatement;
  exec(sql: string): void;
  close(): void;
}

// Opens (creating if needed) a sqlite db; caller must close().
export function openZcodeDb(path: string): ZcodeDb {
  const mod = loadNodeSqlite();
  if (!mod) {
    throw new Error("node:sqlite unavailable: zcode fixtures need Node >= 22.5");
  }
  return new (mod.DatabaseSync as unknown as new (p: string) => ZcodeDb)(path);
}

// The parser only READS session/message/part/tool_usage; fixtures create
// exactly those tables with the live db's verbatim column lists.
const SCHEMA_SQL = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
  slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER,
  time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER,
  task_type TEXT, title_source TEXT, title_message_id TEXT,
  time_title_updated INTEGER, trace_id TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
  time_updated INTEGER, data TEXT, sequence INTEGER
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
  time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER
);
CREATE TABLE tool_usage (
  id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, trace_id TEXT,
  tool_call_id TEXT, tool_name TEXT, side_effect_scope TEXT, read_only INTEGER,
  destructive INTEGER, approval_status TEXT, status TEXT, started_at INTEGER,
  first_output_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
  time_to_first_output_ms INTEGER, exit_code INTEGER, output_bytes INTEGER,
  stdout_bytes INTEGER, stderr_bytes INTEGER, truncated INTEGER,
  retry_count INTEGER, retryable INTEGER, cancelled_by_user INTEGER,
  error_type TEXT, error_code TEXT, error_message TEXT
);
`;

export function createZcodeDb(path: string): ZcodeDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = openZcodeDb(path);
  db.exec(SCHEMA_SQL);
  return db;
}

export function insertSession(
  db: ZcodeDb,
  opts: { id?: string; directory?: string | null } = {},
): void {
  const id = opts.id ?? ZCODE_SESSION;
  db.prepare(
    "INSERT INTO session (id, project_id, directory, time_created) VALUES (?, ?, ?, ?)",
  ).run(id, "proj_" + id, opts.directory === undefined ? ZCODE_DIR : opts.directory, ZCODE_TS);
}

export interface ZcodePartSpec {
  callId: string;
  tool: string;
  input?: unknown;
  status?: string;
  sessionId?: string;
  // Raw part.data override (corrupt-row fixtures); wins over the built shape.
  dataOverride?: string;
}

// One part.data row, bundle-verified shape (see file header).
export function insertToolPart(db: ZcodeDb, spec: ZcodePartSpec): void {
  const sessionId = spec.sessionId ?? ZCODE_SESSION;
  const data =
    spec.dataOverride ??
    JSON.stringify({
      id: "prt_" + spec.callId,
      messageID: "msg_1",
      sessionID: sessionId,
      type: "tool",
      callID: spec.callId,
      tool: spec.tool,
      state: {
        status: spec.status ?? "completed",
        input: spec.input ?? {},
        output: "ok",
        title: spec.tool,
        metadata: {},
        time: { start: ZCODE_TS, end: ZCODE_TS + 500 },
      },
    });
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("prt_" + spec.callId, "msg_1", sessionId, ZCODE_TS, data, 1);
}

export interface ZcodeUsageSpec {
  callId?: string | null;
  toolName: string;
  sessionId?: string | null;
  startedAt?: number | null;
  status?: string;
}

export function insertToolUsage(db: ZcodeDb, spec: ZcodeUsageSpec): void {
  const callId = spec.callId === undefined ? "call_" + usageCounter() : spec.callId;
  db.prepare(
    "INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, side_effect_scope, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "tu_" + usageCounter(),
    spec.sessionId === undefined ? ZCODE_SESSION : spec.sessionId,
    callId,
    spec.toolName,
    "write",
    spec.status ?? "completed",
    spec.startedAt === undefined ? ZCODE_TS : spec.startedAt,
    spec.startedAt === undefined ? ZCODE_TS + 500 : null,
  );
}

let counter = 0;
function usageCounter(): number {
  counter += 1;
  return counter;
}

export interface ZcodeDbSpec {
  // omitted -> one default session; [] -> no session rows at all
  sessions?: Array<{ id?: string; directory?: string | null }>;
  parts?: ZcodePartSpec[];
  usages?: ZcodeUsageSpec[];
}

// Builds <root>/db.sqlite with the spec applied and returns the db path (the
// exact file name ZCode uses, so directory-root discovery finds it too).
export function writeZcodeDb(root: string, spec: ZcodeDbSpec): string {
  const dbPath = join(root, "db.sqlite");
  const db = createZcodeDb(dbPath);
  try {
    for (const s of spec.sessions ?? [{ id: ZCODE_SESSION, directory: ZCODE_DIR }]) {
      insertSession(db, s);
    }
    for (const p of spec.parts ?? []) {
      insertToolPart(db, p);
    }
    for (const u of spec.usages ?? []) {
      insertToolUsage(db, u);
    }
  } finally {
    db.close();
  }
  return dbPath;
}
