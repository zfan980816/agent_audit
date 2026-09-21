// M7 (v0.3.x, TS-canonical): creator-immunity downgrade for D001.
// Python is frozen at v0.1.1 and has no counterpart — the equivalence harness
// keeps this a TS-only behavior (corpora avoid exempt patterns; per-finding
// `note` is normalized out of the parity comparison).
//
// Two exemption families, both D001-only (spec rule 3: D002-D005 and every
// E/C/B/U rule NEVER downgrade — privacy signals stay at full severity):
//   1. write provenance: the deleted targets are covered by the paths this
//      session wrote earlier in the same audit run (stream order, like E005's
//      state) → info +「删除的是本会话创建的内容(回退/清理)」
//   2. build artifacts: every deleted target has a path segment in the
//      well-known artifact-dir set → info +「删除的是构建产物目录」
import { ShellCommand } from "./events.js";
import type { Finding } from "./rules/base.js";

// Spec M7 rule 2: well-known build/artifact directory SEGMENTS. Two review
// hardenings (M7 review F1/F2):
//  - generic short segments that collide with SYSTEM dirs ("bin", "obj",
//    "out") are matched only as the FINAL path segment, everything else
//    matches on any segment (relative `rm -rf build` and absolute
//    `D:/proj/target` both qualify; lookalikes such as `target-dir` do not).
export const ARTIFACT_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "out", ".next", "target", "__pycache__",
  ".venv", "venv", "coverage", ".gradle", ".cache", ".turbo", "bin", "obj",
]);
// Segments too generic to trust mid-path ("/usr/bin", "~/Documents/out").
const FINAL_ONLY_SEGMENTS: ReadonlySet<string> = new Set(["bin", "obj", "out"]);

// System locations where a deletion is NEVER exempt regardless of
// provenance — a single sacrificial write (M7 review F1: write /etc/x then
// `rm -rf /etc`) must not whitewash mass deletion of pre-existing trees.
// /home and /Users are blocked only at TOP level (rm -rf /home/u is mass
// user deletion; rm -rf /home/u/proj is an ordinary project worksite).
const SYSTEM_PREFIXES: readonly string[] = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/lib", "/lib64",
  "/boot", "/dev", "/proc", "/sys", "/root",
  "/windows", "/program files", "/program files (x86)", "/programdata",
  "/system volume information",
];
const HOME_ROOTS: readonly string[] = ["/home", "/users"];

function isSystemPath(target: string): boolean {
  if (isRootLike(target)) {
    return true;
  }
  // strip a drive-letter anchor so C:/Windows compares as /windows
  const t = target.toLowerCase().replace(/^[a-z]:/, "");
  if (SYSTEM_PREFIXES.some((p) => t === p || t.startsWith(p + "/"))) {
    return true;
  }
  for (const h of HOME_ROOTS) {
    if (t === h) {
      return true;
    }
    if (t.startsWith(h + "/")) {
      const rest = t.slice(h.length + 1);
      return !rest.includes("/"); // exactly one level below home root
    }
  }
  return false;
}

// A target is "anchored" when it names an absolute location (root, drive
// letter, or ~). Generic artifact segments (bin/obj/out) only exempt BARE
// RELATIVE targets — the project-local form the agent actually cleans;
// `~/Documents/out` or `/usr/bin`-style absolute names never qualify.
function isAnchored(target: string): boolean {
  return target.startsWith("/") || target.startsWith("~") || /^[a-zA-Z]:/.test(target);
}

export const EXEMPT_NOTE_SELF_CREATED = "删除的是本会话创建的内容(回退/清理)";
export const EXEMPT_NOTE_BUILD_ARTIFACT = "删除的是构建产物目录";

// Delete-command words and shell punctuation the crude tokenizer must not
// mistake for targets (lowercase compare).
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "rm", "rd", "del", "erase", "rmdir", "remove-item", "sudo", "git",
]);
const SHELL_PUNCT: ReadonlySet<string> = new Set([
  "&&", "||", ";", "|", "&", ">", ">>", "<", "(", ")", "{", "}",
]);

// Windows switches look like `/s`, `/q`, `/im` — a slash plus 1-2 letters
// and nothing else. Longer `/`-prefixed tokens are POSIX paths (`/tmp`,
// `/home/x`) and must survive as targets.
const WINDOWS_SWITCH = /^\/[a-zA-Z]{1,2}$/;

// Crude target extraction (spec M7): split on whitespace, drop flags (`-r`,
// `--force`) and Windows switches (`/s`, `/q`), strip surrounding quotes and
// trailing globs, then drop the delete-command words themselves, shell
// punctuation and redirection tokens. What survives is treated as a path
// target (absolute, relative or bare name).
export function extractDeleteTargets(raw: string): string[] {
  const targets: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (!token || token.startsWith("-") || WINDOWS_SWITCH.test(token)) {
      continue; // flags and /s /q style switches
    }
    let t = token.replace(/^['"]+/, "").replace(/['"]+$/, "");
    t = t.replace(/\*+$/, ""); // trailing globs: dir/* -> dir/
    t = t.replace(/[;|&]+$/, ""); // trailing command separators
    if (!t || t.includes(">") || t.includes("<")) {
      continue; // empty after stripping, or a redirection token
    }
    if (COMMAND_WORDS.has(t.toLowerCase()) || SHELL_PUNCT.has(t)) {
      continue;
    }
    targets.push(t);
  }
  return targets;
}

// Comparison normalization: backslashes to slashes, trailing slashes dropped.
// (No case folding: over-matching an exemption is the dangerous direction.)
export function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

// Filesystem-root-like targets are never provenance-covered: with P = "/" or
// "C:" every written path would be "under" P, wrongly exempting `rm -rf /`.
function isRootLike(p: string): boolean {
  return p === "" || p === "/" || p === "~" || /^[a-zA-Z]:$/.test(p);
}

// Spec M7 rule 1 coverage: W === P, W under P (agent wrote files inside a dir
// it now removes), or P under W (agent wrote the parent, now removes deeper).
// System paths are never covered (review F1).
function isCoveredBy(target: string, written: ReadonlySet<string>): boolean {
  if (isRootLike(target) || isSystemPath(target)) {
    return false;
  }
  for (const w of written) {
    if (w === target || w.startsWith(target + "/") || target.startsWith(w + "/")) {
      return true;
    }
  }
  return false;
}

function hasArtifactSegment(target: string): boolean {
  if (isSystemPath(target)) {
    return false; // review F2: /usr/bin, /bin, C:/Windows are never artifacts
  }
  const segments = target.split("/").filter(Boolean);
  const anchored = isAnchored(target);
  return segments.some((seg) => {
    if (!ARTIFACT_DIR_SEGMENTS.has(seg)) {
      return false;
    }
    // generic segments (bin/obj/out) qualify only for BARE RELATIVE targets
    // (./bin, out) — the project-local cleanup form; absolute names never
    if (FINAL_ONLY_SEGMENTS.has(seg)) {
      return !anchored;
    }
    return true;
  });
}

// Mutates `finding` in place when the exemption applies. Called by the engine
// right after rule.check() and BEFORE the severity sort, so both the sort and
// by_severity naturally reflect the downgrade.
export function applyCreatorImmunity(
  finding: Finding,
  written: ReadonlySet<string> | undefined,
): void {
  if (finding.ruleId !== "D001") {
    return; // spec rule 3: only D001 participates
  }
  const raw = finding.event instanceof ShellCommand ? finding.event.raw : "";
  const targets = extractDeleteTargets(raw).map(normalizeForCompare);
  if (targets.length === 0) {
    return;
  }
  // Conservative multi-target semantics: EVERY extracted target must qualify,
  // so `rm -rf ~/Documents node_modules` stays critical.
  if (written !== undefined && targets.every((t) => isCoveredBy(t, written))) {
    finding.severity = "info";
    finding.note = EXEMPT_NOTE_SELF_CREATED;
    return;
  }
  if (targets.every((t) => hasArtifactSegment(t))) {
    finding.severity = "info";
    finding.note = EXEMPT_NOTE_BUILD_ARTIFACT;
  }
}
