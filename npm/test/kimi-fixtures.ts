// Kimi-Code wire.jsonl fixtures, built from REAL records captured on this
// machine (2026-09-20 research spike, protocol_version 1.5).
// Sanitized: uuids/toolCallIds regenerated, real user paths/prompts replaced
// with demo values, long contents truncated. Record SHAPES are faithful:
// every record has `type`, loop-event wrappers carry epoch-ms `time` on the
// OUTER record, and wire.jsonl itself carries NO sessionId/workDir (those live
// in the sibling state.json / session_index.jsonl).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonl } from "./helpers.js";

export const KIMI_SESSION = "session_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
export const KIMI_WORKDIR = "D:\\demo\\kimi-proj";
export const KIMI_TS = 1789711026327; // epoch ms, as observed on the wire

// Real metadata shape: {"type":"metadata","protocol_version":"1.5","created_at":<ms>}
// (no sessionId/workDir on the wire today; the parser also accepts them for
// forward compatibility).
export function kimiMetadata(protocolVersion = "1.5"): Record<string, unknown> {
  return { type: "metadata", protocol_version: protocolVersion, created_at: 1789711026000 };
}

// {"type":"context.append_loop_event","agentId":"main","event":{...},"time":<ms>}
export function kimiLoop(
  event: Record<string, unknown>,
  time: unknown = KIMI_TS,
): Record<string, unknown> {
  return { type: "context.append_loop_event", agentId: "main", event, time };
}

// {"type":"tool.call","uuid":...,"turnId":"0","step":1,"stepUuid":...,
//  "toolCallId":"tool_...","name":"Bash","args":{"command":"..."}}
export function kimiToolCall(
  name: string,
  args: Record<string, unknown>,
  time: unknown = KIMI_TS,
): Record<string, unknown> {
  return kimiLoop({
    type: "tool.call",
    uuid: "6cd40000-0000-4000-8000-000000000001",
    turnId: "0",
    step: 1,
    stepUuid: "90360000-0000-4000-8000-000000000002",
    toolCallId: "tool_wy4TnCXbnQC71q6SH6k7IArR",
    name,
    args,
  }, time);
}

export function kimiToolResult(
  output = "ok",
  isError = false,
  time: number = KIMI_TS + 299,
): Record<string, unknown> {
  return kimiLoop({
    type: "tool.result",
    parentUuid: "6cd40000-0000-4000-8000-000000000001",
    toolCallId: "tool_wy4TnCXbnQC71q6SH6k7IArR",
    result: { output, isError },
  }, time);
}

export interface KimiSessionOpts {
  sessionId?: string;
  wdName?: string;
  agentDir?: string;
  cwd?: string;
  state?: boolean;
}

export function kimiWirePath(
  root: string,
  sessionId = KIMI_SESSION,
  wdName = "wd_demo_abc123",
  agentDir = "main",
): string {
  return join(root, wdName, sessionId, "agents", agentDir, "wire.jsonl");
}

// Writes <root>/<wd_*>/<session_*>/agents/main/wire.jsonl plus the sibling
// state.json ({"id","version":2,"cwd",...}) exactly as Kimi lays it out.
export function writeKimiSession(
  root: string,
  records: unknown[],
  opts: KimiSessionOpts = {},
): string {
  const sessionId = opts.sessionId ?? KIMI_SESSION;
  const wdName = opts.wdName ?? "wd_demo_abc123";
  const wire = kimiWirePath(root, sessionId, wdName, opts.agentDir ?? "main");
  mkdirSync(dirname(wire), { recursive: true });
  writeJsonl(wire, records);
  if (opts.state !== false) {
    // real layout: state.json sits in the session dir, next to agents/
    const sessionDir = join(root, wdName, sessionId);
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({
        id: sessionId,
        version: 2,
        cwd: opts.cwd ?? KIMI_WORKDIR,
        createdAt: "2026-09-19T10:00:00.000Z",
        updatedAt: "2026-09-19T10:30:00.000Z",
        archived: false,
        agents: { main: { homedir: sessionDir, type: "main" } },
        lastTurnReason: "completed",
      }),
      "utf8",
    );
  }
  return wire;
}
