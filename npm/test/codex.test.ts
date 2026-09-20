// Codex CLI rollout parser tests (M2). Fixtures in codex-fixtures.ts: real
// envelope/meta shapes + synthetic tool-call records (codex-rs source-verified
// shapes — the local corpus has zero tool-call records). Stats/error semantics
// mirror parsers/claude-code.ts, identity mapping mirrors kimi.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { AGENTS, defaultCodexSessionsDir } from "../src/agents.js";
import { FileWrite, McpToolCall, NetworkRequest, ShellCommand } from "../src/events.js";
import { ParseStats } from "../src/parsers/claude-code.js";
import { parseApplyPatch, iterEvents } from "../src/parsers/codex.js";
import { makeTmpDir, writeJsonl } from "./helpers.js";
import {
  CODEX_CWD,
  CODEX_FALLBACK_SESSION,
  CODEX_SESSION,
  CODEX_TS,
  codexCustomToolCall,
  codexEnvelope,
  codexEventMsg,
  codexFunctionCall,
  codexLocalShellCall,
  codexSessionMeta,
  codexTurnContext,
  codexWebSearch,
  rolloutPath,
  writeRollout,
} from "./codex-fixtures.js";

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
  vi.unstubAllEnvs();
});

// --- shell mappings -------------------------------------------------------

test("exec_command function_call double-decodes JSON-string args into ShellCommand", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("exec_command", { cmd: "cargo test --all", workdir: "D:\\w" }),
  ]);
  const { events, stats } = await collect(p);
  expect(events).toHaveLength(1);
  const ev = events[0] as ShellCommand;
  expect(ev).toBeInstanceOf(ShellCommand);
  expect(ev.raw).toBe("cargo test --all");
  expect(ev.cwd).toBe("D:\\w"); // args workdir beats turn_context/session cwd
  expect(ev.sessionId).toBe(CODEX_SESSION);
  expect(ev.project).toBe(CODEX_CWD);
  // envelope timestamp (RFC3339) -> Date
  expect(ev.timestamp?.toISOString()).toBe(CODEX_TS);
  expect(stats.events).toBe(1);
  expect(stats.linesSkipped).toBe(0);
});

test("legacy shell function_call joins its command array", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("shell", { command: ["bash", "-lc", "ls -la | wc -l"] }),
  ]);
  const { events } = await collect(p);
  const ev = events[0] as ShellCommand;
  expect(ev.raw).toBe("bash -lc ls -la | wc -l");
  expect(ev.cwd).toBe(CODEX_CWD); // session_meta cwd, no turn_context yet
});

test("local_shell_call action.command array becomes ShellCommand with working_directory", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexLocalShellCall({
      type: "exec",
      command: ["pwsh", "-NoProfile", "-Command", "Get-ChildItem"],
      working_directory: "D:\\elsewhere",
    }),
  ]);
  const { events } = await collect(p);
  const ev = events[0] as ShellCommand;
  expect(ev.raw).toBe("pwsh -NoProfile -Command Get-ChildItem");
  expect(ev.cwd).toBe("D:\\elsewhere");
});

test("exec_command with corrupt arguments is skipped silently", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("exec_command", "not-json{"), // arguments not JSON at all
    codexFunctionCall("shell", '{"command": 42}'), // parses, but no usable command
    codexFunctionCall("exec_command", {"nope": 1}), // no cmd field
  ]);
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.events).toBe(0);
  expect(stats.linesSkipped).toBe(0); // the LINES are fine; only args are bad
});

// --- apply_patch / V4A -----------------------------------------------------

test("apply_patch: Add captures full content, Update/Delete stay path-only, one FileWrite each", async () => {
  const root = makeTmpDir();
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new_tool.py",
    "+def tool():",
    "+    pass",
    "*** Update File: configs/settings.json",
    "@@",
    "-old_key = 1",
    "+new_key = 2",
    "*** Delete File: scratch/temp.txt",
    "*** End Patch",
  ].join("\n");
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexCustomToolCall(patch),
  ]);
  const { events } = await collect(p);
  expect(events).toHaveLength(3);
  const [add, upd, del] = events as [FileWrite, FileWrite, FileWrite];
  expect(add.path).toBe("src/new_tool.py");
  expect(add.content).toBe("def tool():\n    pass");
  expect(add.isConfig).toBe(false);
  // Update carries a diff, not the resulting file -> content null
  expect(upd.path).toBe("configs/settings.json");
  expect(upd.content).toBeNull();
  expect(upd.isConfig).toBe(true); // settings.json is a config basename
  expect(del.path).toBe("scratch/temp.txt");
  expect(del.content).toBeNull();
});

test("V4A parser: Add/Update/Delete/Move shapes, windows paths, empty file add", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: D:\\proj\\app.py",
    "+print(1)",
    "*** Add File: empty.txt",
    "*** Update File: old name.txt",
    "*** Move to: new name.txt",
    "@@ ctx",
    "-a",
    "+b",
    "*** Delete File: gone.txt",
    "*** End Patch",
  ].join("\n");
  expect(parseApplyPatch(patch)).toEqual([
    { kind: "add", path: "D:\\proj\\app.py", content: "print(1)" },
    { kind: "add", path: "empty.txt", content: "" }, // empty file add
    { kind: "move", path: "new name.txt", content: null }, // rename wins
    { kind: "delete", path: "gone.txt", content: null },
  ]);
  // tolerant: missing End Patch still flushes; CRLF accepted; no sections -> []
  expect(parseApplyPatch("*** Add File: a.txt\r\n+x\r\n")).toEqual([
    { kind: "add", path: "a.txt", content: "x" },
  ]);
  expect(parseApplyPatch("just some text\nno markers")).toEqual([]);
});

test("non-apply_patch custom_tool_call names are skipped", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexCustomToolCall("{}", "some_container_tool"),
  ]);
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.events).toBe(0);
});

// --- MCP -------------------------------------------------------------------

test("MCP function_call: namespace wins, flat server__tool splits, legacy mcp__ strips", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("create_issue", { title: "t" }, { namespace: "github" }),
    codexFunctionCall("serverone__do_thing", { a: 1 }),
    codexFunctionCall("mcp__maps__geocode", { q: "paris" }),
  ]);
  const { events } = await collect(p);
  expect(events).toHaveLength(3);
  const [ns, flat, legacy] = events as [McpToolCall, McpToolCall, McpToolCall];
  expect(ns.server).toBe("github");
  expect(ns.tool).toBe("create_issue");
  expect(ns.argsHint).toBe('{"title": "t"}'); // pyJsonDumps of the parsed args
  expect(flat.server).toBe("serverone");
  expect(flat.tool).toBe("do_thing");
  expect(legacy.server).toBe("maps");
  expect(legacy.tool).toBe("geocode");
});

// --- web --------------------------------------------------------------------

test("web_search_call: search query and open_page url become NetworkRequest", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexWebSearch({ type: "search", query: "openai codex cli" }),
    codexWebSearch({ type: "open_page", url: "https://example.com/page" }),
    codexWebSearch({ type: "find_in_page", url: "https://example.com/page", pattern: "x" }),
  ]);
  const { events } = await collect(p);
  expect(events).toHaveLength(3);
  expect(events.every((e) => e instanceof NetworkRequest)).toBe(true);
  expect(events.map((e) => (e as NetworkRequest).url)).toEqual([
    "openai codex cli",
    "https://example.com/page",
    "https://example.com/page",
  ]);
});

// --- skip policy -------------------------------------------------------------

test("other function_call names and non-tool response_items are skipped silently", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("view_image", { path: "img.png" }),
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: [] } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_0001", output: "ok" } },
    codexEventMsg({ type: "item_completed", item: { type: "FunctionCallOutput", id: "x" } }),
    codexEventMsg({ type: "task_started", turn_id: "t" }),
    codexEventMsg({ type: "turn_started", turn_id: "t" }), // newer alias
    codexEventMsg({ type: "task_complete", last_agent_message: null }),
  ]);
  const { events, stats } = await collect(p);
  expect(events).toEqual([]);
  expect(stats.linesSkipped).toBe(0); // skipped SILENTLY, never counted
});

test("envelope/stats ordering: blank uncounted, parse-fail + non-record counted, unknown types silent", async () => {
  const root = makeTmpDir();
  const p = rolloutPath(root);
  writeFileSync(
    p,
    [
      JSON.stringify(codexEnvelope(codexSessionMeta(), 0)),
      "", // blank: never counted
      "not-json", // parse failure -> linesSkipped
      "[1,2]", // parses to a non-record -> linesSkipped
      JSON.stringify({ timestamp: CODEX_TS, ordinal: 4, type: "future_rollout_item", payload: {} }),
      JSON.stringify(codexEnvelope(codexEventMsg({ type: "token_count" }), 5)),
      JSON.stringify(codexEnvelope(codexFunctionCall("exec_command", { cmd: "echo hi" }), 6)),
      JSON.stringify(codexEnvelope(codexFunctionCall("view_image", {}), 7)),
    ].join("\n") + "\n",
    "utf8",
  );
  const { events, stats } = await collect(p);
  expect(events).toHaveLength(1);
  expect((events[0] as ShellCommand).raw).toBe("echo hi");
  expect(stats.linesTotal).toBe(7); // the blank line is not counted
  expect(stats.linesSkipped).toBe(2); // not-json + non-record only
});

test("envelope timestamps: RFC3339 parsed, garbage -> null (claude-code parseTs guard)", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("exec_command", { cmd: "echo a" }, { callId: "c1" }),
    { ...codexFunctionCall("exec_command", { cmd: "echo b" }, { callId: "c2" }), ts: "Sep 20 2026" },
  ]);
  const { events } = await collect(p);
  expect(events).toHaveLength(2);
  expect(events[0]?.timestamp?.toISOString()).toBe(CODEX_TS);
  expect(events[1]?.timestamp).toBeNull();
});

// --- identity -----------------------------------------------------------------

test("session_meta provides session id + project; turn_context cwd rolls; args workdir wins", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta({ cwd: "D:\\demo\\codex-proj" }),
    codexTurnContext("D:\\turn\\one"),
    codexFunctionCall("exec_command", { cmd: "echo a" }), // -> turn cwd
    codexTurnContext("D:\\turn\\two"),
    codexFunctionCall("exec_command", { cmd: "echo b", workdir: "D:\\args\\wd" }),
    codexFunctionCall("exec_command", { cmd: "echo c" }), // -> latest turn cwd
  ]);
  const { events } = await collect(p);
  expect(events).toHaveLength(3);
  const [a, b, c] = events as [ShellCommand, ShellCommand, ShellCommand];
  expect(a.cwd).toBe("D:\\turn\\one");
  expect(b.cwd).toBe("D:\\args\\wd");
  expect(c.cwd).toBe("D:\\turn\\two");
  // project stays the session_meta cwd (research doc §8 mapping)
  expect(a.project).toBe("D:\\demo\\codex-proj");
  expect(a.sessionId).toBe(CODEX_SESSION);
});

test("no session_meta: session id falls back to the filename uuid, project to parent dir", async () => {
  const root = makeTmpDir();
  // rollout-<compact-ts>-<thread-uuid>; fork names keep the THREAD id (the
  // first uuid group), so assert it survives a _<rollout-id> suffix too.
  const p = writeRollout(
    rolloutPath(root, `rollout-2026-09-20T08-00-00-${CODEX_FALLBACK_SESSION}_01a0ffff-dead-beef-0000-000000000001.jsonl`),
    [codexFunctionCall("exec_command", { cmd: "echo hi" })],
  );
  const { events } = await collect(p);
  expect(events[0]?.sessionId).toBe(CODEX_FALLBACK_SESSION);
  expect(events[0]?.project).toBe("20"); // parent dir name, claude-code parity
  const plain = writeRollout(rolloutPath(root, "plain-name.jsonl", "misc"), [
    codexFunctionCall("exec_command", { cmd: "echo hi" }),
  ]);
  const { events: plainEvents } = await collect(plain);
  expect(plainEvents[0]?.sessionId).toBe("plain-name"); // stem, like claude-code
});

test("session_meta: session_id wins over id; id alone still works (forward compat)", async () => {
  const root = makeTmpDir();
  const both = codexSessionMeta({ sessionId: "primary-id", id: "secondary-id" });
  const idOnly = codexSessionMeta({ sessionId: "ignored", id: "from-id-field" });
  delete idOnly.payload.session_id;
  const p = writeRollout(rolloutPath(root), [
    both,
    codexFunctionCall("exec_command", { cmd: "echo a" }),
  ]);
  const p2 = writeRollout(rolloutPath(root, `rollout-2026-09-20T09-00-00-${CODEX_FALLBACK_SESSION}.jsonl`), [
    idOnly,
    codexFunctionCall("exec_command", { cmd: "echo b" }),
  ]);
  const { events } = await collect(p);
  const { events: events2 } = await collect(p2);
  expect(events[0]?.sessionId).toBe("primary-id");
  expect(events2[0]?.sessionId).toBe("from-id-field");
});

// --- discovery + registry -------------------------------------------------------

test("codex discovery walks sessions/** for .jsonl, excludes .zst and non-jsonl", () => {
  const root = makeTmpDir();
  const a = writeRollout(rolloutPath(root, `rollout-2026-08-19T10-00-00-${CODEX_SESSION}.jsonl`, join("2026", "08", "19")), []);
  const b = writeRollout(rolloutPath(root), []);
  writeJsonl(rolloutPath(root, "rollout-compressed.jsonl.zst", join("2026", "09", "20")), []);
  writeFileSync(join(root, "2026", "09", "20", "notes.txt"), "x", "utf8");
  expect(AGENTS.codex.find(root)).toEqual([a, b].sort((x, y) => (x < y ? -1 : 1)));
});

test("codex find uses ~/.codex/sessions by default and is silent when missing", () => {
  const home = makeTmpDir();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const expected = join(home, ".codex", "sessions");
  expect(defaultCodexSessionsDir()).toBe(expected);
  expect(AGENTS.codex.find()).toEqual([]); // missing default root -> []
  const real = writeRollout(rolloutPath(expected), [codexSessionMeta()]);
  expect(AGENTS.codex.find()).toEqual([real]);
});

test("registry exposes codex with displayName Codex CLI and a parser", async () => {
  expect(AGENTS.codex.id).toBe("codex");
  expect(AGENTS.codex.displayName).toBe("Codex CLI");
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("exec_command", { cmd: "ls" }),
  ]);
  const stats = new ParseStats();
  const events = [];
  for await (const ev of AGENTS.codex.parser.iterEvents(p, stats)) {
    events.push(ev);
  }
  expect(events).toHaveLength(1);
  expect(stats.events).toBe(1);
});

// --- pipeline -------------------------------------------------------------------

test("codex rm -rf fires D001 through the full pipeline (runAudit, by_agent)", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexTurnContext(CODEX_CWD),
    codexFunctionCall("exec_command", { cmd: "rm -rf /x" }),
  ]);
  const { runAudit } = await import("../src/engine.js");
  const result = await runAudit([{ agent: "codex", path: p }]);
  expect(result.findings.map((f) => f.ruleId)).toContain("D001");
  expect(result.findings[0]?.event.sessionId).toBe(CODEX_SESSION);
  expect(result.byAgent).toEqual({ codex: 1 });
  expect(result.events).toBe(1);
  expect(result.sessions.has(CODEX_SESSION)).toBe(true);
});

test("--agent codex routes only codex discovery through the codex parser", async () => {
  const root = makeTmpDir();
  const p = writeRollout(rolloutPath(root), [
    codexSessionMeta(),
    codexFunctionCall("exec_command", { cmd: "rm -rf /x" }),
  ]);
  // claude-shaped decoy in the same explicit root: codex rglob counts the
  // file, but its records mean nothing to the codex parser (no leak).
  writeJsonl(join(root, "claude-decoy.jsonl"), [
    {
      type: "assistant",
      sessionId: "c-1",
      timestamp: "2026-09-19T10:00:00.000Z",
      cwd: "D:\\demo",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "rm -rf /y" } }] },
    },
  ]);
  const { main } = await import("../src/cli.js");
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const code = await main(["--agent", "codex", root, "--json"], {
    stdout: (c) => outChunks.push(c),
    stderr: (c) => errChunks.push(c),
  });
  expect(code).toBe(0);
  const data = JSON.parse(outChunks.join(""));
  expect(data.summary.by_agent).toEqual({ codex: 2 });
  expect(data.summary.files).toBe(2);
  expect(data.findings).toHaveLength(1);
  expect(data.findings[0].rule_id).toBe("D001");
  expect(data.findings[0].session_id).toBe(CODEX_SESSION);
});

test("missing file rejects with fs error (ENOENT)", async () => {
  const root = makeTmpDir();
  let caught: NodeJS.ErrnoException | null = null;
  try {
    await collect(join(root, "missing", "rollout-x.jsonl"));
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe("ENOENT");
});
