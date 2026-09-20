// CLI multi-agent flags (M1): --agent / --list-agents. TS-only addition (the
// Python CLI is frozen at v0.1.1); follows cli.test.ts's injected-writer
// pattern — main() called directly, no subprocess.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { main } from "../src/cli.js";
import { makeTmpDir, writeJsonl } from "./helpers.js";
import { kimiMetadata, kimiToolCall, writeKimiSession } from "./kimi-fixtures.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Captured {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  out: () => string;
  err: () => string;
}

function capture(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    stdout: (chunk) => {
      outChunks.push(chunk);
    },
    stderr: (chunk) => {
      errChunks.push(chunk);
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

function buildMixedTree(): string {
  const root = makeTmpDir();
  // kimi session with one dangerous Bash call
  writeKimiSession(root, [
    kimiMetadata(),
    kimiToolCall("Bash", { command: "rm -rf D:/demo/kimi-proj/build" }),
  ], { sessionId: "session_kimi-0001", wdName: "wd_mixed_aaa111" });
  // claude session with one safe call
  writeJsonl(join(root, "claude-sess.jsonl"), [
    {
      type: "assistant",
      sessionId: "c-mixed-1",
      timestamp: "2026-09-19T10:00:00.000Z",
      cwd: "D:\\demo",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    },
  ]);
  return root;
}

test("--agent kimi audits only kimi files via the full pipeline", async () => {
  const root = buildMixedTree();
  const io = capture();
  const code = await main(["--agent", "kimi", root, "--json"], io);
  expect(code).toBe(0);
  const data = JSON.parse(io.out());
  expect(data.summary.by_agent).toEqual({ kimi: 1 });
  expect(data.summary.files).toBe(1);
  expect(data.findings.map((f: { rule_id: string }) => f.rule_id)).toContain("D001");
});

test("--agent claude-code routes every discovered file through the claude parser", async () => {
  const root = buildMixedTree();
  const io = capture();
  const code = await main(["--agent", "claude-code", root, "--json"], io);
  expect(code).toBe(0);
  const data = JSON.parse(io.out());
  // claude discovery is rglob("*.jsonl"), so under a SHARED explicit root it
  // also counts the kimi wire.jsonl (disjoint on real default roots) — but
  // the claude parser extracts no events from kimi records, nothing leaks.
  expect(data.summary.by_agent).toEqual({ "claude-code": 2 });
  expect(data.findings).toEqual([]); // the kimi rm -rf must NOT leak in
});

test("default --agent all covers every registered agent", async () => {
  const root = buildMixedTree();
  const io = capture();
  const code = await main([root, "--json"], io);
  expect(code).toBe(0);
  const data = JSON.parse(io.out());
  expect(data.summary.by_agent).toEqual({ "claude-code": 2, kimi: 1 });
  expect(io.err()).toContain(`scanning 3 session file(s)`);
});

test("unknown agent id exits 2 naming the known agents", async () => {
  const io = capture();
  const code = await main(["--agent", "nope", makeTmpDir(), "--json"], io);
  expect(code).toBe(2);
  expect(io.err()).toContain("claude-code");
  expect(io.err()).toContain("kimi");
});

test("--list-agents prints ids, display names and default-root counts", async () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeJsonl(join(home, ".claude", "projects", "p", "a.jsonl"), [{ type: "assistant" }]);
  writeKimiSession(join(home, ".kimi-code", "sessions"), [kimiMetadata()], {
    wdName: "wd_list_bb2222",
  });

  const io = capture();
  const code = await main(["--list-agents"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("claude-code");
  expect(io.out()).toContain("kimi");
  expect(io.out()).toContain("1"); // both roots hold exactly one file
});

test("--list-agents tolerates missing agent roots", async () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const io = capture();
  const code = await main(["--list-agents"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("claude-code");
  expect(io.out()).toContain("kimi");
});
