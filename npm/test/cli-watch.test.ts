// M5: CLI --watch flag wiring. TS-only mode on the single-command CLI
// (design decision: --watch flag, NOT a commander subcommand). Follows
// cli-agents.test.ts's injected-writer pattern; the watch deps are injected
// so no test spawns powershell.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { main, type MainIo } from "../src/cli.js";
import { makeTmpDir } from "./helpers.js";
import { CSV_HEADER, DEFAULT_WATCH_PROCS, type WatchDeps } from "../src/watch.js";

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

const FAKE_POLL: WatchDeps["poll"] = async () => ({
  conns: [{ proc: "ZCode", pid: 7600, ip: "124.160.144.209", port: 443 }],
  dns: [{ host: "zcode.z.ai", ip: "124.160.144.209" }],
});

function instantDeps(): Partial<WatchDeps> {
  // the sleep MUST advance the fake clock: runWatch's loop guard compares
  // now() against the (fixed) start time, so a sleep that doesn't advance
  // time would spin forever — the exact bug this helper avoids.
  const clock = { t: 0 };
  return {
    poll: FAKE_POLL,
    now: () => new Date(clock.t),
    sleep: async (ms) => {
      clock.t += ms;
    },
  };
}

function instantDepsPoll(poll: WatchDeps["poll"]): Partial<WatchDeps> {
  const deps = instantDeps();
  deps.poll = poll;
  return deps;
}

function withPlatform<T>(plat: string, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: plat });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", orig);
  }
}

afterEach(() => {
  // no env stubs used here, but keep parity with cli-agents.test.ts hygiene
});

test("--watch runs the monitor with injected deps and prints the summary", async () => {
  const io = capture();
  const io2: MainIo = { ...io, watchDeps: instantDeps() };
  const code = await main(["--watch", "--proc", "ZCode", "--seconds", "1"], io2);
  expect(code).toBe(0);
  expect(io.out()).toContain("watching ZCode for 1s");
  // live line went through the injected stdout writer
  expect(io.out()).toContain(
    "ZCode(7600) → 124.160.144.209:443 zcode.z.ai (model-api)",
  );
  expect(io.out()).toContain("──── agent-audit watch ────");
  expect(io.out()).toContain("new connections 1");
  expect(io.out()).toContain("by category: model-api 1");
});

test("--watch without --proc uses the default process list", async () => {
  const io = capture();
  let seenProcs: string[] | null = null;
  const deps: WatchDeps["poll"] = async (procs) => {
    seenProcs = [...procs];
    return { conns: [], dns: [] };
  };
  const code = await main(
    ["--watch", "--seconds", "1"],
    { ...io, watchDeps: instantDepsPoll(deps) },
  );
  expect(code).toBe(0);
  expect(seenProcs).toEqual([...DEFAULT_WATCH_PROCS]);
});

test("--proc values are normalized (trim, .exe stripped, dedupe)", async () => {
  const io = capture();
  let seenProcs: string[] | null = null;
  const deps: WatchDeps["poll"] = async (procs) => {
    seenProcs = [...procs];
    return { conns: [], dns: [] };
  };
  await main(
    ["--watch", "--proc", "ZCode.exe, zcode ,QoderCN", "--seconds", "1"],
    { ...io, watchDeps: instantDepsPoll(deps) },
  );
  // ".exe" stripping happens before dedupe; the second "zcode" duplicates
  // the first entry only in lowercase, and Windows process names compare
  // case-sensitively, so both stay
  expect(seenProcs).toEqual(["ZCode", "zcode", "QoderCN"]);
});

test("--seconds <= 0 or non-numeric exits 2", async () => {
  const io = capture();
  const io2: MainIo = { ...io, watchDeps: instantDeps() };
  expect(await main(["--watch", "--seconds", "0"], io2)).toBe(2);
  expect(io.err()).toContain("--seconds");
  expect(await main(["--watch", "--seconds", "abc"], io2)).toBe(2);
});

test("--proc naming no process exits 2", async () => {
  const io = capture();
  const io2: MainIo = { ...io, watchDeps: instantDeps() };
  expect(await main(["--watch", "--proc", " ,,"], io2)).toBe(2);
  expect(io.err()).toContain("--proc");
});

test("--watch on non-Windows exits 2 with the Windows-only message", async () => {
  const io = capture();
  const code = withPlatform("linux", () =>
    main(["--watch", "--proc", "ZCode", "--seconds", "1"], {
      ...io,
      watchDeps: instantDeps(),
    }),
  );
  expect(await code).toBe(2);
  expect(io.err()).toMatch(/Windows-only/);
});

test("--csv writes header + one row per connection via the real writer", async () => {
  const csvPath = join(makeTmpDir("agentaudit-watchcsv-"), "egress.csv");
  const io = capture();
  const code = await main(
    ["--watch", "--proc", "ZCode", "--seconds", "1", "--csv", csvPath],
    { ...io, watchDeps: instantDeps() },
  );
  expect(code).toBe(0);
  expect(existsSync(csvPath)).toBe(true);
  const content = readFileSync(csvPath, "utf8");
  expect(content.startsWith(`${CSV_HEADER}\n`)).toBe(true);
  expect(content.trimEnd().split("\n")).toHaveLength(2);
  expect(content).toContain("zcode.z.ai,model-api");
  expect(io.out()).toContain(`csv: ${csvPath}`);
});

test("watch-only flags without --watch print a hint and run a normal audit", async () => {
  const io = capture();
  const code = await main(["--demo", "--proc", "ZCode", "--csv", "D:/tmp/x.csv"], io);
  expect(code).toBe(0);
  expect(io.err()).toContain("--watch");
  expect(io.out()).toContain("agentaudit"); // normal audit/demo output happened
});

test("audit runs are untouched: --list-rules still works with --watch absent", async () => {
  const io = capture();
  const code = await main(["--list-rules"], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("agentaudit rules (");
});
