// Streaming parser: Codex CLI rollout-*.jsonl -> unified events.
// v0.2.x multi-agent plan (M2); format ground truth:
// docs/superpowers/research/2026-09-20-codex-format.md (codex-rs source,
// cross-checked against the 5 local rollout files). Error/stats semantics
// mirror parsers/claude-code.ts:
//   - blank lines are never counted; unparseable / non-record lines -> linesSkipped
//   - unknown record `type`s (envelope level) and unknown response_item
//     payload types are skipped SILENTLY (counted as nothing): Codex adds
//     variants across CLI versions (world_state appeared mid-2026,
//     task_started <-> turn_started renamed, ...), and `event_msg` — the UI
//     channel — deliberately does NOT persist tool activity
//     (codex-rs rollout/src/policy.rs::should_persist_event_msg). Tool calls
//     live ONLY in `response_item` records, which is all this parser maps.
//   - a missing file REJECTS with the fs error (the engine counts files_failed)
//
// Envelope (codex-rs history/src/lib.rs RolloutLine):
//   {"timestamp":"<RFC3339 UTC>","ordinal":N,"type":"<item-type>","payload":{...}}
// Line order == append order == causal order; ordinals are per-file, 0..n.
// Event timestamps come from the ENVELOPE, never the payload.
//
// Identity (research doc §8):
//   session id : session_meta.session_id (first session_meta wins; `id` holds
//                the same thread uuid) -> filename uuid
//                (rollout-<compact-ts>-<uuid>; fork names append
//                _<rollout-id> AFTER the thread uuid, so the FIRST uuid-shaped
//                group is the thread id) -> plain file stem (claude parity).
//   project    : session_meta.cwd -> parent-dir name (claude/kimi parity).
//                Stable for the whole file — turn_context cwd feeds only the
//                ShellCommand.cwd chain below.
//   ShellCommand.cwd: args workdir/working_directory -> most recent
//                turn_context.cwd at or before the line -> session_meta.cwd.
//
// Tool mapping (response_item payloads only; shapes source-verified — the
// local corpus has ZERO tool-call records, so fixtures are synthetic):
//   function_call name "exec_command"   -> ShellCommand. `arguments` is a
//      JSON-ENCODED STRING: {"cmd": "...", "workdir"?} — decode the line,
//      then the arguments string (double decode).
//   function_call name "shell" (legacy) -> ShellCommand from
//      {"command": [...], "workdir"?} — array form joined with spaces.
//   local_shell_call                    -> ShellCommand from
//      action.command (a PARSED array) + action.working_directory.
//   custom_tool_call name "apply_patch" -> one FileWrite per V4A patch entry
//      (Add = full content; Update = diff only, content null; Delete = path
//      only; Move to: = destination path). See parseApplyPatch below.
//   web_search_call                     -> NetworkRequest(action.query | action.url).
//   function_call with payload.namespace (MCP server), or a "__" in the name
//      (flat "<server>__<tool>"; legacy "mcp__<server>__<tool>") -> McpToolCall.
//   every other function_call / custom_tool_call name (view_image, custom
//      containers, ...) -> skipped for now.
//
// .jsonl.zst rollouts (newer builds compress cold sessions; codex decompresses
// transparently for itself) are NOT supported in v0.2.x — discovery EXCLUDES
// them (agents.ts), so they cost nothing; a .zst path handed here directly
// would only produce linesSkipped noise from binary garbage.
import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

import {
  Event,
  FileWrite,
  McpToolCall,
  NetworkRequest,
  ShellCommand,
} from "../events.js";
import { ParseStats, parseTs, pyJsonDumps } from "./claude-code.js";

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

const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

// Filename fallback for the session id: rollout-<compact-ts>-<thread-uuid>
// (forks: ...-<thread-uuid>_<rollout-id> — the thread id comes FIRST, and the
// compact timestamp's 4-2-2 digit groups are not uuid-shaped). Anything else
// falls back to the plain stem, exactly like claude-code.ts.
function sessionFromFilename(path: string): string {
  const s = stem(path);
  const m = s.match(UUID_RE);
  return m ? m[0] : s;
}

// ShellCommand.raw derivation: a string passes through, an array joins with
// spaces (shell/local_shell_call legacy forms), anything else -> null (skip).
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

function strField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v ? v : null;
}

// McpToolCall.argsHint: pyJsonDumps of the PARSED arguments (claude/kimi
// parity), sliced to the 200-char hint budget. An arguments value that is not
// parseable JSON falls back to the raw string (still sliced) — evidence beats
// formatting when a tool call is malformed.
function argsHintOf(rawArgs: unknown): string {
  if (typeof rawArgs === "string") {
    try {
      return pyJsonDumps(JSON.parse(rawArgs)).slice(0, 200);
    } catch {
      return rawArgs.slice(0, 200);
    }
  }
  return pyJsonDumps(isRecord(rawArgs) ? rawArgs : {}).slice(0, 200);
}

// --- V4A ("apply_patch") freeform patch text --------------------------------

// One file entry of an apply_patch patch.
export interface PatchEntry {
  kind: "add" | "update" | "delete" | "move";
  path: string;
  // Full resulting content for Add File ("" = empty file); null for
  // Update/Delete/Move — a diff or a rename never carries the resulting file.
  content: string | null;
}

// Line-scan parser for the apply_patch grammar (codex-rs "V4A"). Sections:
//   *** Add File: <path>     body lines are "+"-prefixed, content = full file
//   *** Update File: <path>  diff hunks (@@ / context / - / +), no full file
//   *** Move to: <path>      inside an Update section -> rename destination
//   *** Delete File: <path>  no body
// framed by *** Begin Patch / *** End Patch. Tolerant by design: a missing
// End Patch still flushes the last section, CRLF is accepted, unknown "*** "
// markers are ignored, paths are taken verbatim (Windows backslashes and
// spaces survive), and text with no sections yields [].
export function parseApplyPatch(patch: string): PatchEntry[] {
  const entries: PatchEntry[] = [];
  let kind: PatchEntry["kind"] | null = null;
  let path = "";
  let moveTo: string | null = null;
  const added: string[] = [];
  const flush = (): void => {
    if (kind === null) {
      return;
    }
    if (kind === "update" && moveTo !== null) {
      entries.push({ kind: "move", path: moveTo, content: null });
    } else {
      entries.push({
        kind,
        path,
        content: kind === "add" ? added.join("\n") : null,
      });
    }
    kind = null;
    moveTo = null;
    added.length = 0;
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("*** ")) {
      const m = line.match(/^\*\*\* (Add File|Update File|Delete File|Move to): ?(.*)$/);
      if (m) {
        const tag = m[1]!;
        const target = m[2]!;
        if (tag === "Move to") {
          if (kind === "update") {
            moveTo = target;
          }
        } else {
          flush();
          kind = tag === "Add File" ? "add" : tag === "Update File" ? "update" : "delete";
          path = target;
        }
      } else if (line.trim() === "*** End Patch") {
        break;
      }
      // "*** Begin Patch" and unknown markers: framing only, keep scanning
      continue;
    }
    if (kind === "add" && line.startsWith("+")) {
      added.push(line.slice(1));
    }
    // Update/Delete bodies carry no full file content — path-only events.
  }
  flush();
  return entries;
}

// --- iterEvents --------------------------------------------------------------

export async function* iterEvents(
  path: string,
  stats: ParseStats = new ParseStats(),
): AsyncGenerator<Event> {
  // claude-code parity fallbacks, upgraded in-place by session_meta
  let sessionId = sessionFromFilename(path);
  let project = basename(dirname(path));
  let cwdSession: string | null = null; // session_meta.cwd
  let cwdRolling: string | null = null; // most recent turn_context.cwd
  let sawMeta = false; // first session_meta wins
  const shellCwd = (workdir: string | null): string | null =>
    workdir ?? cwdRolling ?? cwdSession;

  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let failure: NodeJS.ErrnoException | null = null;
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
      if (type === "session_meta") {
        if (!sawMeta) {
          sawMeta = true;
          const payload = isRecord(rec["payload"]) ? rec["payload"] : {};
          // Python `or` chain: session_id preferred, `id` is the same thread
          // uuid (alias drift across CLI versions)
          const sid = payload["session_id"] || payload["id"];
          if (typeof sid === "string" && sid) {
            sessionId = sid;
          }
          cwdSession = strField(payload, "cwd");
          if (cwdSession) {
            project = cwdSession;
          }
        }
        continue;
      }
      if (type === "turn_context") {
        const payload = isRecord(rec["payload"]) ? rec["payload"] : {};
        const cwd = strField(payload, "cwd");
        if (cwd) {
          cwdRolling = cwd;
        }
        continue;
      }
      if (type !== "response_item") {
        // event_msg / world_state / token_usage_record / unknown future
        // variants: no audited actions — skipped silently, never counted
        continue;
      }
      const payload = isRecord(rec["payload"]) ? rec["payload"] : {};
      const itemType = payload["type"];
      const ts = parseTs(rec["timestamp"]);

      if (itemType === "function_call") {
        const name = payload["name"];
        if (typeof name !== "string" || !name) {
          continue;
        }
        const namespace = strField(payload, "namespace");
        if (namespace) {
          // MCP via the newer explicit namespace field; `name` is the tool
          stats.events += 1;
          yield new McpToolCall(
            sessionId, project, ts, namespace, name, argsHintOf(payload["arguments"]),
          );
          continue;
        }
        if (name.includes("__")) {
          // MCP via the flat name: "<server>__<tool>", legacy
          // "mcp__<server>__<tool>" — same split as the claude/kimi mcp__
          // handling (split fully, rejoin the remainder).
          const body = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
          const parts = body.split("__");
          if (parts.length >= 2 && parts[0]) {
            stats.events += 1;
            yield new McpToolCall(
              sessionId, project, ts,
              parts[0], parts.slice(1).join("__"), argsHintOf(payload["arguments"]),
            );
          }
          continue;
        }
        if (name === "exec_command" || name === "shell") {
          // `arguments` is a JSON-encoded STRING — second decode
          let args: unknown;
          try {
            args = JSON.parse(typeof payload["arguments"] === "string" ? payload["arguments"] : "");
          } catch {
            continue; // malformed args: no event, the LINE itself was fine
          }
          if (!isRecord(args)) {
            continue;
          }
          const cmd = joinCmd(name === "exec_command" ? args["cmd"] : args["command"]);
          if (cmd === null) {
            continue;
          }
          stats.events += 1;
          yield new ShellCommand(
            sessionId, project, ts, cmd, shellCwd(strField(args, "workdir")),
          );
        }
        // every other tool name (view_image, custom tools, ...): skipped
        continue;
      }

      if (itemType === "local_shell_call") {
        const action = isRecord(payload["action"]) ? payload["action"] : null;
        const cmd = action ? joinCmd(action["command"]) : null;
        if (!action || cmd === null) {
          continue;
        }
        stats.events += 1;
        yield new ShellCommand(
          sessionId, project, ts, cmd, shellCwd(strField(action, "working_directory")),
        );
        continue;
      }

      if (itemType === "custom_tool_call") {
        if (payload["name"] === "apply_patch" && typeof payload["input"] === "string") {
          for (const entry of parseApplyPatch(payload["input"] as string)) {
            if (!entry.path) {
              continue; // malformed section header — nothing to audit
            }
            stats.events += 1;
            yield new FileWrite(sessionId, project, ts, entry.path, null, entry.content);
          }
        }
        continue; // other custom tools: skipped
      }

      if (itemType === "web_search_call") {
        const action = isRecord(payload["action"]) ? payload["action"] : {};
        // search -> query, open_page/find_in_page -> url (Python `or` chain);
        // newer builds may carry queries: [str] instead of singular query
        const queries = action["queries"];
        const url =
          action["query"] ||
          action["url"] ||
          (Array.isArray(queries) && typeof queries[0] === "string"
            ? queries[0]
            : undefined);
        if (typeof url === "string" && url) {
          stats.events += 1;
          yield new NetworkRequest(sessionId, project, ts, url);
        }
        continue;
      }
      // message / reasoning / function_call_output / unknown payload types:
      // skipped silently (developer messages are injected scaffolding, outputs
      // join their calls only via call_id — v0.2.x keeps evidence call-side)
    }
    if (failure !== null) {
      throw failure;
    }
  } finally {
    rl.close();
    input.destroy();
  }
}
