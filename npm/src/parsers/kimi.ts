// Streaming parser: Kimi-Code wire.jsonl -> unified events.
// v0.2.x multi-agent plan (M1): TS canonical, no Python parity (Python is
// frozen at v0.1.1). Error/stats semantics mirror parsers/claude-code.ts:
//   - blank lines are never counted; unparseable lines -> linesSkipped
//   - unknown record types are skipped silently (counted as nothing)
//   - a missing file REJECTS with the fs error (the engine counts files_failed)
//
// Wire layout (protocol 1.5, verified against real data 2026-09-20):
//   <root>/wd_<dirname>_<hash>/session_<uuid>/agents/main/wire.jsonl
//   + sibling state.json: {"id":"session_<uuid>","version":2,"cwd":"...",...}
// Every record has `type`; `context.append_loop_event` wraps an inner event
// whose `tool.call` members carry {uuid, toolCallId, name, args}. Timestamps
// are epoch MILLISECONDS on the OUTER record (`time`), not ISO strings.
//
// Identity resolution (the wire itself carries NO sessionId/workDir — checked
// across all record types on 14 real sessions):
//   1. metadata record sessionId / workDir|cwd  (forward compat; not on the
//      wire today, but the first metadata record wins if a future build adds it)
//   2. sibling state.json id / cwd  (the real source on current data)
//   3. path fallbacks — inside the kimi layout the session-dir name (the
//      "session_<uuid>" dir) and the wd-dir name ARE the identity (a file-stem
//      fallback would collapse every session to "wire"); outside the layout,
//      file stem / parent dir name, exactly like claude-code.ts.
//
// Tool mapping (v0.2.x scope — the four event types of the fixed model):
//   Bash -> ShellCommand(args.command)
//   Read/Write/Edit/NotebookEdit -> FileWrite(args.file_path|path|notebook_path,
//       content = args.content|new_string, isConfigPath gate). Kimi's Read uses
//       `args.path` and carries no content; the event model has no FileRead and
//       sensitive-config READS matter as much as writes to the audit (D/C rules
//       gate on isConfigPath), so Read joins the FileWrite mapping per the M1 plan.
//   FetchURL/WebFetch/WebSearch -> NetworkRequest(args.url|query)
//   mcp__* -> McpToolCall (same name convention as claude-code)
//   everything else (Grep/Glob/Skill/WaitFor/TaskStop, ...) -> skipped for now
import { createReadStream, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
  Event,
  FileWrite,
  McpToolCall,
  NetworkRequest,
  ShellCommand,
  isConfigPath,
} from "../events.js";
import { ParseStats, parseTs, pyJsonDumps } from "./claude-code.js";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const NETWORK_TOOLS: ReadonlySet<string> = new Set(["FetchURL", "WebFetch", "WebSearch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Python Path.stem parity (same helper as claude-code.ts, kept local).
function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

// The wire's native `time` is epoch ms (number). Strings keep the identical
// ISO-shape guard as claude-code's parseTs (JS new Date() alone is far too
// loose); anything else -> null so report output shows "-".
function parseKimiTs(raw: unknown): Date | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? new Date(raw) : null;
  }
  return parseTs(raw);
}

// Sibling state.json {"id","cwd"} — the real per-session identity source.
// Missing/unreadable/corrupt -> null (silent fallback, never an error).
function readStateJson(
  path: string,
): { id: string | null; cwd: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    const id = parsed["id"];
    const cwd = parsed["cwd"];
    return {
      id: typeof id === "string" && id ? id : null,
      cwd: typeof cwd === "string" && cwd ? cwd : null,
    };
  } catch {
    return null;
  }
}

// Python json.dumps parity for McpToolCall.argsHint comes from claude-code.ts
// (pyJsonDumps); the tool->event mapping below mirrors its toEvent().
function toKimiEvent(
  name: string,
  rawArgs: unknown,
  sid: string,
  project: string,
  ts: Date | null,
  cwd: string | null,
): Event | null {
  const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
  if (name === "Bash") {
    const cmd = args["command"];
    if (typeof cmd === "string" && cmd) {
      return new ShellCommand(sid, project, ts, cmd, cwd);
    }
    return null;
  }
  if (WRITE_TOOLS.has(name)) {
    // Kimi Read uses `path`; claude-style records use `file_path`/`notebook_path`.
    const p = (args["file_path"] || args["path"] || args["notebook_path"]) as unknown;
    if (typeof p !== "string" || !p) {
      return null;
    }
    let content = typeof args["content"] === "string" ? (args["content"] as string) : null;
    if (content === null && typeof args["new_string"] === "string") {
      content = args["new_string"] as string;
    }
    return new FileWrite(sid, project, ts, p, isConfigPath(p), content);
  }
  if (NETWORK_TOOLS.has(name)) {
    const url = (args["url"] || args["query"]) as unknown;
    if (typeof url === "string" && url) {
      return new NetworkRequest(sid, project, ts, url);
    }
    return null;
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    let server: string;
    let tool: string;
    if (parts.length >= 3) {
      server = parts[1]!;
      tool = parts.slice(2).join("__");
    } else {
      server = "?";
      tool = name;
    }
    return new McpToolCall(
      sid, project, ts, server, tool,
      pyJsonDumps(args).slice(0, 200),
    );
  }
  return null; // Grep/Glob/Skill/WaitFor/... — see mapping note in the header
}

export async function* iterEvents(
  path: string,
  stats: ParseStats = new ParseStats(),
): AsyncGenerator<Event> {
  // <sessionDir>/agents/<agentDir>/wire.jsonl — only trust the kimi layout
  // (and its sibling state.json) when the path actually has that shape.
  const agentsDir = dirname(dirname(path));
  const inKimiLayout = basename(agentsDir) === "agents";
  const sessionDir = inKimiLayout ? dirname(agentsDir) : null;

  const state = sessionDir ? readStateJson(join(sessionDir, "state.json")) : null;

  // fallback identity (claude-code parity, kimi-layout aware — see header)
  let sessionId = inKimiLayout && sessionDir ? basename(sessionDir) : stem(path);
  let project =
    inKimiLayout && sessionDir ? basename(dirname(sessionDir)) : basename(dirname(path));
  let workDir: string | null = null; // ShellCommand.cwd — the session workDir
  if (state?.id) {
    sessionId = state.id;
  }
  if (state?.cwd) {
    workDir = state.cwd;
    project = state.cwd;
  }

  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let failure: NodeJS.ErrnoException | null = null;
  let sawMetadata = false; // first metadata record wins
  input.on("error", (err: NodeJS.ErrnoException) => {
    if (failure === null) {
      failure = err;
    }
    rl.close();
  });
  try {
    for await (const line of rl) {
      if (failure !== null) {
        throw failure;
      }
      // blank lines never counted, parse failures counted — claude-code order
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      stats.linesTotal += 1;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        stats.linesSkipped += 1;
        continue;
      }
      if (!isRecord(rec)) {
        stats.linesSkipped += 1;
        continue;
      }
      const type = rec["type"];
      if (type === "metadata") {
        if (!sawMetadata) {
          sawMetadata = true;
          const metaSid = rec["sessionId"];
          if (typeof metaSid === "string" && metaSid) {
            sessionId = metaSid;
          }
          const metaWorkDir = rec["workDir"] || rec["cwd"];
          if (typeof metaWorkDir === "string" && metaWorkDir) {
            workDir = metaWorkDir;
            project = metaWorkDir;
          }
        }
        continue;
      }
      // every other record kind only matters as a loop-event wrapper;
      // turn.prompt / profile.bind / llm.* / agent.* etc. are skipped silently
      if (type !== "context.append_loop_event") {
        continue;
      }
      const inner = rec["event"];
      if (!isRecord(inner) || inner["type"] !== "tool.call") {
        // step.begin/end, content.part and tool.result carry no audited action
        continue;
      }
      const name = inner["name"];
      if (typeof name !== "string" || !name) {
        continue;
      }
      const ev = toKimiEvent(
        name,
        inner["args"],
        sessionId,
        project,
        parseKimiTs(rec["time"]),
        workDir,
      );
      if (ev !== null) {
        stats.events += 1;
        yield ev;
      }
    }
    if (failure !== null) {
      throw failure;
    }
  } finally {
    rl.close();
    input.destroy();
  }
}
