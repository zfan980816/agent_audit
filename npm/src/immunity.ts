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

// Spec M7 rule 2: well-known build/artifact directory SEGMENTS (matched per
// path segment, so relative forms like `rm -rf node_modules` and absolute
// forms like `rm -rf D:/proj/target` both qualify; lookalikes such as
// `target-dir` do not).
export const ARTIFACT_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "out", ".next", "target", "__pycache__",
  ".venv", "venv", "coverage", ".gradle", ".cache", ".turbo", "bin", "obj",
]);

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
function isCoveredBy(target: string, written: ReadonlySet<string>): boolean {
  if (isRootLike(target)) {
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
  return target.split("/").some((seg) => ARTIFACT_DIR_SEGMENTS.has(seg));
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
