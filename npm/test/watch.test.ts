// M5: watch core logic tests. runWatch takes injected deps (poll/now/sleep/
// writeLine/appendCsv) so NOTHING here spawns powershell or touches the net.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  CSV_HEADER,
  DEFAULT_WATCH_PROCS,
  WatchUnsupportedError,
  appendCsvLine,
  csvRow,
  formatLiveLine,
  parseWatchProcs,
  renderWatchSummary,
  runWatch,
  type PollSample,
  type WatchConn,
  type WatchDeps,
} from "../src/watch.js";
import { makeTmpDir } from "./helpers.js";

const ZCODE_CONN = {
  proc: "ZCode",
  pid: 7600,
  ip: "124.160.144.209",
  port: 443,
};

interface FakeState {
  deps: WatchDeps;
  lines: string[];
  csv: Array<{ path: string; line: string }>;
  clock: { t: number };
  calls: () => number;
}

function makeDeps(
  samples: PollSample[],
  opts: { alwaysFail?: boolean } = {},
): FakeState {
  let i = 0;
  const clock = { t: 0 };
  const lines: string[] = [];
  const csv: Array<{ path: string; line: string }> = [];
  const deps: WatchDeps = {
    platform: "win32",
    poll: async () => {
      if (opts.alwaysFail) throw new Error("powershell vanished");
      if (i < samples.length) return samples[i++];
      return { conns: [], dns: [] };
    },
    now: () => new Date(clock.t),
    sleep: async (ms) => {
      clock.t += ms;
    },
    writeLine: (line) => {
      lines.push(line);
    },
    appendCsv: (path, line) => {
      csv.push({ path, line });
    },
  };
  return { deps, lines, csv, clock, calls: () => i };
}

test("records each new connection once (dedupe on pid|ip|port)", async () => {
  const state = makeDeps([
    {
      conns: [ZCODE_CONN, { ...ZCODE_CONN, ip: "1.2.3.4" }],
      dns: [],
    },
    {
      conns: [ZCODE_CONN, { ...ZCODE_CONN, ip: "5.6.7.8", port: 80 }],
      dns: [],
    },
  ]);
  const result = await runWatch(
    { procs: ["ZCode"], seconds: 1 },
    state.deps,
  );
  // poll2 repeats conn1 (deduped) and adds one new -> 3 unique total
  expect(result.connections).toHaveLength(3);
  expect(result.polls).toBe(2);
  expect(state.lines).toHaveLength(3);
  expect(state.lines[0]).toContain("124.160.144.209:443");
  expect(state.lines[2]).toContain("5.6.7.8:80");
  // full record shape for an unmapped connection
  expect(result.connections[0]).toMatchObject({
    proc: "ZCode",
    pid: 7600,
    ip: "124.160.144.209",
    port: 443,
    host: null,
    category: "unknown",
    note: "no DNS mapping observed",
  });
});

// M5 review F2: two same-named processes (different pids) hitting the SAME
// endpoint are distinct connections — dedupe keys on pid, not proc name.
test("same-name different-pid connections to one endpoint both recorded", async () => {
  const state = makeDeps([
    {
      conns: [ZCODE_CONN, { ...ZCODE_CONN, pid: 9999 }],
      dns: [{ host: "zcode.z.ai", ip: "124.160.144.209" }],
    },
  ]);
  const result = await runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps);
  expect(result.connections).toHaveLength(2);
  expect(result.connections.map((c) => c.pid)).toEqual([7600, 9999]);
  expect(state.lines).toHaveLength(2);
});

test("labels connections via the DNS sample and marks unknown IPs", async () => {
  const state = makeDeps([
    {
      conns: [ZCODE_CONN, { ...ZCODE_CONN, ip: "9.9.9.9" }],
      dns: [{ host: "zcode.z.ai", ip: "124.160.144.209" }],
    },
  ]);
  const result = await runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps);
  expect(result.connections[0]!.host).toBe("zcode.z.ai");
  expect(result.connections[0]!.category).toBe("model-api");
  // unmatched IP: honest unknown with a note about the DNS window
  expect(result.connections[1]!.category).toBe("unknown");
  expect(result.connections[1]!.note).toMatch(/no DNS mapping/);
  expect(state.lines[0]).toContain("(model-api)");
  expect(state.lines[1]!.startsWith("[!] ")).toBe(true);
});

test("resolved-but-unregistered domains are flagged unknown with a note", async () => {
  const state = makeDeps([
    {
      conns: [ZCODE_CONN],
      dns: [{ host: "example.com", ip: "124.160.144.209" }],
    },
  ]);
  const result = await runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps);
  expect(result.connections[0]!.host).toBe("example.com");
  expect(result.connections[0]!.category).toBe("unknown");
  expect(result.connections[0]!.note).toMatch(/not in known-agent registry/);
  expect(state.lines[0]).toContain("example.com");
  expect(state.lines[0]).toContain("[!]");
});

test("filters polled connections to the watched process list", async () => {
  const state = makeDeps([
    {
      conns: [ZCODE_CONN, { proc: "chrome.exe", pid: 1, ip: "8.8.8.8", port: 443 }],
      dns: [],
    },
  ]);
  const result = await runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps);
  expect(result.connections).toHaveLength(1);
  expect(result.connections[0]!.proc).toBe("ZCode");
});

test("a pre-aborted signal performs no polls", async () => {
  const state = makeDeps([{ conns: [ZCODE_CONN], dns: [] }]);
  const controller = new AbortController();
  controller.abort();
  const result = await runWatch(
    { procs: ["ZCode"], seconds: 5, signal: controller.signal },
    state.deps,
  );
  expect(result.polls).toBe(0);
  expect(result.connections).toHaveLength(0);
  expect(state.lines).toHaveLength(0);
});

test("SIGINT mid-run returns the partial result", async () => {
  const controller = new AbortController();
  const state = makeDeps([{ conns: [ZCODE_CONN], dns: [] }]);
  state.deps.sleep = async (ms) => {
    controller.abort();
    state.clock.t += ms;
  };
  const result = await runWatch(
    { procs: ["ZCode"], seconds: 60, signal: controller.signal },
    state.deps,
  );
  expect(result.polls).toBe(1);
  expect(result.connections).toHaveLength(1);
  expect(result.elapsedMs).toBeGreaterThan(0);
});

test("poll failures are counted, warned about once, and never abort the watch", async () => {
  const state = makeDeps([], { alwaysFail: true });
  const result = await runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps);
  expect(result.polls).toBe(0);
  expect(result.pollErrors).toBe(2); // 1s watch, 700ms interval -> two cycles
  expect(state.lines).toHaveLength(1); // single warning line
  expect(state.lines[0]).toMatch(/poll failed/);
  expect(state.lines[0]).toMatch(/powershell vanished/);
});

test("csv rows are appended per connection through deps.appendCsv", async () => {
  const state = makeDeps([
    { conns: [ZCODE_CONN, { ...ZCODE_CONN, ip: "1.2.3.4" }], dns: [] },
  ]);
  await runWatch(
    { procs: ["ZCode"], seconds: 1, csvPath: "D:/tmp/fake.csv" },
    state.deps,
  );
  expect(state.csv).toHaveLength(2);
  expect(state.csv[0]!.path).toBe("D:/tmp/fake.csv");
  // fake clock starts at epoch; unmapped conn -> unknown + DNS note
  expect(state.csv[0]!.line).toBe(
    "1970-01-01T00:00:00.000Z,ZCode,7600,124.160.144.209:443,,unknown,no DNS mapping observed",
  );
});

test("non-Windows platforms are rejected with WatchUnsupportedError", async () => {
  const state = makeDeps([]);
  state.deps.platform = "linux";
  await expect(
    runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps),
  ).rejects.toBeInstanceOf(WatchUnsupportedError);
  await expect(
    runWatch({ procs: ["ZCode"], seconds: 1 }, state.deps),
  ).rejects.toThrow(/Windows-only/);
});

test("csvRow writes the documented column order and escapes CSV metacharacters", () => {
  const at = new Date("2026-09-21T04:01:22.000Z");
  const plain: WatchConn = {
    at,
    proc: "ZCode",
    pid: 7600,
    ip: "124.160.144.209",
    port: 443,
    host: "zcode.z.ai",
    category: "model-api",
    note: null,
  };
  expect(csvRow(plain)).toBe(
    "2026-09-21T04:01:22.000Z,ZCode,7600,124.160.144.209:443,zcode.z.ai,model-api,",
  );
  const messy: WatchConn = {
    ...plain,
    host: null,
    category: "unknown",
    note: 'no DNS mapping, "really"',
  };
  expect(csvRow(messy)).toBe(
    '2026-09-21T04:01:22.000Z,ZCode,7600,124.160.144.209:443,,unknown,"no DNS mapping, ""really"""',
  );
});

test("appendCsvLine writes the header once, then appends rows (fs)", () => {
  const path = join(makeTmpDir("agentaudit-csv-"), "egress.csv");
  appendCsvLine(path, "row1");
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`${CSV_HEADER}\nrow1\n`);
  appendCsvLine(path, "row2");
  expect(readFileSync(path, "utf8")).toBe(`${CSV_HEADER}\nrow1\nrow2\n`);
  // appending to an existing EMPTY file must not lose the header either
  const empty = join(makeTmpDir("agentaudit-csv-"), "empty.csv");
  appendCsvLine(empty, "x");
  expect(statSync(empty).size).toBeGreaterThan(CSV_HEADER.length);
});

test("formatLiveLine matches the documented terminal shape", () => {
  const at = new Date(2026, 8, 21, 12, 1, 22); // local 12:01:22
  const known: WatchConn = {
    at,
    proc: "ZCode",
    pid: 7600,
    ip: "124.160.144.209",
    port: 443,
    host: "zcode.z.ai",
    category: "model-api",
    note: null,
  };
  expect(formatLiveLine(known)).toBe(
    "[12:01:22] ZCode(7600) → 124.160.144.209:443 zcode.z.ai (model-api)",
  );
  const unknown: WatchConn = { ...known, host: null, category: "unknown", note: "no DNS mapping observed" };
  expect(formatLiveLine(unknown)).toBe(
    "[!] [12:01:22] ZCode(7600) → 124.160.144.209:443 (unknown — no DNS mapping observed)",
  );
});

test("renderWatchSummary reports counts by category and process", () => {
  const at = new Date(2026, 8, 21, 12, 1, 22);
  const connections: WatchConn[] = [
    { at, proc: "ZCode", pid: 1, ip: "1.1.1.1", port: 443, host: "zcode.z.ai", category: "model-api", note: null },
    { at, proc: "ZCode", pid: 1, ip: "2.2.2.2", port: 443, host: "o.x.alicdn.com", category: "captcha", note: null },
    { at, proc: "QoderCN", pid: 2, ip: "9.9.9.9", port: 8443, host: null, category: "unknown", note: "no DNS mapping observed" },
  ];
  const summary = renderWatchSummary(
    {
      procs: ["ZCode", "QoderCN"],
      seconds: 15,
      elapsedMs: 15040,
      polls: 20,
      pollErrors: 0,
      dnsEntries: 4,
      connections,
      byCategory: { "model-api": 1, captcha: 1, unknown: 1 },
      byProc: { ZCode: 2, QoderCN: 1 },
      unknownTargets: ["9.9.9.9:8443 (QoderCN)"],
    },
    "D:\\tmp\\egress.csv",
  );
  expect(summary).toContain("──── agent-audit watch ────");
  expect(summary).toContain(
    "watched 15s · procs 2 · polls 20 · new connections 3 · dns entries 4\n",
  );
  expect(summary).toContain("by category: model-api 1 · captcha 1 · unknown 1\n");
  expect(summary).toContain("by process: ZCode 2 · QoderCN 1\n");
  expect(summary).toContain("[!] unknown targets: 9.9.9.9:8443 (QoderCN)\n");
  expect(summary).toContain("csv: D:\\tmp\\egress.csv\n");
  expect(summary).not.toContain("poll errors"); // zero poll errors: no line noise
});

test("renderWatchSummary handles the empty watch and poll errors", () => {
  const summary = renderWatchSummary({
    procs: ["ZCode"],
    seconds: 15,
    elapsedMs: 15010,
    polls: 0,
    pollErrors: 2,
    dnsEntries: 0,
    connections: [],
    byCategory: {},
    byProc: {},
    unknownTargets: [],
  });
  expect(summary).toContain("new connections 0");
  expect(summary).not.toContain("by category");
  expect(summary).not.toContain("by process");
  expect(summary).toContain("poll errors 2");
});

test("DEFAULT_WATCH_PROCS covers the AI tools seen on this machine, .exe-free", () => {
  expect(DEFAULT_WATCH_PROCS.length).toBeGreaterThanOrEqual(8);
  for (const name of DEFAULT_WATCH_PROCS) {
    expect(name, name).not.toMatch(/\.exe$/i);
    expect(name.length, name).toBeGreaterThan(0);
  }
  expect(DEFAULT_WATCH_PROCS).toContain("ZCode");
  expect(DEFAULT_WATCH_PROCS).toContain("QoderCN");
  expect(DEFAULT_WATCH_PROCS).toContain("claude");
  expect(DEFAULT_WATCH_PROCS).toContain("codex");
  expect(new Set(DEFAULT_WATCH_PROCS).size).toBe(DEFAULT_WATCH_PROCS.length);
});

test("parseWatchProcs trims, strips .exe, drops empties and dedupes", () => {
  expect(parseWatchProcs("ZCode.exe, claude ,codex,a.EXE,,a")).toEqual([
    "ZCode",
    "claude",
    "codex",
    "a",
  ]);
  expect(parseWatchProcs("")).toEqual([]);
  expect(parseWatchProcs(" , ,")).toEqual([]);
  expect(parseWatchProcs("Trae CN")).toEqual(["Trae CN"]);
});
