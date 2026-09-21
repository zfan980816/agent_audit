// ZCode adapter tests (M4): parser over synthetic sqlite stores (the live db
// on this machine has the full schema but ZERO data rows), discovery + the
// node:sqlite availability gate, and full-pipeline/CLI routing. WAL-copy
// semantics are exercised with a live second connection holding committed rows
// in the -wal file. Ground truth: docs/superpowers/research/
// 2026-09-20-zcode-forensics.md + live PRAGMA table_info (2026-09-20).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  AGENTS,
  defaultZcodeDbPath,
} from "../src/agents.js";
import { FileWrite, McpToolCall, NetworkRequest, ShellCommand } from "../src/events.js";
import { ParseStats } from "../src/parsers/claude-code.js";
import {
  defaultSqliteLoader,
  iterEvents,
  loadNodeSqlite,
  setSqliteLoaderForTests,
} from "../src/parsers/zcode.js";
import { makeTmpDir } from "./helpers.js";
import {
  ZCODE_DIR,
  ZCODE_SESSION,
  ZCODE_TS,
  createZcodeDb,
  insertSession,
  insertToolPart,
  insertToolUsage,
  openZcodeDb,
  writeZcodeDb,
} from "./zcode-fixtures.js";

const HAS_SQLITE = loadNodeSqlite() !== null;
const t = HAS_SQLITE ? test : test.skip;

async function collect(path: string): Promise<{
  events: import("../src/events.js").Event[];
  stats: ParseStats;
}> {
  const stats = new ParseStats();
  const events: import("../src/events.js").Event[] = [];
  for await (const ev of iterEvents(path, stats)) {
    events.push(ev);
  }
  return { events, stats };
}

afterEach(() => {
  setSqliteLoaderForTests(defaultSqliteLoader);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// --- tool mappings ----------------------------------------------------------

t("bash tool_usage joined to its part becomes ShellCommand with session identity", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "c1", tool: "bash", input: { command: "ls -la" } }],
    usages: [{ callId: "c1", toolName: "bash" }],
  });
  const { events, stats } = await collect(p);
  expect(events).toHaveLength(1);
  const ev = events[0] as ShellCommand;
  expect(ev).toBeInstanceOf(ShellCommand);
  expect(ev.raw).toBe("ls -la");
  expect(ev.cwd).toBe(ZCODE_DIR); // session.directory
  expect(ev.sessionId).toBe(ZCODE_SESSION);
  expect(ev.project).toBe(ZCODE_DIR);
  expect(ev.timestamp?.toISOString()).toBe(new Date(ZCODE_TS).toISOString());
  expect(stats.events).toBe(1);
  expect(stats.linesTotal).toBe(1);
  expect(stats.linesSkipped).toBe(0);
});

t("rm -rf in a bash call fires D001 through the full pipeline (runAudit, by_agent)", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "c1", tool: "bash", input: { command: "rm -rf D:/demo/zcode-proj/build" } }],
    usages: [{ callId: "c1", toolName: "bash" }],
  });
  const { runAudit } = await import("../src/engine.js");
  const result = await runAudit([{ agent: "zcode", path: p }]);
  expect(result.findings.map((f) => f.ruleId)).toContain("D001");
  expect(result.findings[0]?.event.sessionId).toBe(ZCODE_SESSION);
  expect(result.byAgent).toEqual({ zcode: 1 });
  expect(result.events).toBe(1);
  expect(result.sessions.has(ZCODE_SESSION)).toBe(true);
});

t("write/edit/read-class tools become FileWrite (content only when carried)", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [
      { callId: "w1", tool: "write", input: { filePath: "D:\\demo\\out.py", content: "print(1)" } },
      { callId: "e1", tool: "str_replace_editor", input: { filePath: "D:\\demo\\a.ts", new_string: "const x = 1;" } },
      { callId: "r1", tool: "read", input: { filePath: "D:\\demo\\settings.json" } },
    ],
    usages: [
      { callId: "w1", toolName: "write" },
      { callId: "e1", toolName: "str_replace_editor" },
      { callId: "r1", toolName: "read" },
    ],
  });
  const { events, stats } = await collect(p);
  expect(events).toHaveLength(3);
  const [w, e, r] = events as [FileWrite, FileWrite, FileWrite];
  expect(w.path).toBe("D:\\demo\\out.py");
  expect(w.content).toBe("print(1)");
  expect(w.isConfig).toBe(false);
  expect(e.content).toBe("const x = 1;");
  // reads carry no content but stay auditable (kimi M1 precedent: config-path
  // READS gate the same D/C rules, and the event model has no FileRead)
  expect(r.path).toBe("D:\\demo\\settings.json");
  expect(r.content).toBeNull();
  expect(r.isConfig).toBe(true);
  expect(stats.linesSkipped).toBe(0);
});

t("web_fetch url and web_search query become NetworkRequest", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [
      { callId: "n1", tool: "web_fetch", input: { url: "https://example.com/docs" } },
      { callId: "n2", tool: "web_search", input: { query: "sqlite wal mode" } },
    ],
    usages: [
      { callId: "n1", toolName: "web_fetch" },
      { callId: "n2", toolName: "web_search" },
    ],
  });
  const { events } = await collect(p);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e instanceof NetworkRequest)).toBe(true);
  expect(events.map((e) => (e as NetworkRequest).url)).toEqual([
    "https://example.com/docs",
    "sqlite wal mode",
  ]);
});

t("mcp__server__tool names split into McpToolCall (kimi/codex convention)", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "m1", tool: "mcp__maps__geocode", input: { q: "paris" } }],
    usages: [{ callId: "m1", toolName: "mcp__maps__geocode" }],
  });
  const { events } = await collect(p);
  expect(events).toHaveLength(1);
  const ev = events[0] as McpToolCall;
  expect(ev.server).toBe("maps");
  expect(ev.tool).toBe("geocode");
  expect(ev.argsHint).toBe('{"q": "paris"}');
});

// --- skip / corrupt / stats semantics -----------------------------------------

t("benign tools (grep/glob/todowrite) are skipped SILENTLY, never counted", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    usages: [
      { callId: "g1", toolName: "grep" },
      { callId: "g2", toolName: "glob" },
      { callId: "g3", toolName: "todowrite" },
    ],
  });
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.linesTotal).toBe(3); // rows read...
  expect(stats.linesSkipped).toBe(0); // ...but benign skips are silent
  expect(stats.events).toBe(0);
});

t("auditable-class rows without a usable payload count as skipped (stats semantics)", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    // bash row WITH payload (event) + bash row with NO part at all + bash row
    // whose part.data is corrupt JSON: 3 rows read, 1 event, 2 skipped
    parts: [
      { callId: "ok", tool: "bash", input: { command: "echo hi" } },
      { callId: "bad", tool: "bash", input: { command: "echo corrupted" }, dataOverride: "not-json{" },
    ],
    usages: [
      { callId: "ok", toolName: "bash" },
      { callId: "nopart", toolName: "bash" },
      { callId: "bad", toolName: "bash" },
    ],
  });
  const { events, stats } = await collect(p);
  expect(events).toHaveLength(1);
  expect((events[0] as ShellCommand).raw).toBe("echo hi");
  expect(stats.linesTotal).toBe(3);
  expect(stats.linesSkipped).toBe(2);
  expect(stats.events).toBe(1);
});

t("tool_usage rows without a session_id are unmappable -> skipped", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    sessions: [{ id: ZCODE_SESSION, directory: ZCODE_DIR }],
    parts: [{ callId: "c1", tool: "bash", input: { command: "ls" }, sessionId: ZCODE_SESSION }],
    usages: [{ callId: "c1", toolName: "bash", sessionId: null }],
  });
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.linesTotal).toBe(1);
  expect(stats.linesSkipped).toBe(1);
});

t("empty db (schema only, like the live store today) yields zero events, no crash", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, { sessions: [], parts: [], usages: [] });
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.linesTotal).toBe(0);
  expect(stats.events).toBe(0);
});

// --- WAL copy semantics ---------------------------------------------------------

t("rows committed by a still-open second connection (WAL) are visible to the parser", async () => {
  const root = makeTmpDir();
  const p = join(root, "db.sqlite");
  // connection A creates the store and flips it to WAL mode
  const a = createZcodeDb(p);
  a.exec("PRAGMA journal_mode=WAL");
  insertSession(a, {});
  // connection B commits the tool rows but STAYS OPEN: the rows live in the
  // -wal file (a clean close would checkpoint and delete it)
  const b = openZcodeDb(p);
  b.exec("PRAGMA journal_mode=WAL");
  insertToolPart(b, { callId: "wal1", tool: "bash", input: { command: "echo from-wal" } });
  insertToolUsage(b, { callId: "wal1", toolName: "bash" });

  try {
    const { events, stats } = await collect(p); // parser copies db+wal, then reads
    expect(events).toHaveLength(1);
    expect((events[0] as ShellCommand).raw).toBe("echo from-wal");
    expect(stats.events).toBe(1);
  } finally {
    b.close();
    a.close();
  }
});

// --- identity / timestamps / ordering -------------------------------------------

t("input workdir beats session.directory for ShellCommand.cwd; project stays the session dir", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "c1", tool: "bash", input: { command: "make", workdir: "D:\\elsewhere" } }],
    usages: [{ callId: "c1", toolName: "bash" }],
  });
  const { events } = await collect(p);
  const ev = events[0] as ShellCommand;
  expect(ev.cwd).toBe("D:\\elsewhere");
  expect(ev.project).toBe(ZCODE_DIR);
});

t("multi-session stores keep sessionId/project per row", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    sessions: [
      { id: "ses_a", directory: "D:\\proj-a" },
      { id: "ses_b", directory: "D:\\proj-b" },
    ],
    parts: [
      { callId: "ca", tool: "bash", input: { command: "echo a" }, sessionId: "ses_a" },
      { callId: "cb", tool: "bash", input: { command: "echo b" }, sessionId: "ses_b" },
    ],
    usages: [
      { callId: "ca", toolName: "bash", sessionId: "ses_a" },
      { callId: "cb", toolName: "bash", sessionId: "ses_b" },
    ],
  });
  const { events } = await collect(p);
  expect(events.map((e) => [e.sessionId, e.project])).toEqual([
    ["ses_a", "D:\\proj-a"],
    ["ses_b", "D:\\proj-b"],
  ]);
});

t("timestamps: epoch-ms and epoch-seconds INTEGER both parse; NULL -> null", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    usages: [
      { callId: "ms", toolName: "grep", startedAt: ZCODE_TS },
      { callId: "sec", toolName: "grep", startedAt: Math.floor(ZCODE_TS / 1000) },
      { callId: "none", toolName: "grep", startedAt: null },
    ],
  });
  const { stats } = await collect(p); // benign tools: nothing emitted, just counted
  expect(stats.linesTotal).toBe(3);
  const p2 = writeZcodeDb(makeTmpDir(), {
    sessions: [{ id: "s2", directory: null }],
    parts: [
      { callId: "ms", tool: "bash", input: { command: "echo ms" } },
      { callId: "sec", tool: "bash", input: { command: "echo sec" } },
      { callId: "none", tool: "bash", input: { command: "echo none" } },
    ],
    usages: [
      { callId: "ms", toolName: "bash", startedAt: ZCODE_TS },
      { callId: "sec", toolName: "bash", startedAt: Math.floor(ZCODE_TS / 1000) },
      { callId: "none", toolName: "bash", startedAt: null },
    ],
  });
  const { events } = await collect(p2);
  // NULL sorts FIRST on SQLite ASC (documented ordering semantics)
  expect(events.map((e) => e.timestamp?.toISOString() ?? null)).toEqual([
    null,
    new Date(ZCODE_TS).toISOString(),
    new Date(Math.floor(ZCODE_TS / 1000) * 1000).toISOString(),
  ]);
});

t("ordering follows started_at, not insertion order", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [
      { callId: "late", tool: "bash", input: { command: "echo late" } },
      { callId: "early", tool: "bash", input: { command: "echo early" } },
    ],
    usages: [
      { callId: "late", toolName: "bash", startedAt: ZCODE_TS + 1000 },
      { callId: "early", toolName: "bash", startedAt: ZCODE_TS },
    ],
  });
  const { events } = await collect(p);
  expect(events.map((e) => (e as ShellCommand).raw)).toEqual(["echo early", "echo late"]);
});

t("non-sqlite file rejects with an error (engine counts files_failed)", async () => {
  const root = makeTmpDir();
  const p = join(root, "db.sqlite");
  writeFileSync(p, "this is not a sqlite database", "utf8");
  await expect(collect(p)).rejects.toThrow();
});

// --- discovery + registry ---------------------------------------------------------

t("zcode discovery: explicit db file or a directory holding db.sqlite", () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, { sessions: [], parts: [], usages: [] });
  expect(AGENTS.zcode.find(p)).toEqual([p]); // the db file itself
  expect(AGENTS.zcode.find(root)).toEqual([p]); // or its parent directory
  expect(AGENTS.zcode.find(join(root, "nope"))).toEqual([]);
});

t("zcode find uses ~/.zcode/cli/db/db.sqlite by default and is silent when missing", () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const expected = join(home, ".zcode", "cli", "db", "db.sqlite");
  expect(defaultZcodeDbPath()).toBe(expected);
  expect(AGENTS.zcode.find()).toEqual([]); // missing default store -> []
  writeZcodeDb(join(home, ".zcode", "cli", "db"), { sessions: [], parts: [], usages: [] });
  expect(AGENTS.zcode.find()).toEqual([expected]);
});

t("node:sqlite gate: unavailable runtime -> [] with exactly one stderr hint", () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, { sessions: [], parts: [], usages: [] });
  const errChunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  setSqliteLoaderForTests(() => {
    throw new Error("ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite");
  });
  expect(AGENTS.zcode.find(p)).toEqual([]);
  expect(AGENTS.zcode.find(p)).toEqual([]); // second call: still no repeat hint
  const hints = errChunks.filter((c) => c.includes("node:sqlite"));
  expect(hints).toHaveLength(1);
});

t("registry exposes zcode as ZCode with a working parser", async () => {
  expect(AGENTS.zcode.id).toBe("zcode");
  expect(AGENTS.zcode.displayName).toBe("ZCode");
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "c1", tool: "bash", input: { command: "ls" } }],
    usages: [{ callId: "c1", toolName: "bash" }],
  });
  const stats = new ParseStats();
  const events = [];
  for await (const ev of AGENTS.zcode.parser.iterEvents(p, stats)) {
    events.push(ev);
  }
  expect(events).toHaveLength(1);
  expect(stats.events).toBe(1);
});

// --- CLI -------------------------------------------------------------------------

test("--agent zcode routes the store through the full pipeline (--json)", async () => {
  const root = makeTmpDir();
  const p = writeZcodeDb(root, {
    parts: [{ callId: "c1", tool: "bash", input: { command: "rm -rf /x" } }],
    usages: [{ callId: "c1", toolName: "bash" }],
  });
  const { main } = await import("../src/cli.js");
  const outChunks: string[] = [];
  const code = await main(["--agent", "zcode", p, "--json"], {
    stdout: (c) => outChunks.push(c),
    stderr: () => {},
  });
  expect(code).toBe(0);
  const data = JSON.parse(outChunks.join(""));
  expect(data.summary.by_agent).toEqual({ zcode: 1 });
  expect(data.findings.map((f: { rule_id: string }) => f.rule_id)).toContain("D001");
  expect(data.findings[0].session_id).toBe(ZCODE_SESSION);
});

test("--list-agents lists zcode with its default-root count", async () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  writeZcodeDb(join(home, ".zcode", "cli", "db"), { sessions: [], parts: [], usages: [] });
  const { main } = await import("../src/cli.js");
  const outChunks: string[] = [];
  const code = await main(["--list-agents"], {
    stdout: (c) => outChunks.push(c),
    stderr: () => {},
  });
  expect(code).toBe(0);
  const out = outChunks.join("");
  expect(out).toContain("zcode");
  expect(out).toContain("ZCode");
  expect(out).toContain("1"); // exactly one store at the default root
});
