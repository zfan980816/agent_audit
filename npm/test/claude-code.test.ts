// Ported 1:1 from tests/test_parser_claude_code.py (Python implementation is the spec).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { Event, FileWrite, McpToolCall, NetworkRequest, ShellCommand } from "../src/events.js";
import { ParseStats, iterEvents } from "../src/parsers/claude-code.js";
import { makeTmpDir, makeToolLine, makeUserLine, writeJsonl } from "./helpers.js";

async function collect(path: string): Promise<{ events: Event[]; stats: ParseStats }> {
  const stats = new ParseStats();
  const events: Event[] = [];
  for await (const ev of iterEvents(path, stats)) {
    events.push(ev);
  }
  return { events, stats };
}

// from test_bash_becomes_shell_command
test("bash becomes ShellCommand", async () => {
  const dir = makeTmpDir();
  const f = writeJsonl(
    join(dir, "a.jsonl"),
    [makeToolLine("Bash", { command: "ls -la", description: "list" })],
  );
  const { events, stats } = await collect(f);
  expect(events).toHaveLength(1);
  const ev = events[0] as ShellCommand;
  expect(ev).toBeInstanceOf(ShellCommand);
  expect(ev.raw).toBe("ls -la");
  expect(ev.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(ev.project).toBe("D:\\demo");
  expect(stats.events).toBe(1);
  expect(stats.linesSkipped).toBe(0);
});

// from test_write_edit_notebook_become_file_write
test("write/edit/notebook become FileWrite", async () => {
  const dir = makeTmpDir();
  const f = writeJsonl(join(dir, "a.jsonl"), [
    makeToolLine("Write", { file_path: "/x/.bashrc", content: "evil" }),
    makeToolLine("Edit", { file_path: "/x/main.py", old_string: "a", new_string: "b" }),
    makeToolLine("NotebookEdit", { notebook_path: "/x/n.ipynb" }),
  ]);
  const { events } = await collect(f);
  expect(events).toHaveLength(3);
  expect(events.every((ev) => ev instanceof FileWrite)).toBe(true);
  const [w, e, n] = events as [FileWrite, FileWrite, FileWrite];
  expect(w.isConfig).toBe(true);
  expect(w.content).toBe("evil");
  expect(e.isConfig).toBe(false);
  expect(e.content).toBe("b");
  expect(n.path).toBe("/x/n.ipynb");
  expect(n.content).toBeNull();
});

// from test_network_and_mcp_events
test("network and mcp events", async () => {
  const dir = makeTmpDir();
  const f = writeJsonl(join(dir, "a.jsonl"), [
    makeToolLine("WebFetch", { url: "https://x.com/a" }),
    makeToolLine("WebSearch", { query: "hello" }),
    makeToolLine("mcp__github__create_issue", { title: "t" }),
  ]);
  const { events } = await collect(f);
  expect(events[0]).toBeInstanceOf(NetworkRequest);
  expect((events[0] as NetworkRequest).url).toBe("https://x.com/a");
  expect(events[1]).toBeInstanceOf(NetworkRequest);
  expect((events[1] as NetworkRequest).url).toBe("hello");
  const mcp = events[2] as McpToolCall;
  expect(mcp).toBeInstanceOf(McpToolCall);
  expect(mcp.server).toBe("github");
  expect(mcp.tool).toBe("create_issue");
});

// from test_corrupt_line_skipped_and_counted
test("corrupt line skipped and counted", async () => {
  const dir = makeTmpDir();
  const p = join(dir, "a.jsonl");
  writeFileSync(p, '{"type":"assistant"}\nnot-json\n', "utf8");
  const stats = new ParseStats();
  const events: Event[] = [];
  for await (const ev of iterEvents(p, stats)) {
    events.push(ev);
  }
  expect(events).toEqual([]);
  expect(stats.linesTotal).toBe(2);
  expect(stats.linesSkipped).toBe(1);
});

// from test_user_and_non_tool_lines_ignored
test("user and non-tool lines ignored", async () => {
  const dir = makeTmpDir();
  const f = writeJsonl(join(dir, "a.jsonl"), [
    makeUserLine(),
    { type: "summary", summary: "s" },
  ]);
  const { events } = await collect(f);
  expect(events).toEqual([]);
});

// from test_fallback_project_and_session
test("fallback project and session", async () => {
  // no cwd/sessionId on the record -> parent dir name / file stem
  const dir = makeTmpDir();
  const p = join(dir, "D--my-proj", "abc123.jsonl");
  mkdirSync(join(dir, "D--my-proj"));
  const rec = {
    type: "assistant",
    timestamp: "2026-09-19T10:00:00.000Z",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
    },
  };
  writeJsonl(p, [rec]);
  const { events } = await collect(p);
  expect(events[0]?.project).toBe("D--my-proj");
  expect(events[0]?.sessionId).toBe("abc123");
});

// TS port addition (port-plan T2 decision): Python's open() raising propagates
// and the engine catches OSError per file (files_failed); the async generator
// must REJECT the same way so the T5 engine can catch per file.
test("missing file rejects with fs error", async () => {
  const dir = makeTmpDir();
  let caught: NodeJS.ErrnoException | null = null;
  try {
    await collect(join(dir, "missing.jsonl"));
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe("ENOENT");
});
