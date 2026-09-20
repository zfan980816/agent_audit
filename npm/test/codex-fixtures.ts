// Codex CLI rollout-*.jsonl fixtures. Envelope + session_meta/turn_context/
// event_msg/message SHAPES are REAL (captured on this machine, CLI 0.148/0.149,
// see docs/superpowers/research/2026-09-20-codex-format.md §7). Tool-call
// records are SYNTHETIC per the same doc's codex-rs source-verified shapes
// (§5): the local corpus (5 short `codex exec` runs, 4 dead on provider
// errors) contains ZERO tool-call records.
//
// Envelope (codex-rs history/src/lib.rs RolloutLine): every line is
//   {"timestamp":"<RFC3339 UTC>","ordinal":N,"type":"<item-type>","payload":{...}}
// with ordinal 0..n strictly incrementing. buildRollout assigns them.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonl } from "./helpers.js";

export const CODEX_SESSION = "01a0ae76-2436-7590-9a11-216f21269bb4";
// Different uuid for the filename-fallback test (no session_meta in file).
export const CODEX_FALLBACK_SESSION = "01a0b2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5";
export const CODEX_CWD = "D:\\demo\\codex-proj";
export const CODEX_TS = "2026-09-20T08:00:00.000Z";

// One rollout item pre-envelope: `ts` overrides the envelope timestamp.
export interface RolloutItem {
  type: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export function codexEnvelope(item: RolloutItem, ordinal: number): Record<string, unknown> {
  return { timestamp: item.ts ?? CODEX_TS, ordinal, type: item.type, payload: item.payload };
}

export function buildRollout(items: RolloutItem[]): Record<string, unknown>[] {
  return items.map((it, i) => codexEnvelope(it, i));
}

// session_meta (first line of every real file; base_instructions omitted —
// the parser must not need it). `id` mirrors session_id for root threads.
export function codexSessionMeta(
  opts: { sessionId?: string; id?: string; cwd?: string } = {},
): RolloutItem {
  const sid = opts.sessionId ?? CODEX_SESSION;
  return {
    type: "session_meta",
    payload: {
      session_id: sid,
      id: opts.id ?? sid,
      timestamp: CODEX_TS,
      cwd: opts.cwd ?? CODEX_CWD,
      originator: "codex_exec",
      cli_version: "0.149.1",
      source: "exec",
      thread_source: "user",
      model_provider: "custom",
      history_mode: "paginated",
    },
  };
}

// turn_context (real shape §7, fields the parser consumes + realistic filler).
export function codexTurnContext(cwd: string = CODEX_CWD): RolloutItem {
  return {
    type: "turn_context",
    payload: {
      turn_id: "01a0ae76-249c-7d50-8741-f6c69ea4ef30",
      cwd,
      workspace_roots: [cwd],
      current_date: "2026-09-20",
      timezone: "Asia/Shanghai",
      approval_policy: "never",
      sandbox_policy: { type: "read-only" },
      model: "glm-5.3",
    },
  };
}

// response_item / function_call — `arguments` is a JSON-ENCODED STRING on the
// wire (double decode); an object arg is stringified here, a string arg is
// taken verbatim (for corrupt-args tests). namespace = MCP server (newer CLIs).
export function codexFunctionCall(
  name: string,
  args: Record<string, unknown> | string,
  opts: { namespace?: string; callId?: string } = {},
): RolloutItem {
  const payload: Record<string, unknown> = {
    type: "function_call",
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
    call_id: opts.callId ?? "call_0001",
  };
  if (opts.namespace) {
    payload.namespace = opts.namespace;
  }
  return { type: "response_item", payload };
}

// response_item / local_shell_call — command is a PARSED ARRAY here.
export function codexLocalShellCall(action: Record<string, unknown>): RolloutItem {
  return {
    type: "response_item",
    payload: { type: "local_shell_call", call_id: "call_0002", status: "completed", action },
  };
}

// response_item / custom_tool_call — apply_patch carries the raw V4A patch
// TEXT (not JSON) in `input`.
export function codexCustomToolCall(input: string, name = "apply_patch"): RolloutItem {
  return {
    type: "response_item",
    payload: { type: "custom_tool_call", name, input, call_id: "call_0003" },
  };
}

// response_item / web_search_call — action types: search (query) /
// open_page (url) / find_in_page (url + pattern), snake_case tags.
export function codexWebSearch(action: Record<string, unknown>): RolloutItem {
  return {
    type: "response_item",
    payload: { type: "web_search_call", status: "completed", action },
  };
}

// event_msg — the UI channel. Deliberately does NOT persist tool activity
// (rollout/src/policy.rs); item_completed items are PascalCase on the wire.
export function codexEventMsg(payload: Record<string, unknown>): RolloutItem {
  return { type: "event_msg", payload };
}

// Real nested layout: sessions/<YYYY>/<MM>/<DD>/rollout-<compact-ts>-<uuid>.jsonl
export function rolloutPath(
  root: string,
  fileName = `rollout-2026-09-20T08-00-00-${CODEX_SESSION}.jsonl`,
  rel = join("2026", "09", "20"),
): string {
  const p = join(root, rel, fileName);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

export function writeRollout(path: string, items: RolloutItem[]): string {
  return writeJsonl(path, buildRollout(items));
}
