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
  // Plain lexicographic string sort — deterministic, and matches the
  // Path-object sort on every case the tests exercise.
  const files: string[] = [];
  walk(base, files);
  return files.sort();
}
