// M6: Qoder local-footprint inventory (--footprint). Unit tests run against a
// synthetic qoder-shaped tree (footprint-fixtures.ts, real live-schema
// columns); CLI tests use the same tree through the injected-writer pattern —
// nothing here touches the real ~/.qoder-cn.
import { join } from "node:path";

import { expect, test } from "vitest";

import { main, type MainIo } from "../src/cli.js";
import {
  qoderFootprint,
  renderFootprint,
} from "../src/footprint.js";
import { makeTmpDir } from "./helpers.js";
import {
  MARKER,
  TIME_HI,
  TIME_LO,
  WS_A,
  WS_B,
  writeQoderTree,
} from "./footprint-fixtures.js";

// Built once per file; qoderFootprint only reads the tree.
const TREE = makeTmpDir("agentaudit-footprint-");
writeQoderTree(TREE);
const GUARD_TREE = makeTmpDir("agentaudit-footprint-guard-");
writeQoderTree(GUARD_TREE, { guardMarker: MARKER });

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

test("footprint inventories repos across vector/completion/git/graph/memory stores", () => {
  const report = qoderFootprint(TREE);
  expect(report.root).toBe(TREE);
  // union of the per-index repo dirs, sorted by repo name
  expect(report.repos.map((r) => r.repo)).toEqual(["repo-b", "repo_c", "repoa"]);

  const a = report.repos.find((r) => r.repo === "repoa")!;
  expect(a.vectorChunks).toBe(6); // 2 + 3 + 1 chunk rows
  expect(a.vectorFiles).toBe(3); // DISTINCT file_path in the chunk table
  // the inventory LISTS the indexed paths (metadata only, sorted)
  expect(a.vectorFilePaths).toEqual([
    "D:\\Project\\repoa\\lib\\Helper.java",
    "D:\\Project\\repoa\\src\\Main.java",
    "D:\\Project\\repoa\\src\\Util.java",
  ]);
  expect(a.completionStores).toBe(2);
  expect(a.completionBytes).toBe(3000);
  expect(a.gitRows).toBe(4);
  expect(a.graphNodes).toBe(5);
  expect(a.graphEdges).toBe(7);
  expect(a.memoryFiles).toEqual(["dev/note1.md", "ops/note2.md"]);
  // index_record_512.record_time is epoch SECONDS (live-verified magnitude)
  expect(a.vectorFirstSeen).toBe(new Date(TIME_LO * 1000).toISOString());
  expect(a.vectorLastSeen).toBe(new Date(TIME_HI * 1000).toISOString());

  const b = report.repos.find((r) => r.repo === "repo-b")!;
  expect(b.vectorChunks).toBe(2);
  expect(b.vectorFiles).toBe(1); // one indexed file (app.ts)
  expect(b.completionStores).toBe(1);
  expect(b.completionBytes).toBe(500);
  expect(b.gitRows).toBeUndefined(); // no git index for this repo
  expect(b.graphNodes).toBeUndefined();
  expect(b.graphEdges).toBeUndefined();
  expect(b.memoryFiles).toEqual(["x.md"]);
  expect(b.vectorFirstSeen).toBeNull(); // chat.db has no record_time column
  expect(b.vectorLastSeen).toBeNull();

  const c = report.repos.find((r) => r.repo === "repo_c")!;
  expect(c.vectorChunks).toBe(0); // graph-only repo: vector counts stay zero
  expect(c.completionStores).toBe(0);
  expect(c.graphNodes).toBe(2);
  expect(c.graphEdges).toBe(1);
  expect(c.memoryFiles).toEqual([]);
});

test("agent memory summary reads workspace names only; unmatched projects are listed", () => {
  const report = qoderFootprint(TREE);
  expect(report.agentMemories.count).toBe(3);
  // sorted with the repo-wide comparePaths (case-folded, "-" < "a")
  expect(report.agentMemories.workspaces).toEqual([
    { workspace: WS_B, memories: 1 },
    { workspace: WS_A, memories: 2 },
  ]);
  // a memory project that matches no indexed repo is still Qoder's footprint
  expect(report.unmatchedMemoryProjects).toEqual([
    { project: "D-Project-unmatched", fileCount: 1 },
  ]);
});

test("missing root yields a clean empty report", () => {
  const report = qoderFootprint(join(makeTmpDir("agentaudit-footprint-empty-"), "nope"));
  expect(report.repos).toEqual([]);
  expect(report.agentMemories).toEqual({ count: 0, workspaces: [] });
  expect(report.unmatchedMemoryProjects).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(typeof report.generatedAt).toBe("string");
});

test("file content never reaches the report even when the stores hold text", () => {
  const report = qoderFootprint(GUARD_TREE);
  const json = JSON.stringify(report);
  // the report lists PATHS (that is its point)...
  expect(json).toContain("Main.java");
  expect(json).toContain("app.ts");
  // ...but never the planted source/memory markers: the reader only SELECTs
  // metadata columns and never interprets .zap bytes as text
  expect(json).not.toContain(MARKER);
  // the terminal panel is a counts summary (paths live in --json), equally
  // marker-free
  const terminal = renderFootprint(report);
  expect(terminal).toContain("repoa");
  expect(terminal).not.toContain(MARKER);
});

test("renderFootprint prints the panel header, per-repo table and privacy note", () => {
  const terminal = renderFootprint(qoderFootprint(TREE));
  expect(terminal).toContain("──── agent-audit footprint ────");
  expect(terminal).toContain("repoa");
  expect(terminal).toContain("repo-b");
  expect(terminal).toContain("repo_c");
  expect(terminal).toContain("metadata only"); // content-never-printed note
  expect(terminal).toContain(WS_A); // agent-memory workspace names are listed
  expect(terminal).toContain("D-Project-unmatched");

  const empty = renderFootprint(qoderFootprint(join(makeTmpDir("agentaudit-footprint-e2-"), "nope")));
  expect(empty).toContain("──── agent-audit footprint ────");
  expect(empty).toContain("metadata only");
});

// --- CLI wiring -----------------------------------------------------------------

test("CLI --footprint --json emits a parseable footprint report", async () => {
  const io = capture();
  const code = await main(["--footprint", TREE, "--json"], io);
  expect(code).toBe(0);
  const parsed = JSON.parse(io.out()) as {
    root: string;
    repos: Array<{ repo: string; vectorChunks: number }>;
  };
  expect(parsed.root).toBe(TREE);
  expect(parsed.repos.map((r) => r.repo)).toContain("repoa");
  expect(parsed.repos.find((r) => r.repo === "repoa")!.vectorChunks).toBe(6);
});

test("CLI --footprint renders the terminal panel", async () => {
  const io = capture();
  const code = await main(["--footprint", TREE], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("──── agent-audit footprint ────");
  expect(io.out()).toContain("repoa");
  expect(io.out()).toContain("metadata only");
});

test("CLI --footprint --agent qoder works; any other agent exits 2", async () => {
  const ok = capture();
  expect(await main(["--footprint", "--agent", "qoder", TREE, "--json"], ok)).toBe(0);
  expect(JSON.parse(ok.out())).toHaveProperty("repos");

  // "all" is the commander default — literally the bare --footprint form —
  // so it maps to the only supported tool instead of erroring
  const all = capture();
  expect(await main(["--footprint", "--agent", "all", TREE, "--json"], all)).toBe(0);
  expect(JSON.parse(all.out())).toHaveProperty("repos");

  const kimi = capture();
  expect(await main(["--footprint", "--agent", "kimi", TREE], kimi)).toBe(2);
  expect(kimi.err()).toContain("qoder");

  const multi = capture();
  expect(await main(["--footprint", "--agent", "qoder,kimi", TREE], multi)).toBe(2);
});

test("CLI --footprint ignores audit-only flags cleanly (no crash)", async () => {
  const io = capture();
  const code = await main(["--footprint", TREE, "--severity", "high"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("──── agent-audit footprint ────");
});
