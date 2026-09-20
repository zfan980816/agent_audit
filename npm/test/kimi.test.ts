// Kimi-Code wire.jsonl parser tests (M1). Fixtures are sanitized REAL records
// (see kimi-fixtures.ts); semantics mirror parsers/claude-code.ts (stats
// ordering, ENOENT rejection, ISO-shape timestamp guard).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { FileWrite, McpToolCall, NetworkRequest, ShellCommand } from "../src/events.js";
import { ParseStats } from "../src/parsers/claude-code.js";
import { iterEvents } from "../src/parsers/kimi.js";
import { makeTmpDir, writeJsonl } from "./helpers.js";
import {
  KIMI_SESSION,
  KIMI_TS,
  KIMI_WORKDIR,
  kimiLoop,
  kimiMetadata,
  kimiToolCall,
  kimiToolResult,
  writeKimiSession,
} from "./kimi-fixtures.js";

async function collect(path: string): Promise<{ events: import("../src/events.js").Event[]; stats: ParseStats }> {
  const stats = new ParseStats();
  const events: import("../src/events.js").Event[] = [];
  for await (const ev of iterEvents(path, stats)) {
    events.push(ev);
  }
  return { events, stats };
}

test("bash tool.call becomes ShellCommand with state.json session/workDir", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    { type: "profile.bind", agentId: "main", modelAlias: "kimi-code/k3", systemPrompt: "You are Kimi Code CLI...", time: 1 },
    { type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "summarize this repo" }], turnId: "0", time: 2 },
    kimiToolCall("Bash", { command: "git status --short && git log --oneline -5" }),
    kimiToolResult("?? src/\nfatal: exit 128", false),
  ]);
  const { events, stats } = await collect(wire);
  // tool.result / profile.bind / turn.prompt never emit
  expect(events).toHaveLength(1);
  const ev = events[0] as ShellCommand;
  expect(ev).toBeInstanceOf(ShellCommand);
  expect(ev.raw).toBe("git status --short && git log --oneline -5");
  // wire.jsonl carries no identity: session/workDir come from sibling state.json
  expect(ev.sessionId).toBe(KIMI_SESSION);
  expect(ev.project).toBe(KIMI_WORKDIR);
  expect(ev.cwd).toBe(KIMI_WORKDIR);
  // outer-record `time` is epoch ms
  expect(ev.timestamp?.getTime()).toBe(KIMI_TS);
  expect(stats.events).toBe(1);
  expect(stats.linesSkipped).toBe(0);
});

test("kimi rm -rf fires D001 through the full pipeline (runAudit + rules)", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "rm -rf D:/demo/kimi-proj/build" }),
  ]);
  const { runAudit } = await import("../src/engine.js");
  // tagged entry — plain strings intentionally route to the claude-code parser
  const result = await runAudit([{ agent: "kimi", path: wire }]);
  expect(result.findings.map((f) => f.ruleId)).toContain("D001");
  expect(result.events).toBe(1);
  expect(result.sessions.has(KIMI_SESSION)).toBe(true);
});

test("read tool.call becomes FileWrite with config gate", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Read", { path: "package.json" }),
    kimiToolCall("Read", { path: "C:/Users/demo/.bashrc" }),
  ]);
  const { events } = await collect(wire);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e instanceof FileWrite)).toBe(true);
  const [pkg, rc] = events as [FileWrite, FileWrite];
  expect(pkg.path).toBe("package.json");
  expect(pkg.isConfig).toBe(false);
  expect(pkg.content).toBeNull(); // Read carries no content
  expect(rc.path).toBe("C:/Users/demo/.bashrc");
  expect(rc.isConfig).toBe(true);
});

test("write/edit variants become FileWrite with content", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Write", { file_path: "/x/main.py", content: "print(1)" }),
    kimiToolCall("Edit", { file_path: "/x/main.py", old_string: "a", new_string: "b" }),
    kimiToolCall("Write", { path: "/x/kimi-style.txt", content: "kimi" }),
  ]);
  const { events } = await collect(wire);
  expect(events).toHaveLength(3);
  expect(events.every((e) => e instanceof FileWrite)).toBe(true);
  const [w, e, k] = events as [FileWrite, FileWrite, FileWrite];
  expect(w.path).toBe("/x/main.py");
  expect(w.content).toBe("print(1)");
  expect(e.content).toBe("b");
  expect(k.path).toBe("/x/kimi-style.txt");
  expect(k.content).toBe("kimi");
});

test("fetchurl becomes NetworkRequest", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("FetchURL", { url: "https://example.com/docs" }),
    kimiToolCall("WebFetch", { url: "https://example.com/other" }),
  ]);
  const { events } = await collect(wire);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e instanceof NetworkRequest)).toBe(true);
  expect((events[0] as NetworkRequest).url).toBe("https://example.com/docs");
});

test("grep/glob/skill/tool.result and chatty records are skipped, not counted", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Grep", { pattern: "mcp", path: "README.md", output_mode: "content", "-i": true, "-C": 3 }),
    kimiToolCall("Glob", { pattern: "**/mcp*.json" }),
    kimiToolCall("Skill", { skill: "check-docs", args: "mcp.json fields" }),
    kimiToolResult("some output"),
    { type: "context.append_message", agentId: "main", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, time: 3 },
    { type: "agent.turn.started", agentId: "main", kind: "normal", turnId: "0", time: 4 },
    { type: "usage.record", agentId: "main", model: "k3", usage: {}, time: 5 },
  ]);
  const { events, stats } = await collect(wire);
  expect(events).toEqual([]);
  expect(stats.linesSkipped).toBe(0);
});

test("mcp-namespaced tool calls map to McpToolCall (claude-code parity)", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("mcp__github__create_issue", { title: "t" }),
  ]);
  const { events } = await collect(wire);
  expect(events).toHaveLength(1);
  const mcp = events[0] as McpToolCall;
  expect(mcp).toBeInstanceOf(McpToolCall);
  expect(mcp.server).toBe("github");
  expect(mcp.tool).toBe("create_issue");
});

test("corrupt lines counted with claude-code ordering (blanks never counted)", async () => {
  const root = makeTmpDir();
  const p = join(root, "wire.jsonl");
  writeFileSync(p, '{"type":"metadata"}\n\nnot-json\n{"type":"turn.prompt"}\n', "utf8");
  const stats = new ParseStats();
  const events: import("../src/events.js").Event[] = [];
  for await (const ev of iterEvents(p, stats)) {
    events.push(ev);
  }
  expect(events).toEqual([]);
  expect(stats.linesTotal).toBe(3); // blank line not counted
  expect(stats.linesSkipped).toBe(1); // only the un-parseable line
});

test("metadata sessionId/workDir beat state.json (forward compatibility)", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    { type: "metadata", protocol_version: "1.6", created_at: 1, sessionId: "session_from-metadata", workDir: "D:/meta/dir" },
    kimiToolCall("Bash", { command: "ls" }),
  ], { cwd: "D:/state/dir" });
  const { events } = await collect(wire);
  expect(events[0]?.sessionId).toBe("session_from-metadata");
  expect(events[0]?.project).toBe("D:/meta/dir");
});

test("missing state.json falls back to path-derived session/workDir", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "ls" }),
  ], { state: false, sessionId: "session_fallback-1111", wdName: "wd_demo_fedcba" });
  const { events } = await collect(wire);
  expect(events[0]?.sessionId).toBe("session_fallback-1111");
  expect(events[0]?.project).toBe("wd_demo_fedcba");
});

test("wire.jsonl outside the kimi layout falls back to stem/parent dir", async () => {
  const root = makeTmpDir();
  const p = join(root, "plain", "wire.jsonl");
  mkdirSync(join(root, "plain"), { recursive: true });
  writeJsonl(p, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "ls" }),
  ]);
  const { events } = await collect(p);
  expect(events[0]?.sessionId).toBe("wire"); // file stem, like claude-code
  expect(events[0]?.project).toBe("plain"); // parent dir name
});

test("missing file rejects with fs error (ENOENT)", async () => {
  const root = makeTmpDir();
  let caught: NodeJS.ErrnoException | null = null;
  try {
    await collect(join(root, "missing", "wire.jsonl"));
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe("ENOENT");
});

test("time field: epoch ms number, ISO string accepted, garbage rejected, absent -> null", async () => {
  const root = makeTmpDir();
  const wire = writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "echo a" }, KIMI_TS),
    kimiToolCall("Bash", { command: "echo b" }, "2026-09-19T10:00:00.000Z"),
    kimiToolCall("Bash", { command: "echo c" }, "Sep 19 2026"),
    kimiLoop({ type: "tool.call", uuid: "u", turnId: "0", step: 1, stepUuid: "s", toolCallId: "t", name: "Bash", args: { command: "echo d" } }, undefined),
  ]);
  // hand-fix the record that must carry NO time field (default param ate undefined)
  writeJsonl(wire, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "echo a" }, KIMI_TS),
    kimiToolCall("Bash", { command: "echo b" }, "2026-09-19T10:00:00.000Z"),
    kimiToolCall("Bash", { command: "echo c" }, "Sep 19 2026"),
    { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", uuid: "u", turnId: "0", step: 1, stepUuid: "s", toolCallId: "t", name: "Bash", args: { command: "echo d" } } },
  ]);
  const { events } = await collect(wire);
  expect(events).toHaveLength(4);
  expect(events[0]?.timestamp?.getTime()).toBe(KIMI_TS);
  expect(events[1]?.timestamp?.getTime()).toBe(new Date("2026-09-19T10:00:00.000Z").getTime());
  expect(events[2]?.timestamp).toBeNull();
  expect(events[3]?.timestamp).toBeNull();
});
