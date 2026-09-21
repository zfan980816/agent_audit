// Ported 1:1 from tests/test_report.py (Python implementation is the spec).
// pytest's Console(file=buf) becomes an injected string-collecting writer.
import { join } from "node:path";

import { expect, test } from "vitest";

import { runAudit, type AuditResult } from "../src/engine.js";
import {
  filterBySeverity,
  renderTerminal,
  severityCounts,
  shareCard,
  toDict,
  type WriteFn,
} from "../src/report.js";
import { makeToolLine, makeTmpDir, writeJsonl } from "./helpers.js";

async function makeResult(): Promise<AuditResult> {
  return runAudit([
    writeJsonl(join(makeTmpDir(), "a.jsonl"), [
      makeToolLine("Bash", { command: "rm -rf /tmp/x" }),
      makeToolLine("Bash", { command: "sudo apt install x" }),
      makeToolLine("Bash", { command: "ls -la" }),
    ]),
  ]);
}

// Python: Console(file=buf, force_terminal=False, width=160) + buf.getvalue()
function collectOut(): { write: WriteFn; value: () => string } {
  const chunks: string[] = [];
  return { write: (chunk) => chunks.push(chunk), value: () => chunks.join("") };
}

test("severity counts and filter", async () => {
  const result = await makeResult();
  const counts = severityCounts(result.findings);
  expect(counts.critical).toBe(1);
  expect(counts.medium).toBe(1);
  // all 5 severities zero-filled (no missing keys)
  expect(Object.keys(counts).sort()).toEqual(
    ["critical", "high", "info", "low", "medium"],
  );
  expect(filterBySeverity(result.findings, "critical")).toHaveLength(1);
});

test("render terminal contains rows", async () => {
  const result = await makeResult();
  const { write, value } = collectOut();
  renderTerminal(result, "low", write);
  const out = value();
  expect(out).toContain("D001");
  expect(out).toContain("B006");
  expect(out).toContain("CRITICAL");
  expect(out).not.toContain("skipped"); // 无坏行时不显示
});

test("to dict roundtrip", async () => {
  const result = await makeResult();
  const data = toDict(result);
  const text = JSON.stringify(data);
  expect(text).toContain('"findings"');
  expect(data.summary.total).toBe(2);
  expect(new Set(data.findings.map((f) => f.rule_id))).toEqual(
    new Set(["D001", "B006"]),
  );
  expect(["critical", "high", "medium", "low", "info"]).toContain(
    data.findings[0].severity,
  );
  // Python datetime.isoformat() format, not toISOString(): "+00:00" offset,
  // zero milliseconds omitted (makeResult uses .000Z timestamps)
  expect(data.findings[0].timestamp).toBe("2026-09-19T10:00:00+00:00");
});

test("toDict emits Python key order (T8 gate)", async () => {
  const result = await makeResult();
  const data = toDict(result);
  // programmatic key-order gate: Python dicts serialize in insertion order,
  // so Object.keys order here must equal Python's dict-literal order exactly
  expect(Object.keys(data)).toEqual(["summary", "findings"]);
  // M1 (v0.2.x multi-agent): by_agent appended AFTER the Python-parity prefix.
  // TS is the canonical schema now (Python frozen at v0.1.1 has no by_agent).
  expect(Object.keys(data.summary)).toEqual([
    "files",
    "files_failed",
    "sessions",
    "events",
    "lines_skipped",
    "total",
    "by_severity",
    "by_agent",
  ]);
  // default string[] input is attributed to the claude-code parser
  expect(data.summary.by_agent).toEqual({ "claude-code": 1 });
  expect(Object.keys(data.summary.by_severity)).toEqual([
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ]);
  expect(Object.keys(data.findings[0])).toEqual([
    "rule_id",
    "severity",
    "title",
    "evidence",
    "project",
    "session_id",
    "timestamp",
    "explanation",
    "recommendation",
  ]);
  // JSON.stringify keeps insertion order, so the serialized bytes key in the
  // same order Python's json.dumps would (the actual T8 comparison surface)
  const roundtripped = JSON.parse(JSON.stringify(data));
  expect(Object.keys(roundtripped.summary.by_severity)).toEqual([
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ]);
});

test("share card lines", async () => {
  const result = await makeResult();
  const card = shareCard(result);
  expect(card).toContain("agent-audit");
  expect(card).toContain("CRITICAL 1");
  expect(card).toContain("npx @fanzhen/agent-audit");
  // exact three lines; zero-count severities omitted
  const lines = card.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toBe("Sessions: 1   CRITICAL 1 · MEDIUM 1");
});

test("files failed surfaced", async () => {
  const tmpDir = makeTmpDir();
  const result = await runAudit([
    writeJsonl(join(tmpDir, "a.jsonl"), [
      makeToolLine("Bash", { command: "ls -la" }),
    ]),
    join(tmpDir, "missing.jsonl"),
  ]);
  const data = toDict(result);
  expect(data.summary.files_failed).toBe(1);
  const { write, value } = collectOut();
  renderTerminal(result, "low", write);
  expect(value()).toContain("failed to read 1");
});

test("bracket evidence renders without markup crash", async () => {
  // Python rich would raise MarkupError on plain-str cells with [/...];
  // TS cells are raw text, so the brackets must come through verbatim
  const result = await runAudit([
    writeJsonl(join(makeTmpDir(), "a.jsonl"), [
      makeToolLine("Bash", { command: "del /s [/etc] /q" }),
    ]),
  ]);
  expect(result.findings.map((f) => f.ruleId)).toEqual(["D001"]);
  const { write, value } = collectOut();
  renderTerminal(result, "low", write);
  expect(value()).toContain("[/etc]");
});
