// Ported 1:1 from tests/test_cli.py (Python implementation is the spec).
// typer's CliRunner becomes an injected stdout/stderr pair — main() is called
// directly, no subprocess (port-plan decision).
import { join } from "node:path";

import { expect, test } from "vitest";

import { main } from "../src/cli.js";
import { makeTmpDir } from "./helpers.js";

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

test("list rules", async () => {
  const io = capture();
  const code = await main(["--list-rules"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("D001");
  expect(io.out()).toContain("U006");
  expect(io.out().split("\n").filter((l) => l.trim()).length)
    .toBeGreaterThanOrEqual(28);
});

test("demo json output", async () => {
  const io = capture();
  const code = await main(["--demo", "--json"], io);
  expect(code).toBe(0);
  // JSON.parse on the raw stdout capture doubles as the ledger M gate: any
  // ANSI escape leaking into stdout would break the parse.
  const data = JSON.parse(io.out());
  expect(data.summary.total).toBeGreaterThanOrEqual(10);
  expect(data.findings.some((f) => f.rule_id === "D001")).toBe(true);
});

test("demo severity filter", async () => {
  const io = capture();
  const code = await main(["--demo", "--json", "--severity", "critical"], io);
  expect(code).toBe(0);
  const data = JSON.parse(io.out());
  expect(data.summary.total).toBeGreaterThanOrEqual(1);
  expect(data.findings.every((f) => f.severity === "critical")).toBe(true);
});

test("demo rules filter", async () => {
  const io = capture();
  const code = await main(["--demo", "--json", "--rules", "D"], io);
  expect(code).toBe(0);
  const data = JSON.parse(io.out());
  expect(new Set(data.findings.map((f) => f.rule_id[0]))).toEqual(
    new Set(["D"]),
  );
});

test("demo terminal and share", async () => {
  const io = capture();
  const code = await main(["--demo", "--share"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("agentaudit");
  expect(io.out()).toContain("npx agent-audit");
  // ledger M: non-TTY stdout must render ANSI-free (rich gates on isatty;
  // picocolors bakes the decision in at import time).
  expect(io.out()).not.toContain("\u001b[");
});

test("missing path errors cleanly", async () => {
  const io = capture();
  const code = await main([join(makeTmpDir(), "nope")], io);
  expect(code).not.toBe(0);
  expect(io.err().toLowerCase()).toContain("not found");
});
