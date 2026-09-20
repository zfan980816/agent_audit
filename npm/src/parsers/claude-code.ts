// Streaming parser: Claude Code session JSONL -> unified events.
// Faithful port of src/agentaudit/parsers/claude_code.py (Python is the spec).
import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

import {
  Event,
  FileWrite,
  McpToolCall,
  NetworkRequest,
  ShellCommand,
  isConfigPath,
} from "../events.js";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit"]);
const NETWORK_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

// Python: @dataclass ParseStats(lines_total, lines_skipped, events)
export class ParseStats {
  linesTotal = 0;
  linesSkipped = 0;
  events = 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Python isinstance(x, dict) — JSON arrays are NOT dicts.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Python _parse_ts: non-string/empty -> None; try parse; invalid -> None.
// (Python replaces "Z" with "+00:00" for fromisoformat; new Date() parses the
// Z suffix natively, so a plain parse keeps the same accept/reject outcome.)
function parseTs(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Python Path.stem: strip the last extension only when it is a real one
// (0 < dot < len-1), so dotfiles keep their name.
function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

// Python _to_event: map one tool_use block to a unified event, or null to skip.
function toEvent(
  name: string,
  rawInput: unknown,
  sid: string,
  project: string,
  ts: Date | null,
  cwd: string | null,
): Event | null {
  const inp: Record<string, unknown> = isRecord(rawInput) ? rawInput : {};
  if (name === "Bash") {
    const cmd = inp["command"];
    if (typeof cmd === "string" && cmd) {
      return new ShellCommand(sid, project, ts, cmd, cwd);
    }
    return null;
  }
  if (WRITE_TOOLS.has(name)) {
    // Python `or`: missing/empty file_path falls through to notebook_path
    const p = (inp["file_path"] || inp["notebook_path"]) as unknown;
    if (typeof p !== "string" || !p) {
      return null;
    }
    let content = typeof inp["content"] === "string" ? (inp["content"] as string) : null;
    if (content === null && typeof inp["new_string"] === "string") {
      content = inp["new_string"] as string;
    }
    return new FileWrite(sid, project, ts, p, isConfigPath(p), content);
  }
  if (NETWORK_TOOLS.has(name)) {
    const url = (inp["url"] || inp["query"]) as unknown;
    if (typeof url === "string" && url) {
      return new NetworkRequest(sid, project, ts, url);
    }
    return null;
  }
  if (name.startsWith("mcp__")) {
    // Python name.split("__", 2): at most 2 splits, remainder stays in part 3.
    // (JS split with a limit truncates instead, so split fully and rejoin.)
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
      JSON.stringify(inp).slice(0, 200),
    );
  }
  return null;
}

// Python iter_events as an async generator: readline over a UTF-8 stream
// (invalid sequences decode to U+FFFD, same as Python errors="replace").
// File errors (missing path, EISDIR, ...) REJECT so the engine can catch
// per file the way the Python engine catches OSError.
export async function* iterEvents(
  path: string,
  stats: ParseStats = new ParseStats(),
): AsyncGenerator<Event> {
  // Python: fallback_project = path.parent.name; fallback_session = path.stem
  const fallbackProject = stem(dirname(path));
  const fallbackSession = stem(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let failure: NodeJS.ErrnoException | null = null;
  input.on("error", (err: NodeJS.ErrnoException) => {
    if (failure === null) {
      failure = err;
    }
    // make sure the pending iteration ends even if readline swallows the error
    rl.close();
  });
  try {
    for await (const line of rl) {
      if (failure !== null) {
        throw failure;
      }
      // Python strips the line and skips blanks BEFORE lines_total += 1,
      // so blank lines are never counted.
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
      // Python `or` fallbacks: falsy sessionId falls back to the file stem
      const sid = (rec["sessionId"] as string) || fallbackSession;
      const ts = parseTs(rec["timestamp"]);
      const rawCwd = rec["cwd"];
      const cwd = typeof rawCwd === "string" ? rawCwd : null;
      const project = cwd ? cwd : fallbackProject;
      const msg = rec["message"];
      const content = isRecord(msg) ? msg["content"] : undefined;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!isRecord(block) || block["type"] !== "tool_use") {
          continue;
        }
        const ev = toEvent(
          (block["name"] as string) || "",
          block["input"],
          sid,
          project,
          ts,
          cwd,
        );
        if (ev !== null) {
          stats.events += 1;
          yield ev;
        }
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
