// v0.4.1: --canary mode — detect AI tools secretly scanning local projects.
// TDD: this file was written BEFORE src/canary.ts (red -> green). The scan
// logic is a faithful port of tools/monitoring/canary-check.mjs (the proven
// monitoring-stack script). Fixtures live under os.tmpdir ONLY: unit tests
// never write into real tool data dirs and — via the `stores` override —
// never even READ them (the real D:\app\qoder-cn walk is minutes of I/O).
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  DEFAULT_MARKER,
  DEFAULT_STORES,
  MAX_DEPTH,
  MAX_FILE_BYTES,
  buildRegistry,
  canaryCheck,
  canaryExitCode,
  defaultCanaryDir,
  markerScanner,
  renderCanary,
  selfTest,
} from "../src/canary.js";
import { main, type MainIo } from "../src/cli.js";
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

// --- fixtures (tmpdir only) ---------------------------------------------------------

function makeCanaryProject(root: string, marker = DEFAULT_MARKER): string {
  const dir = join(root, "canary-project");
  mkdirSync(dir);
  writeFileSync(join(dir, "README.md"), "# demo-inventory-sync\n\nthrowaway project\n");
  writeFileSync(join(dir, "CANARY.txt"), `canary-marker: ${marker}\n`);
  return dir;
}

interface StoreOpts {
  dirty?: boolean;
  marker?: string;
  includeNodeModules?: boolean;
}

function makeStore(root: string, name: string, opts: StoreOpts = {}): string {
  const dir = join(root, name);
  mkdirSync(dir);
  if (opts.dirty) {
    const marker = opts.marker ?? DEFAULT_MARKER;
    // plain-text hit (how a tool would transcribe the project file)
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({ note: `indexed file mentioning ${marker} today` }),
    );
    // >64KB binary-ish store blob with the marker MID-FILE — proves the
    // latin1 byte-safe scan sees past leading binary noise (the script's
    // whole point vs a text-grep).
    const blob = Buffer.alloc(128 * 1024, 0xff);
    blob.write(marker, 100_000, "latin1");
    writeFileSync(join(dir, "vector-store.zap"), blob);
  } else {
    writeFileSync(join(dir, "session.json"), JSON.stringify({ note: "nothing to see" }));
  }
  if (opts.includeNodeModules) {
    // the walk skips these by name — buried markers must stay invisible
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "junk.txt"), `buried ${DEFAULT_MARKER}`);
  }
  return dir;
}

// --- lib: scan ----------------------------------------------------------------------

test("dirty store: marker found in text and mid-file inside a >64KB binary blob", () => {
  const root = makeTmpDir("agentaudit-canary-dirty-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore", { dirty: true });
  const report = canaryCheck({ canaryDir, stores: [["TestTool", store]] });
  expect(report.status).toBe("DIRTY");
  expect(report.checked).toBe(1);
  expect(report.selfTestPassed).toBe(true);
  expect(report.marker).toBe(DEFAULT_MARKER);
  expect(report.canaryDir).toBe(canaryDir);
  const hits = report.stores[0]!.hits;
  expect(hits.length).toBe(2);
  expect(hits.some((h) => h.includes("session.json"))).toBe(true);
  // the binary hit carries its byte offset (script format: "<path> @byte<N>")
  const blobHit = hits.find((h) => h.includes("vector-store.zap"));
  expect(blobHit).toBeDefined();
  expect(blobHit).toContain("@byte100000");
});

test("clean store: CLEAN, detector self-test passed", () => {
  const root = makeTmpDir("agentaudit-canary-clean-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore");
  const report = canaryCheck({ canaryDir, stores: [["TestTool", store]] });
  expect(report.status).toBe("CLEAN");
  expect(report.checked).toBe(1);
  expect(report.selfTestPassed).toBe(true);
  expect(report.stores[0]!.exists).toBe(true);
  expect(report.stores[0]!.hits).toEqual([]);
});

test("missing canary project -> NO_CANARY (checked 0)", () => {
  const root = makeTmpDir("agentaudit-canary-nocanary-");
  const store = makeStore(root, "toolstore");
  const report = canaryCheck({
    canaryDir: join(root, "nope"),
    stores: [["TestTool", store]],
  });
  expect(report.status).toBe("NO_CANARY");
  expect(report.checked).toBe(0);
});

test("missing store dir is reported as not installed and unchecked", () => {
  const root = makeTmpDir("agentaudit-canary-absent-");
  const canaryDir = makeCanaryProject(root);
  const report = canaryCheck({
    canaryDir,
    stores: [["AbsentTool", join(root, "not-installed")]],
  });
  expect(report.status).toBe("CLEAN");
  expect(report.checked).toBe(0);
  expect(report.stores[0]!.exists).toBe(false);
});

test("marker override: a per-machine marker is honored end to end", () => {
  const root = makeTmpDir("agentaudit-canary-marker-");
  const custom = "ZCANARY-DEADBEEF-1234";
  const canaryDir = makeCanaryProject(root, custom);
  const store = makeStore(root, "toolstore", { dirty: true, marker: custom });
  // default marker store must NOT trip the custom-marker scan
  const other = makeStore(root, "otherstore", { dirty: true });
  const report = canaryCheck({
    canaryDir,
    marker: custom,
    stores: [
      ["TestTool", store],
      ["OtherTool", other],
    ],
  });
  expect(report.status).toBe("DIRTY");
  expect(report.marker).toBe(custom);
  expect(report.stores[0]!.hits.length).toBe(2);
  expect(report.stores[1]!.hits.length).toBe(0);
});

test("extraStores append to the defaults; stores replaces them", () => {
  // registry merge is a pure helper — testable without touching any fs
  expect(buildRegistry({})).toEqual(DEFAULT_STORES);
  const withExtra = buildRegistry({ extraStores: [["Fix", "X:\\fix"]] });
  expect(withExtra.slice(0, DEFAULT_STORES.length)).toEqual(DEFAULT_STORES);
  expect(withExtra.at(-1)).toEqual(["Fix", "X:\\fix"]);
  // full replacement: extras append to the REPLACEMENT, defaults drop out
  expect(buildRegistry({ stores: [], extraStores: [["Fix", "X:\\fix"]] })).toEqual([
    ["Fix", "X:\\fix"],
  ]);
  // case-insensitive path dedupe (NTFS: same dir, different casing)
  const deduped = buildRegistry({
    stores: [
      ["A", "D:\\Tools\\Qoder"],
      ["B", "d:/tools/qoder"],
    ],
  });
  expect(deduped).toEqual([["A", "D:\\Tools\\Qoder"]]);
});

test("extraStores participate in the scan (fixtures only)", () => {
  const root = makeTmpDir("agentaudit-canary-extra-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore", { dirty: true });
  // stores: [] replaces the defaults entirely -> only the extra store scans
  const replaced = canaryCheck({ canaryDir, stores: [], extraStores: [["Fix", store]] });
  expect(replaced.status).toBe("DIRTY");
  expect(replaced.stores.map((s) => s.name)).toEqual(["Fix"]);
});

test("walk skips node_modules by name", () => {
  const root = makeTmpDir("agentaudit-canary-nm-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore", { includeNodeModules: true });
  const report = canaryCheck({ canaryDir, stores: [["TestTool", store]] });
  expect(report.status).toBe("CLEAN");
});

test("depth bound: files beyond MAX_DEPTH levels are not scanned", () => {
  const root = makeTmpDir("agentaudit-canary-depth-");
  const canaryDir = makeCanaryProject(root);
  // chain d1..d9 under the store with the marker ONLY in d9: walk() enters a
  // dir at depth 9 and returns immediately (9 > MAX_DEPTH), so the file is
  // never even stat'ed.
  const store = makeStore(root, "toolstore");
  let dir = store;
  for (let i = 1; i <= 9; i++) {
    dir = join(dir, `d${i}`);
    mkdirSync(dir);
  }
  writeFileSync(join(dir, "deep9.txt"), DEFAULT_MARKER);
  const beyond = canaryCheck({ canaryDir, stores: [["TestTool", store]] });
  expect(beyond.status).toBe("CLEAN"); // depth-9 marker invisible

  // boundary positive: same chain one level shorter — a file inside d8 sits
  // at depth 8 (its containing dir is walked at depth 8 <= MAX_DEPTH) and
  // IS found.
  const store8 = makeStore(root, "toolstore8");
  let dir8 = store8;
  for (let i = 1; i <= 8; i++) {
    dir8 = join(dir8, `d${i}`);
    mkdirSync(dir8);
  }
  writeFileSync(join(dir8, "deep8.txt"), DEFAULT_MARKER);
  const atLimit = canaryCheck({ canaryDir, stores: [["TestTool", store8]] });
  expect(atLimit.status).toBe("DIRTY"); // boundary: depth-8 marker IS found
  expect(atLimit.stores[0]!.hits[0]).toContain("deep8.txt");
});

test("bounds constants match the proven script (depth 8, 256MB cap)", () => {
  expect(MAX_DEPTH).toBe(8);
  expect(MAX_FILE_BYTES).toBe(256 * 1024 * 1024);
});

// --- lib: positive self-test --------------------------------------------------------

test("selfTest: the real scanner rings the planted bell; a broken one fails", () => {
  // positive control through the REAL walk/scanFile path (same as production)
  expect(selfTest(markerScanner(DEFAULT_MARKER))).toBe(true);
  // a detector that finds nothing must fail the bell test
  expect(selfTest(() => {})).toBe(false);
  // marker override is honored by the planted fixture too
  expect(selfTest(markerScanner("MARKER-X"), "MARKER-X")).toBe(true);
  expect(selfTest(markerScanner("MARKER-X"), "MARKER-Y")).toBe(false);
});

test("default canary dir is homedir-relative (no machine-specific path in the lib)", () => {
  expect(defaultCanaryDir()).toBe(join(homedir(), "canary-project"));
});

// --- exit-code mapping --------------------------------------------------------------

test("canaryExitCode: CLEAN 0 / DIRTY 1 / NO_CANARY 2 / SELFTEST_FAILED 3", () => {
  expect(canaryExitCode("CLEAN")).toBe(0);
  expect(canaryExitCode("DIRTY")).toBe(1);
  expect(canaryExitCode("NO_CANARY")).toBe(2);
  expect(canaryExitCode("SELFTEST_FAILED")).toBe(3);
});

// --- render -------------------------------------------------------------------------

test("renderCanary: per-store lines, Trae caveat, self-test line, verdict + RESULT", () => {
  const root = makeTmpDir("agentaudit-canary-render-");
  const canaryDir = makeCanaryProject(root);
  const dirty = makeStore(root, "dirtytool", { dirty: true });
  const clean = makeStore(root, "cleantool");
  const report = canaryCheck({
    canaryDir,
    stores: [
      ["Trae", dirty],
      ["Cursor(CLI)", clean],
      ["Kimi-Code", join(root, "absent")],
    ],
  });
  const text = renderCanary(report);
  expect(text).toContain(canaryDir);
  expect(text).toContain(DEFAULT_MARKER);
  expect(text).toContain("Trae");
  expect(text).toContain("encrypted"); // honesty footnote about Trae's db
  expect(text).toContain("not installed"); // missing store line
  expect(text).toContain("self-test");
  expect(text).toContain("RESULT:DIRTY");
  // hits truncated in terminal output (report carries all; render shows <=5)
  expect(text.split("@byte").length - 1).toBeLessThanOrEqual(5);
});

// --- CLI wiring ---------------------------------------------------------------------

test("cli --canary dirty fixture: exit 1, RESULT:DIRTY, tool named", async () => {
  const root = makeTmpDir("agentaudit-canary-cli1-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore", { dirty: true });
  const io: Captured & MainIo = {
    ...capture(),
    canaryStores: [["FixTool", store]],
  };
  const code = await main(["--canary", "--canary-dir", canaryDir], io);
  expect(code).toBe(1);
  expect(io.out()).toContain("RESULT:DIRTY");
  expect(io.out()).toContain("FixTool");
});

test("cli --canary clean fixture: exit 0, RESULT:CLEAN", async () => {
  const root = makeTmpDir("agentaudit-canary-cli2-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore");
  const io: Captured & MainIo = {
    ...capture(),
    canaryStores: [["FixTool", store]],
  };
  const code = await main(["--canary", "--canary-dir", canaryDir], io);
  expect(code).toBe(0);
  expect(io.out()).toContain("RESULT:CLEAN");
  expect(io.out()).toContain("self-test");
});

test("cli --canary with missing canary dir: friendly error, exit 2, recipe hint", async () => {
  const root = makeTmpDir("agentaudit-canary-cli3-");
  const io = capture();
  const code = await main(["--canary", "--canary-dir", join(root, "nope")], io);
  expect(code).toBe(2);
  expect(io.err()).toContain("canary project not found");
  expect(io.err()).toContain("--marker"); // points at the recipe
});

test("cli --canary --json: stdout parses as the report object, no RESULT line", async () => {
  const root = makeTmpDir("agentaudit-canary-cli4-");
  const canaryDir = makeCanaryProject(root);
  const store = makeStore(root, "toolstore", { dirty: true });
  const io: Captured & MainIo = {
    ...capture(),
    canaryStores: [["FixTool", store]],
  };
  const code = await main(["--canary", "--canary-dir", canaryDir, "--json"], io);
  expect(code).toBe(1);
  const data = JSON.parse(io.out());
  expect(data.status).toBe("DIRTY");
  expect(data.selfTestPassed).toBe(true);
  expect(data.stores[0].hits.length).toBe(2);
  expect(data.marker).toBe(DEFAULT_MARKER);
  expect(io.out()).not.toContain("RESULT:");
});

test("cli --marker override reaches the scanner", async () => {
  const root = makeTmpDir("agentaudit-canary-cli5-");
  const custom = "ZCANARY-CAFEF00D-5678";
  const canaryDir = makeCanaryProject(root, custom);
  const store = makeStore(root, "toolstore", { dirty: true, marker: custom });
  const io: Captured & MainIo = {
    ...capture(),
    canaryStores: [["FixTool", store]],
  };
  const code = await main(
    ["--canary", "--canary-dir", canaryDir, "--marker", custom],
    io,
  );
  expect(code).toBe(1);
  expect(io.out()).toContain(custom);
  expect(io.out()).toContain("RESULT:DIRTY");
});
