// M7 (v0.3.x, TS-canonical): creator-immunity downgrade for D001.
// Python is frozen at v0.1.1 and has no counterpart — the equivalence harness
// keeps this a TS-only behavior (corpora avoid exempt patterns; per-finding
// `note` is normalized out of the parity comparison).
//
// Three exemption families, all D001-only (spec rule 3: D002-D005 and every
// E/C/B/U rule NEVER downgrade — privacy signals stay at full severity):
//   1. write provenance: the deleted targets are covered by the paths this
//      session created earlier in the same audit run (stream order, like
//      E005's state) — FileWrite paths AND M7v2 Bash-creation outputs
//      (mkdir/touch/redirect/tee/cp/mv/git clone/curl -o; see
//      extractCreatedPaths) → info +「删除的是本会话创建的内容(回退/清理)」
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
// mistake for targets (lowercase compare). M7v2 adds the bash-creation verbs
// plus the ubiquitous chain fillers (echo/cd): a same-line chain like
// `mkdir /tmp/x && rm -rf /tmp/x` must not keep the word "mkdir" as a delete
// target (which would rightly refuse coverage). Arguments of those chained
// commands are still extracted, so `mkdir /other && rm -rf /tmp/x` stays
// critical (the unrelated /other target does not qualify).
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "rm", "rd", "del", "erase", "rmdir", "remove-item", "sudo", "git",
  "mkdir", "touch", "tee", "cp", "mv", "curl", "wget", "echo", "cd",
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

// ---------------------------------------------------------------------------
// M7v2: bash-creation provenance. Parse a Bash command line for the paths it
// CREATES, so outputs of mkdir/touch/redirect/tee/cp/mv/git clone/curl -o
// count as "agent-created" for family 1 (the user-reported
// 「他创建了内容又删除了」 pattern mostly happens via Bash, not Write).
// This is provenance extraction, NOT a shell emulator: unknown forms simply
// produce no provenance (fail-closed), and the same crude-tokenizer
// discipline as extractDeleteTargets applies (whitespace split, quoted paths
// containing spaces are not understood).

// Bit-bucket redirect targets create nothing usable.
const DEVNULL_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "nul"]);

function stripQuotes(t: string): string {
  return t.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

function isFlagToken(t: string): boolean {
  return t.startsWith("-") || WINDOWS_SWITCH.test(t);
}

// Split a command line into segments on `&&`, `||`, `;`, `|`, `&` and newline.
// Quotes are respected ("a && b" stays one segment). `|` vs `||` and `&` vs
// `&&` each split once. A `&` DIRECTLY after `>` is an fd dup (`2>&1`), not a
// separator.
function splitCommandSegments(raw: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    if (ch === ";") {
      segs.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&" || ch === "|") {
      if (ch === "&" && cur.trimEnd().slice(-1) === ">") {
        cur += ch; // 2>&1 — fd duplication, not a command separator
        continue;
      }
      segs.push(cur);
      cur = "";
      if (raw[i + 1] === ch) {
        i += 1; // && / || consume both characters
      }
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

// M7v2 design: relative creations resolve against the creating command's cwd
// (engine passes ShellCommand.cwd); null cwd keeps them relative, and a
// relative result then only matches a relative delete target (same as today).
function resolveAgainstCwd(p: string, cwd: string | null): string {
  if (!cwd || isAnchored(p)) {
    return p;
  }
  const base = normalizeForCompare(cwd);
  if (isRootLike(base)) {
    return p;
  }
  return `${base}/${p.replace(/^(?:\.\/)+/, "")}`;
}

// Redirect targets share the creation filters; junk tokens (`&2` fd dups,
// flags, bit buckets, anything with leftover operators) never count.
function pushCreatedTarget(t: string, created: string[], cwd: string | null): void {
  if (!t || t.includes(">") || t.includes("<")) {
    return;
  }
  if (t.startsWith("&") || t.startsWith("-")) {
    return;
  }
  if (DEVNULL_TARGETS.has(t.toLowerCase())) {
    return;
  }
  created.push(resolveAgainstCwd(t, cwd));
}

// git clone without an explicit dir creates basename(url) minus .git
// (https and scp forms both end in a "/"-separated project name).
function gitCloneBasename(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/i, "");
}

// Scan ONE segment: extract redirect-created paths (pushed into `created`)
// and return the positional args for the command-form dispatch below.
// Redirect anatomy per token: [fd prefix][> or >>][target] — fd-prefixed
// forms (`2>`, `&>`, `2>&1`) are skipped whole, bare `>`/`>>` take the NEXT
// token as target, attached `>f`/`>>f` take the token tail.
function scanSegment(
  seg: string,
  created: string[],
  cwd: string | null,
): string[] {
  const args: string[] = [];
  let expectRedirectTarget = false;
  for (const tok of seg.trim().split(/\s+/)) {
    if (!tok) {
      continue;
    }
    if (expectRedirectTarget) {
      expectRedirectTarget = false;
      pushCreatedTarget(stripQuotes(tok), created, cwd);
      continue;
    }
    const m = /^([\d&]*)(>>?)(.*)$/.exec(tok);
    if (!m) {
      args.push(stripQuotes(tok));
      continue;
    }
    if (m[1]) {
      continue; // fd-prefixed (2>, &>, 2>&1, &>): token AND target skipped
    }
    if (!m[3]) {
      expectRedirectTarget = true; // bare > / >> as its own token
      continue;
    }
    pushCreatedTarget(stripQuotes(m[3]), created, cwd); // attached >f / >>f
  }
  return args;
}

// Command-form dispatch (high-frequency forms only). `args[0]` is the command
// word; every form resolves through pushCreatedTarget, so cwd resolution and
// the junk filters apply uniformly.
function commandCreatedPaths(
  args: string[],
  created: string[],
  cwd: string | null,
): void {
  const cmd = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1);
  switch (cmd) {
    case "mkdir":
    case "touch":
      for (const a of rest) {
        if (!isFlagToken(a)) {
          pushCreatedTarget(a, created, cwd);
        }
      }
      return;
    case "tee": {
      const f = rest.find((a) => !isFlagToken(a));
      if (f !== undefined) {
        pushCreatedTarget(f, created, cwd);
      }
      return;
    }
    case "cp":
    case "mv": {
      const pos = rest.filter((a) => !isFlagToken(a));
      if (pos.length >= 2) {
        pushCreatedTarget(pos[pos.length - 1]!, created, cwd); // dst only
      }
      return;
    }
    case "git": {
      if ((rest[0] ?? "").toLowerCase() !== "clone") {
        return;
      }
      // value-taking flags consume their argument (--depth 1, -b name) so the
      // value is never mistaken for the url or the destination dir
      const VALUE_FLAGS = new Set([
        "--depth", "-b", "--branch", "--filter", "--separate-git-dir",
        "--template", "-j", "--jobs", "--shallow-since", "--shallow-exclude",
      ]);
      const toks = rest.slice(1);
      const pos: string[] = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]!;
        if (t.startsWith("--") && t.includes("=")) {
          continue; // --depth=1 form
        }
        if (VALUE_FLAGS.has(t)) {
          i++; // skip the flag's value
          continue;
        }
        if (isFlagToken(t)) {
          continue;
        }
        pos.push(t);
      }
      const url = pos[0];
      if (!url) {
        return;
      }
      // dir if given, else basename(url) minus .git
      const dir = pos.length >= 2 ? pos[pos.length - 1]! : gitCloneBasename(url);
      if (dir) {
        pushCreatedTarget(dir, created, cwd);
      }
      return;
    }
    case "curl":
    case "wget": {
      const outFlag = cmd === "curl" ? "-o" : "-O";
      const idx = rest.indexOf(outFlag);
      const file = idx >= 0 ? rest[idx + 1] : undefined;
      if (file !== undefined && !isFlagToken(file)) {
        pushCreatedTarget(file, created, cwd);
      }
      return;
    }
  }
}

// Paths a Bash command line CREATES (M7v2). Segments are split on the shell
// operators first, then each segment is scanned for redirects and for one of
// the creation command forms. Results may be relative (null cwd) or
// cwd-resolved; the engine normalizes them like FileWrite paths.
//
// `beforeFirstDelete` (M7v2 review Issue 1): when set, only creations from
// segments positioned BEFORE the line's first delete command count — a
// delete that runs BEFORE its "creation" (`rm -rf ~/work && mkdir ~/work`)
// must not be whitewashed by provenance from later in the SAME line. Lines
// with no delete keep their full creation set. Mixed lines under-count
// (conservative direction, documented).
export function extractCreatedPaths(
  raw: string,
  cwd: string | null,
  opts?: { beforeFirstDelete?: boolean },
): string[] {
  const segments = splitCommandSegments(raw);
  const limit =
    opts?.beforeFirstDelete === true ? firstDeleteSegment(segments) : segments.length;
  const created: string[] = [];
  for (let s = 0; s < limit && s < segments.length; s++) {
    const trimmed = segments[s]!.trim();
    if (!trimmed) {
      continue;
    }
    const args = scanSegment(trimmed, created, cwd);
    if (args.length > 0) {
      commandCreatedPaths(args, created, cwd);
    }
  }
  return created;
}

// Index of the first segment whose command word is a delete verb (skipping
// env assignments and sudo). segments.length when none.
const DELETE_VERBS: ReadonlySet<string> = new Set([
  "rm", "rd", "del", "erase", "rmdir", "remove-item",
]);
function firstDeleteSegment(segments: string[]): number {
  for (let i = 0; i < segments.length; i++) {
    for (const tok of segments[i]!.trim().split(/\s+/)) {
      if (tok.includes("=")) {
        continue; // env assignment prefix (FOO=1 rm ...)
      }
      const w = tok.toLowerCase();
      if (w === "sudo" || w === "command" || w === "nohup") {
        continue;
      }
      if (DELETE_VERBS.has(w)) {
        return i;
      }
      break; // first real command word — not a delete
    }
  }
  return segments.length;
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

// M7v2 coverage forms for one delete target: its raw (normalized) form plus,
// when the deleting command has a cwd and the target is relative, the
// cwd-resolved absolute form. Creations resolve at creation time
// (extractCreatedPaths), so this symmetric resolution is what lets
// `git clone url` + `rm -rf r` in the same record cwd match; with a null cwd
// only the relative form exists and relative still matches only relative
// (same as today). The artifact-segment family keeps judging the RAW form —
// `Remove-Item bin` must stay exempt while a resolved `D:/cwd/bin` would not.
function targetCoverageForms(target: string, cwd: string | null): string[] {
  const forms = [target];
  if (cwd && !isAnchored(target)) {
    const resolved = normalizeForCompare(resolveAgainstCwd(target, cwd));
    if (resolved !== target) {
      forms.push(resolved);
    }
  }
  return forms;
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
  const event = finding.event instanceof ShellCommand ? finding.event : null;
  const raw = event ? event.raw : "";
  const targets = extractDeleteTargets(raw).map(normalizeForCompare);
  if (targets.length === 0) {
    return;
  }
  // Conservative multi-target semantics: EVERY extracted target must qualify,
  // so `rm -rf ~/Documents node_modules` stays critical.
  const cwd = event ? event.cwd : null;
  if (
    written !== undefined &&
    targets.every((t) =>
      targetCoverageForms(t, cwd).some((f) => isCoveredBy(f, written)),
    )
  ) {
    finding.severity = "info";
    finding.note = EXEMPT_NOTE_SELF_CREATED;
    return;
  }
  if (targets.every((t) => hasArtifactSegment(t))) {
    finding.severity = "info";
    finding.note = EXEMPT_NOTE_BUILD_ARTIFACT;
  }
}
