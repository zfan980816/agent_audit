// Locate local agent session files.
// Faithful port of src/agentaudit/discovery.py (Python is the spec).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Python: class DataDirNotFound(FileNotFoundError). The message carries the
// CLI hints (the "WSL" hint is asserted by tests).
export class DataDirNotFoundError extends Error {}

export function defaultClaudeProjectsDir(): string {
  // Python: Path.home() / ".claude" / "projects"
  return join(homedir(), ".claude", "projects");
}

// Python: root.rglob("*.jsonl") semantics:
// - the "*.jsonl" pattern is case-sensitive (pathlib glob does not fold case)
// - directory recursion does not follow symlinked directories
// - a *directory* named "x.jsonl" is descended into, never collected
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.isSymbolicLink()) {
        walk(full, out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

export function findSessionFiles(root?: string | null): string[] {
  // Python: root = root or default_claude_projects_dir()  (falsy -> default)
  const base = root || defaultClaudeProjectsDir();
  if (!existsSync(base)) {
    throw new DataDirNotFoundError(
      `Claude Code data directory not found: ${base}\n` +
      "Hints:\n" +
      "  - pass an explicit path: agentaudit <path>\n" +
      "  - if Claude Code runs inside WSL, the dir lives under\n" +
      "    \\\\wsl$\\<distro>\\home\\<user>\\.claude\\projects",
    );
  }
  // Python: sorted(p for p in root.rglob("*.jsonl") if p.is_file())
  const files: string[] = [];
  walk(base, files);
  return files.sort(comparePaths);
}

// Python sorted(paths) orders pathlib.Path objects element-wise over the
// os.path.normcase()-folded parts (`_parts_normcase`, py3.12+; `_cparts` on
// <=3.11): lowercased on win32, identity on POSIX; prefix-shorter-first.
// This is NOT a joined-string sort: "p/uuid.jsonl" vs "p/uuid/subagents/
// a.jsonl" flips ("." < "\" on the string, prefix rule on the parts) and
// case-folded "C--"/"c--" dirs interleave. Real Claude Code data contains
// both shapes (T8 real-data gate regression).
function comparePaths(a: string, b: string): number {
  const fold =
    process.platform === "win32"
      ? (s: string) => s.toLowerCase()
      : (s: string) => s;
  const A = a.split(/[\\/]/).map(fold);
  const B = b.split(/[\\/]/).map(fold);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] !== B[i]) {
      return A[i] < B[i] ? -1 : 1;
    }
  }
  return A.length - B.length;
}
