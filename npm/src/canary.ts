// v0.4.1: canary check — did any AI coding tool secretly scan your local
// projects? Faithful port of tools/monitoring/canary-check.mjs (the proven
// monitoring-stack script) into the first-class `--canary` CLI mode.
//
// THE METHOD: a throwaway "canary" project carries a unique marker string and
// is NEVER opened in any AI tool. The marker appearing inside a tool's data
// directory is hard proof that tool read the project from disk on its own —
// content-level evidence where --watch can only see "who it talks to" (TLS).
//
// PORT NOTES (kept identical to the script, audit notes 2026-09-22):
//   - binary-safe latin1 scan: markers are matched BY BYTE inside text,
//     .zap segment files, sqlite/ldb pages — a text-grep would miss them.
//   - bounds: directory depth 8, single file cap 256MB (ordos repo's 87.7MB
//     .zap would be silently skipped by a smaller cap), stop after 20 hits.
//   - skipped dir names: node_modules, .git, Cache_GPUCache.
//   - store registry includes the ACTIVE Qoder root D:\app\qoder-cn (the
//     old ~/.qoder-cn root stopped updating 08-13 — scanning only it would
//     be a structural false negative) plus the Trae CLI dir ~/.trae-cn and
//     Cursor's CLI dir ~/.cursor. Absent dirs are "not installed", skipped.
//   - positive self-test on EVERY run: a marker is planted in a fresh
//     tmpdir "fake store" and must be found through the real walk path.
//     A detector that cannot ring is not a detector — SELFTEST_FAILED.
//   - honesty footnote: Trae's local db is encrypted; its "clean" only
//     covers readable storage (structural weak evidence, said out loud).
//
// The lib is pure sync fs reading — no process/exit/console here; the CLI
// owns rendering and exit codes (canaryExitCode).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Deploy-time constant: fine for this machine, but every user SHOULD plant a
// per-machine marker (README has the recipe) so a leaked marker string can't
// be recognized across machines. Kept as the default for drop-in continuity
// with tools/monitoring; --marker / opts.marker overrides it.
export const DEFAULT_MARKER = "ZCANARY-7F3A9C21-D4E8";

// Machine-specific canary paths stay OUT of the lib: the default is
// homedir-relative, and the deployed instance (tools/monitoring) passes the
// real path D:\Projects\demo-inventory-sync explicitly via --canary-dir.
export function defaultCanaryDir(): string {
  return join(homedir(), "canary-project");
}

// Scan bounds — identical numbers to the script (see port notes above).
export const MAX_DEPTH = 8;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_HITS = 20;

// Directory names never descended into (script list, verbatim).
const SKIPPED_DIRS = new Set(["node_modules", ".git", "Cache_GPUCache"]);

// Tool data directories scanned read-only for the marker. homedir-based
// except the active Qoder CN install root (see port notes). Users extend via
// extraStores; tests (and power users) replace the whole registry via
// opts.stores.
export const DEFAULT_STORES: Array<[string, string]> = [
  ["Qoder(活跃根)", "D:\\app\\qoder-cn"],
  ["Qoder(旧根)", join(homedir(), ".qoder-cn")],
  ["ZCode(cli)", join(homedir(), ".zcode")],
  ["ZCode(app)", join(homedir(), "AppData", "Roaming", "ZCode")],
  ["Trae", join(homedir(), "AppData", "Roaming", "Trae CN")],
  ["Trae(cli)", join(homedir(), ".trae-cn")],
  ["Kimi-Code", join(homedir(), ".kimi-code")],
  ["Codex", join(homedir(), ".codex")],
  ["Gemini", join(homedir(), ".gemini")],
  ["Cursor(桌面版)", join(homedir(), "AppData", "Roaming", "Cursor")],
  ["Cursor(CLI)", join(homedir(), ".cursor")],
];

export interface CanaryStoreResult {
  name: string;
  dir: string;
  exists: boolean;
  hits: string[]; // "<file> @byte<offset>", one per marker occurrence
}

export type CanaryStatus = "CLEAN" | "DIRTY" | "NO_CANARY" | "SELFTEST_FAILED";

export interface CanaryReport {
  status: CanaryStatus;
  checked: number; // stores that existed and were scanned
  stores: CanaryStoreResult[]; // the whole registry, incl. not-installed
  selfTestPassed: boolean;
  marker: string;
  canaryDir: string;
}

// Binary-safe marker scan of one file: whole file as latin1 (1 byte = 1 char,
// lossless for arbitrary bytes), indexOf loop records every occurrence.
function scanFile(path: string, marker: string, found: string[]): void {
  try {
    const buf = readFileSync(path);
    const s = buf.toString("latin1");
    let idx = s.indexOf(marker);
    while (idx !== -1) {
      found.push(`${path} @byte${idx}`);
      idx = s.indexOf(marker, idx + 1);
    }
  } catch {
    // locked / permission-denied: skip, never crash the walk
  }
}

// Bounded recursive walk (script verbatim: depth 8, 256MB/file, 20 hits).
export function walkStore(
  dir: string,
  marker: string,
  found: string[],
  depth = 0,
): void {
  if (depth > MAX_DEPTH || found.length > MAX_HITS) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIPPED_DIRS.has(e.name)) continue;
      walkStore(p, marker, found, depth + 1);
    } else {
      try {
        if (statSync(p).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      scanFile(p, marker, found);
    }
  }
}

// Production scan function for a given marker (self-test seam + reuse).
export function markerScanner(
  marker: string,
): (dir: string, found: string[]) => void {
  return (dir, found) => walkStore(dir, marker, found);
}

// Positive self-test: plant a marker-bearing "fake store" in a fresh tmpdir
// and ring it through the caller-supplied scan function — the exact walk the
// real scan uses. Returns whether the bell rang. The scan fn is injected so
// tests can unit-test both the working and the broken detector.
export function selfTest(
  scanFn: (dir: string, found: string[]) => void,
  marker: string = DEFAULT_MARKER,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), "agentaudit-canary-selftest-"));
  try {
    writeFileSync(
      join(dir, "fake-store.zap"),
      Buffer.from(`padding-padding-${marker}-padding`, "latin1"),
    );
    const found: string[] = [];
    scanFn(dir, found);
    return found.length > 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Exit codes (script contract): 0 clean, 1 dirty, 2 no canary dir,
// 3 self-test failed (detector broken -> "clean" would be meaningless).
export function canaryExitCode(status: CanaryStatus): 0 | 1 | 2 | 3 {
  switch (status) {
    case "CLEAN":
      return 0;
    case "DIRTY":
      return 1;
    case "NO_CANARY":
      return 2;
    case "SELFTEST_FAILED":
      return 3;
  }
}

function normalizeKey(p: string): string {
  // NTFS is case-insensitive and accepts both separators; dedupe registry
  // entries that resolve to the same dir (script audit note ③).
  return p.toLowerCase().replace(/\//g, "\\");
}

export interface CanaryOptions {
  canaryDir?: string;
  marker?: string;
  // appended to the store registry (DEFAULT_STORES when `stores` is unset)
  extraStores?: Array<[string, string]>;
  // full replacement of the store registry (test seam / power users)
  stores?: Array<[string, string]>;
}

// Pure registry merge (no fs): stores ?? DEFAULT_STORES, extraStores
// appended, first entry wins on case-insensitive path collisions.
export function buildRegistry(opts: CanaryOptions = {}): Array<[string, string]> {
  const registry: Array<[string, string]> = [];
  const seen = new Set<string>();
  const base = opts.stores ?? DEFAULT_STORES;
  for (const entry of [...base, ...(opts.extraStores ?? [])]) {
    const key = normalizeKey(entry[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    registry.push(entry);
  }
  return registry;
}

// Pure, synchronous canary check. Reads the canary project dir (existence
// check only — the marker count display was script sugar) and every
// registered store that exists, then runs the positive self-test.
export function canaryCheck(opts: CanaryOptions = {}): CanaryReport {
  const canaryDir = opts.canaryDir ?? defaultCanaryDir();
  const marker = opts.marker ?? DEFAULT_MARKER;

  const registry = buildRegistry(opts);

  // canary-dir self-check: a deleted canary voids the run's premise
  // (script exited 2 here; the lib reports and the CLI maps to exit 2)
  if (!existsSync(canaryDir)) {
    return {
      status: "NO_CANARY",
      checked: 0,
      stores: registry.map(([name, dir]) => ({ name, dir, exists: false, hits: [] })),
      // the detector is still verified even on a voided run
      selfTestPassed: selfTest(markerScanner(marker), marker),
      marker,
      canaryDir,
    };
  }

  const stores: CanaryStoreResult[] = [];
  let checked = 0;
  for (const [name, dir] of registry) {
    if (!existsSync(dir)) {
      stores.push({ name, dir, exists: false, hits: [] });
      continue;
    }
    checked += 1;
    const found: string[] = [];
    walkStore(dir, marker, found);
    stores.push({ name, dir, exists: true, hits: found });
  }

  // positive self-test ALWAYS runs (cheap, tmpdir-only): every published
  // verdict — clean or dirty — carries proof the detector works.
  const selfTestPassed = selfTest(markerScanner(marker), marker);

  const dirty = stores.some((s) => s.hits.length > 0);
  const status: CanaryStatus = selfTestPassed
    ? dirty
      ? "DIRTY"
      : "CLEAN"
    : // a detector that can't ring voids the whole run (script: exit 3,
      // even when stores were dirty — a mute bell proves nothing either way)
      "SELFTEST_FAILED";

  return { status, checked, stores, selfTestPassed, marker, canaryDir };
}

// --- terminal rendering ---------------------------------------------------------------

export function renderCanary(report: CanaryReport): string {
  const lines: string[] = [];
  lines.push("──── agent-audit canary ────");
  lines.push(
    `canary project: ${report.canaryDir} (you never opened it in any AI tool)`,
  );
  lines.push(`marker: ${report.marker}`);
  lines.push("");
  for (const s of report.stores) {
    if (!s.exists) {
      lines.push(`  · ${s.name}: not installed, skipped`);
    } else if (s.hits.length > 0) {
      lines.push(
        `  🚨 ${s.name}: marker found x${s.hits.length} — it scanned your canary project!`,
      );
      for (const h of s.hits.slice(0, 5)) {
        lines.push(`      ${h}`);
      }
    } else {
      lines.push(`  ✓ ${s.name}: clean`);
    }
  }
  // honesty footnote: Trae's local db is encrypted — "clean" is weak evidence
  const trae = report.stores.find((s) => s.name === "Trae" && s.exists);
  if (trae) {
    lines.push(
      '  note: Trae\'s local db is encrypted — its "clean" only covers readable storage.',
    );
  }
  lines.push("");
  lines.push(
    report.selfTestPassed
      ? "  self-test: planted marker found — the detector rings (positive control)"
      : "  self-test: FAILED — the scanner cannot find the marker it planted itself",
  );
  switch (report.status) {
    case "DIRTY": {
      const dirty = report.stores.filter((s) => s.hits.length > 0);
      lines.push(
        `verdict: 🚨 ${dirty.length} tool(s) read your canary project without you opening it — covert disk scanning confirmed.`,
      );
      lines.push("        the files listed above are the evidence (marker offsets); screenshot them.");
      break;
    }
    case "CLEAN":
      lines.push(
        `verdict: ✅ checked ${report.checked} tool(s) — none touched your canary project. (self-test passed)`,
      );
      break;
    case "SELFTEST_FAILED":
      lines.push(
        'verdict: ⛔ detector self-test failed — this run\'s "clean" verdict would be meaningless.',
      );
      break;
    case "NO_CANARY":
      lines.push(
        `verdict: ⚠ canary project not found at ${report.canaryDir} — recreate it (see the canary recipe in the README).`,
      );
      break;
  }
  lines.push(`RESULT:${report.status}`);
  return lines.map((l) => `${l}\n`).join("");
}
