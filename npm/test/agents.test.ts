// Agent registry tests (M1). Discovery semantics: claude-code throws on a
// missing root (back-compat), kimi silently returns [] (optional agent).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { AGENTS, findAgentFiles } from "../src/agents.js";
import { DataDirNotFoundError } from "../src/discovery.js";
import { ParseStats } from "../src/parsers/claude-code.js";
import { makeTmpDir, writeJsonl } from "./helpers.js";
import { KIMI_SESSION, kimiMetadata, kimiToolCall, writeKimiSession } from "./kimi-fixtures.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("registry exposes claude-code and kimi with parsers", () => {
  expect(Object.keys(AGENTS).sort()).toEqual(["claude-code", "kimi"]);
  expect(AGENTS["claude-code"].displayName).toBeTruthy();
  expect(AGENTS["kimi"].displayName).toBeTruthy();
  expect(typeof AGENTS["claude-code"].parser.iterEvents).toBe("function");
  expect(typeof AGENTS["kimi"].parser.iterEvents).toBe("function");
});

test("kimi find walks wd_*/session_*/agents/main/wire.jsonl under a root", () => {
  const tmp = makeTmpDir();
  const w1 = writeKimiSession(tmp, [kimiMetadata()], { sessionId: "session_aaaa", wdName: "wd_one_111111" });
  const w2 = writeKimiSession(tmp, [kimiMetadata()], { sessionId: "session_bbbb", wdName: "wd_two_222222" });
  // decoys that must NOT be discovered
  const worker = join(tmp, "wd_one_111111", "session_aaaa", "agents", "worker", "wire.jsonl");
  mkdirSync(join(tmp, "wd_one_111111", "session_aaaa", "agents", "worker"), { recursive: true });
  writeFileSync(worker, "{}", "utf8");
  writeJsonl(join(tmp, "wd_one_111111", "session_aaaa", "state.json"), [{ not: "jsonl" }]);
  mkdirSync(join(tmp, "not-a-wd"), { recursive: true });
  writeJsonl(join(tmp, "not-a-wd", "wire.jsonl"), [{ nope: true }]);

  const files = AGENTS["kimi"].find(tmp);
  expect(files).toEqual([w1, w2].sort((a, b) => (a < b ? -1 : 1)));
});

test("kimi find missing root returns empty (silent skip)", () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  expect(AGENTS["kimi"].find(join(home, "nope"))).toEqual([]);
  expect(AGENTS["kimi"].find()).toEqual([]); // no ~/.kimi-code/sessions in stubbed HOME
});

test("kimi parser descriptor routes wire.jsonl to kimi events", async () => {
  const tmp = makeTmpDir();
  const wire = writeKimiSession(tmp, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "ls -la" }),
  ]);
  const stats = new ParseStats();
  const events = [];
  for await (const ev of AGENTS["kimi"].parser.iterEvents(wire, stats)) {
    events.push(ev);
  }
  expect(events).toHaveLength(1);
  expect(events[0]?.sessionId).toBe(KIMI_SESSION);
  expect(stats.events).toBe(1);
});

test("findAgentFiles tags files per agent over stubbed default roots", () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeJsonl(join(home, ".claude", "projects", "p", "a.jsonl"), [{ type: "assistant" }]);
  const wire = writeKimiSession(join(home, ".kimi-code", "sessions"), [kimiMetadata()], {
    wdName: "wd_x_abcdef123",
  });

  const both = findAgentFiles(["claude-code", "kimi"]);
  expect(both.map((e) => e.agent).sort()).toEqual(["claude-code", "kimi"]);
  expect(both.find((e) => e.agent === "kimi")?.path).toBe(wire);
  expect(both.find((e) => e.agent === "claude-code")?.path).toContain("a.jsonl");
});

test("claude-code missing default root still throws (back-compat), kimi does not", () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  expect(() => findAgentFiles(["claude-code"])).toThrow(DataDirNotFoundError);
  expect(findAgentFiles(["kimi"])).toEqual([]);
});

test("unknown agent id throws", () => {
  expect(() => findAgentFiles(["nope"])).toThrow(/unknown agent/i);
});

test("runAudit routes entries through per-agent parsers and tracks by_agent", async () => {
  const tmp = makeTmpDir();
  const wire = writeKimiSession(tmp, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "rm -rf /tmp/x" }),
  ]);
  const claude = writeJsonl(join(tmp, "claude.jsonl"), [
    {
      type: "assistant",
      sessionId: "c-1",
      timestamp: "2026-09-19T10:00:00.000Z",
      cwd: "D:\\demo",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    },
  ]);
  const { runAudit } = await import("../src/engine.js");
  const result = await runAudit([
    { agent: "kimi", path: wire },
    { agent: "claude-code", path: claude },
  ]);
  expect(result.filesScanned).toBe(2);
  expect(result.byAgent).toEqual({ kimi: 1, "claude-code": 1 });
  expect(result.findings.map((f) => f.ruleId)).toEqual(["D001"]);
  expect(result.findings[0]?.event.sessionId).toBe(KIMI_SESSION);
});

test("runAudit by_agent counts attempted files incl. unreadable ones", async () => {
  const tmp = makeTmpDir();
  const wire = writeKimiSession(tmp, [kimiMetadata()]);
  const { runAudit } = await import("../src/engine.js");
  const result = await runAudit([
    { agent: "kimi", path: wire },
    { agent: "kimi", path: join(tmp, "missing.jsonl") },
  ]);
  expect(result.byAgent).toEqual({ kimi: 2 });
  expect(result.filesFailed).toBe(1);
});

test("runAudit rejects unknown agent tags", async () => {
  const { runAudit } = await import("../src/engine.js");
  await expect(runAudit([{ agent: "nope", path: "x.jsonl" }])).rejects.toThrow(/unknown agent/i);
});
