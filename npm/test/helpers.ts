// Ported 1:1 from tests/conftest.py (Python implementation is the spec).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileWrite,
  NetworkRequest,
  ShellCommand,
  isConfigPath,
} from "../src/events.js";

export const DEFAULT_SESSION = "11111111-2222-3333-4444-555555555555";

interface ToolLineOpts {
  session?: string;
  cwd?: string;
  ts?: string;
}

export function makeToolLine(
  name: string,
  toolInput: Record<string, unknown>,
  { session = DEFAULT_SESSION, cwd = "D:\\demo", ts = "2026-09-19T10:00:00.000Z" }: ToolLineOpts = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    sessionId: session,
    timestamp: ts,
    cwd,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name, input: toolInput }],
    },
  };
}

export function makeUserLine(text = "hi"): Record<string, unknown> {
  return {
    type: "user",
    sessionId: "s-x",
    timestamp: "2026-09-19T10:00:01.000Z",
    cwd: "D:\\demo",
    message: { role: "user", content: text },
  };
}

export function writeJsonl(path: string, records: unknown[]): string {
  // utf-8, LF newlines, trailing newline (same bytes as the Python helper).
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

interface EventOpts {
  session?: string;
  project?: string;
}

export function shell(
  cmd: string,
  { session = DEFAULT_SESSION, project = "demo" }: EventOpts = {},
): ShellCommand {
  return new ShellCommand(session, project, null, cmd, project);
}

export function fwrite(
  pathStr: string,
  content: string | null = null,
  { session = DEFAULT_SESSION, project = "demo" }: EventOpts = {},
): FileWrite {
  return new FileWrite(session, project, null, pathStr, isConfigPath(pathStr), content);
}

export function netreq(
  url: string,
  { session = DEFAULT_SESSION, project = "demo" }: EventOpts = {},
): NetworkRequest {
  return new NetworkRequest(session, project, null, url);
}

// pytest tmp_path equivalent: a unique temp directory per call.
export function makeTmpDir(prefix = "agentaudit-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
