// Agent registry: per-agent session discovery + parser (v0.2.x multi-agent
// plan, M1). TS canonical — the Python side is frozen at v0.1.1.
//
// Error policy (binding plan decision):
//   - claude-code.find() THROWS DataDirNotFoundError when its root is missing
//     (back-compat with the v0.1 CLI error path and its tests);
//   - kimi.find() silently returns [] — an optional install must never fail
//     an audit. The CLI demotes a missing DEFAULT root to a stderr hint when
//     several agents are selected, and keeps failing loudly for an explicit
//     path the user pointed at.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { comparePaths, findSessionFiles } from "./discovery.js";
import type { Event } from "./events.js";
import {
  ParseStats,
  iterEvents as iterClaudeEvents,
} from "./parsers/claude-code.js";
import { iterEvents as iterCodexEvents } from "./parsers/codex.js";
import { iterEvents as iterKimiEvents } from "./parsers/kimi.js";

export interface AgentParser {
  iterEvents(path: string, stats?: ParseStats): AsyncGenerator<Event>;
}

export interface AgentDescriptor {
  id: string;
  displayName: string;
  // Explicit root -> scan there; omitted -> the agent's default data root.
  find(root?: string): string[];
  parser: AgentParser;
}

// Kimi-Code session store (real-data verified 2026-09-20):
//   ~/.kimi-code/sessions/wd_<dirname>_<hash>/session_<uuid>/agents/main/wire.jsonl
export function defaultKimiSessionsDir(): string {
  // Python parity with discovery.default_claude_projects_dir: Path.home()/...
  return join(homedir(), ".kimi-code", "sessions");
}

function listDirDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    // racy removal / permission error: treat as absent (kimi discovery is
    // best-effort by policy)
    return [];
  }
}

// Exact-shape walk (NOT rglob): only wd_*/session_*/agents/main/wire.jsonl
// counts. Subagent transcripts (agents/<other>/) are out of scope for v0.2.x.
// Missing root -> empty list (silent skip), NOT an error.
function findKimiSessionFiles(root?: string | null): string[] {
  const base = root || defaultKimiSessionsDir();
  if (!existsSync(base)) {
    return [];
  }
  const out: string[] = [];
  for (const wd of listDirDirs(base)) {
    if (!wd.startsWith("wd_")) {
      continue;
    }
    const wdPath = join(base, wd);
    for (const sess of listDirDirs(wdPath)) {
      if (!sess.startsWith("session_")) {
        continue;
      }
      const wire = join(wdPath, sess, "agents", "main", "wire.jsonl");
      if (existsSync(wire)) {
        out.push(wire);
      }
    }
  }
  return out.sort(comparePaths);
}

// Codex CLI session store (format ground truth:
// docs/superpowers/research/2026-09-20-codex-format.md):
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<compact-ts>-<thread-uuid>.jsonl
//   + fork names rollout-<ts>-<thread-uuid>_<rollout-id>.jsonl
// Newer builds may compress cold rollouts to .jsonl.zst; v0.2.x does not
// decompress zstd, so discovery EXCLUDES them (the parser would only see
// binary garbage — better than counting unparseable files).
export function defaultCodexSessionsDir(): string {
  // Python parity with discovery.default_claude_projects_dir: Path.home()/...
  return join(homedir(), ".codex", "sessions");
}

// rglob("*.jsonl") over the sessions tree — same case-sensitive suffix rule
// and no-symlink-follow as discovery.walk (the YYYY/MM/DD nesting makes an
// exact-shape walk pointless; rollout files only live under sessions/).
// Missing root -> empty list (silent skip), NOT an error (optional agent).
function findCodexSessionFiles(root?: string | null): string[] {
  const base = root || defaultCodexSessionsDir();
  if (!existsSync(base)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // racy removal / permission error: best-effort, like kimi discovery
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) {
          walk(full);
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full); // .jsonl.zst does NOT end in .jsonl — excluded here
      }
    }
  };
  walk(base);
  return out.sort(comparePaths);
}

export const AGENTS: Record<string, AgentDescriptor> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    find: (root?: string) => findSessionFiles(root),
    parser: { iterEvents: (path: string, stats?: ParseStats) => iterClaudeEvents(path, stats) },
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi Code",
    find: (root?: string) => findKimiSessionFiles(root),
    parser: { iterEvents: (path: string, stats?: ParseStats) => iterKimiEvents(path, stats) },
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    find: (root?: string) => findCodexSessionFiles(root),
    parser: { iterEvents: (path: string, stats?: ParseStats) => iterCodexEvents(path, stats) },
  },
};

export interface AgentFileEntry {
  agent: string;
  path: string;
}

// Discovery over the selected agents' DEFAULT roots (explicit per-agent roots
// are a CLI concern). Entries are sorted with the same pathlib-style compare
// as discovery so multi-agent runs are deterministic. Per-descriptor error
// policy applies: a missing kimi root contributes nothing, a missing claude
// root throws.
export function findAgentFiles(ids: string[]): AgentFileEntry[] {
  const entries: AgentFileEntry[] = [];
  for (const id of ids) {
    const agent = AGENTS[id];
    if (!agent) {
      throw new Error(
        `unknown agent id: ${id} (known: ${Object.keys(AGENTS).join(", ")})`,
      );
    }
    for (const path of agent.find()) {
      entries.push({ agent: id, path });
    }
  }
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}
