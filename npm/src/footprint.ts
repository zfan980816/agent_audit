// M6: Qoder CN local-footprint inventory — "what has Qoder indexed/collected
// from your repos". TS-only mode on the single-command CLI (--footprint, the
// --watch precedent): NOT an audit-rule pipeline, an inventory report.
//
// PRIVACY POSTURE (this command's whole point, binding design decision): the
// report LISTS what Qoder collected — repos, absolute file paths, chunk
// counts, index timestamps — and NEVER reads or prints file CONTENT.
//   - vector chat.db: only chunk_table_512 metadata columns (path + line
//     ranges) and index_record_512.record_time are SELECTed, by explicit
//     column name — never SELECT *; embedding/vector blobs are not touched.
//   - completion .zap segments (which DO hold recoverable source text,
//     research §1.1): counted as files + bytes only; their bytes are never
//     interpreted as text, so no source fragment can reach the output. The
//     per-repo file census comes from chat.db's chunk table instead, which is
//     authoritative and metadata-only.
//   - agent_memory rows: only the workspace NAME columns (scope, scope_id);
//     title/content are never read.
//   - memories/<uid>/projects: file NAMES only; bodies are never opened.
//
// Ground truth: docs/superpowers/research/2026-09-20-trae-qoder-kimi-gemini-
// formats.md §1 + live schema introspection 2026-09-21 (chunk_table_512,
// index_record_512, file_record, node, edge, agent_memory — mirrored verbatim
// in test/footprint-fixtures.ts). chunk_table_512 carries NO time column; the
// vector index timestamps come from index_record_512.record_time (epoch
// seconds) and are omitted when that column is absent.
//
// SQLite access follows the M4 precedent (parsers/zcode.ts): every db is
// copied (+ -wal/-shm when present) into a fresh tmpdir and the COPY is opened
// read-write — Qoder may be running and its live dbs are in WAL mode. Every
// source degrades independently: an unreadable db becomes a report warning,
// never a crash and never a silent zero.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Table from "cli-table3";

import { comparePaths } from "./discovery.js";
import { loadNodeSqlite, type NodeSqliteModule } from "./parsers/zcode.js";

export interface FootprintRepo {
  repo: string;
  vectorChunks: number;
  vectorFiles: number;
  // the distinct absolute file paths the vector index chunked — the LIST of
  // what was taken (metadata only; contents never read). JSON carries them
  // in full; the terminal shows the count.
  vectorFilePaths: string[];
  completionStores: number;
  completionBytes: number;
  gitRows?: number;
  graphNodes?: number;
  graphEdges?: number;
  memoryFiles: string[];
  vectorFirstSeen: string | null;
  vectorLastSeen: string | null;
}

export interface FootprintAgentMemories {
  count: number;
  workspaces: Array<{ workspace: string; memories: number }>;
}

export interface FootprintReport {
  root: string;
  repos: FootprintRepo[];
  agentMemories: FootprintAgentMemories;
  // memory project dirs matching no indexed repo — still Qoder's footprint
  unmatchedMemoryProjects: Array<{ project: string; fileCount: number }>;
  warnings: string[];
  generatedAt: string;
}

export function defaultQoderRoot(): string {
  return join(homedir(), ".qoder-cn");
}

// --- small helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function epochToIso(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  // >= 10^12 reads as milliseconds, else seconds (zcode.ts heuristic)
  return new Date(raw >= 1e12 ? raw : raw * 1000).toISOString();
}

interface SqStatement {
  all(...params: unknown[]): unknown[];
}
interface SqDb {
  prepare(sql: string): SqStatement;
  close(): void;
}

// Single-value aggregate (COUNT/MIN/MAX ... "AS n"); null on any error —
// callers turn that into a report warning, never an exception.
function scalar(db: SqDb, sql: string): number | null {
  try {
    const row = db.prepare(sql).all()[0];
    if (isRecord(row) && typeof row["n"] === "number") {
      return row["n"];
    }
    return null;
  } catch {
    return null;
  }
}

function hasColumn(db: SqDb, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return (
      Array.isArray(cols) &&
      cols.some((c) => isRecord(c) && c["name"] === column)
    );
  } catch {
    return false;
  }
}

const PAGE_SIZE = 500;

function eachRow(db: SqDb, sql: string, visit: (row: Record<string, unknown>) => void): void {
  const stmt = db.prepare(`${sql} LIMIT ? OFFSET ?`);
  let offset = 0;
  for (;;) {
    let rows: unknown;
    try {
      rows = stmt.all(PAGE_SIZE, offset);
    } catch {
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }
    for (const row of rows) {
      if (isRecord(row)) {
        visit(row);
      }
    }
    if (rows.length < PAGE_SIZE) {
      return;
    }
    offset += PAGE_SIZE;
  }
}

function listSubDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort(comparePaths);
  } catch {
    return []; // absent/racy dir -> nothing to inventory
  }
}

// Repo dirs are "<name>_<hash>": 32-hex md5 (vector/completion) or 64-hex
// sha256 (git/graph). Strips the hash; names without one pass through.
export function repoNameFromDir(dir: string): string {
  const m = /^(.*)_[0-9a-f]{32,64}$/i.exec(dir);
  return m?.[1] ?? dir;
}

// *.md paths RELATIVE to the project dir (names only — bodies never opened).
function listMdFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.isSymbolicLink()) {
        out.push(...listMdFiles(join(dir, e.name), relPath));
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(relPath);
    }
  }
  return out.sort(comparePaths);
}

// project dir name (original case) -> md file list, merged across <uid> dirs.
function scanMemoryProjects(memoriesDir: string): Map<string, string[]> {
  const projects = new Map<string, string[]>();
  for (const uid of listSubDirs(memoriesDir)) {
    const projectsDir = join(memoriesDir, uid, "projects");
    for (const proj of listSubDirs(projectsDir)) {
      const files = listMdFiles(join(projectsDir, proj));
      const prev = projects.get(proj) ?? [];
      projects.set(proj, prev.concat(files));
    }
  }
  return projects;
}

// A memory project belongs to a repo when its dir name IS the repo name or
// ends with "-<repo>" (live layout: D-Project-<path-with-dashes>). Matching is
// case-insensitive; returns the matched project names for unmatched-tracking.
function matchMemoryProjects(
  projects: Map<string, string[]>,
  repoName: string,
): { files: string[]; matched: string[] } {
  const repoLower = repoName.toLowerCase();
  const files: string[] = [];
  const matched: string[] = [];
  for (const [name, list] of projects) {
    const lower = name.toLowerCase();
    if (lower === repoLower || lower.endsWith(`-${repoLower}`)) {
      matched.push(name);
      files.push(...list);
    }
  }
  return { files: files.sort(comparePaths), matched };
}

// M4 copy-then-read: copy db (+ -wal/-shm) into the run's tmpdir and open the
// COPY read-write; the original store is never written. Fails soft.
function readDbCopy(
  mod: NodeSqliteModule,
  work: string,
  n: number,
  dbPath: string,
  read: (db: SqDb) => void,
): string | null {
  const copyPath = join(work, `${n}-${basename(dbPath)}`);
  let db: SqDb | null = null;
  try {
    copyFileSync(dbPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) {
        copyFileSync(dbPath + suffix, copyPath + suffix);
      }
    }
    db = new (mod.DatabaseSync as unknown as new (path: string) => SqDb)(copyPath);
    read(db);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // already closed / failed open
      }
    }
  }
}

// --- inventory ----------------------------------------------------------------------

export function qoderFootprint(root?: string): FootprintReport {
  const base = root || defaultQoderRoot();
  const warnings: string[] = [];
  const repos = new Map<string, FootprintRepo>();
  const getRepo = (name: string): FootprintRepo => {
    let repo = repos.get(name);
    if (!repo) {
      repo = {
        repo: name,
        vectorChunks: 0,
        vectorFiles: 0,
        vectorFilePaths: [],
        completionStores: 0,
        completionBytes: 0,
        memoryFiles: [],
        vectorFirstSeen: null,
        vectorLastSeen: null,
      };
      repos.set(name, repo);
    }
    return repo;
  };

  const live = existsSync(base);
  const memories = live ? scanMemoryProjects(join(base, "shared_client", "memories")) : new Map();
  const matchedProjects = new Set<string>();

  const mod = loadNodeSqlite();
  if (live && mod === null) {
    warnings.push(
      "node:sqlite unavailable on this Node runtime (>= 22.5 required): index db counts skipped",
    );
  }

  const agentMemories: FootprintAgentMemories = { count: 0, workspaces: [] };
  let copyCounter = 0;
  const work = live ? mkdtempSync(join(tmpdir(), "agentaudit-qoder-")) : "";
  try {
    if (live) {
      // 1. vector index: chunk_table_512 (paths + line ranges, no content)
      const v5 = join(base, "shared_client", "index", "vector", "v5");
      for (const dir of listSubDirs(v5)) {
        const dbPath = join(v5, dir, "chat.db");
        if (!existsSync(dbPath)) {
          continue;
        }
        const repoName = repoNameFromDir(dir);
        const repo = getRepo(repoName);
        const mem = matchMemoryProjects(memories, repoName);
        repo.memoryFiles = mem.files;
        for (const name of mem.matched) {
          matchedProjects.add(name);
        }
        if (mod === null) {
          continue; // warning already recorded
        }
        copyCounter += 1;
        const n = copyCounter;
        const err = readDbCopy(mod, work, n, dbPath, (db) => {
          const chunks = scalar(db, "SELECT COUNT(*) AS n FROM chunk_table_512");
          const files = scalar(db, "SELECT COUNT(DISTINCT file_path) AS n FROM chunk_table_512");
          if (chunks === null) {
            warnings.push(`${dir}/chat.db: chunk_table_512 unreadable (schema changed?)`);
            return;
          }
          repo.vectorChunks = chunks;
          repo.vectorFiles = files ?? 0;
          const paths: string[] = [];
          eachRow(
            db,
            "SELECT DISTINCT file_path FROM chunk_table_512 ORDER BY file_path",
            (row) => {
              const p = row["file_path"];
              if (typeof p === "string" && p) {
                paths.push(p);
              }
            },
          );
          repo.vectorFilePaths = paths.sort(comparePaths);
          // chunk_table has no time column; record_time lives on the
          // per-file index records (epoch seconds). Omitted when absent.
          if (hasColumn(db, "index_record_512", "record_time")) {
            repo.vectorFirstSeen = epochToIso(
              scalar(db, "SELECT MIN(record_time) AS n FROM index_record_512"),
            );
            repo.vectorLastSeen = epochToIso(
              scalar(db, "SELECT MAX(record_time) AS n FROM index_record_512"),
            );
          }
        });
        if (err !== null) {
          warnings.push(`${dir}/chat.db: unreadable (${err})`);
        }
      }

      // 2. completion index: .zap segment census — files + bytes ONLY
      const completionV4 = join(base, "shared_client", "index", "completion", "v4");
      for (const dir of listSubDirs(completionV4)) {
        const repo = getRepo(repoNameFromDir(dir));
        const store = join(completionV4, dir, "store");
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(store, { withFileTypes: true });
        } catch {
          continue; // no store dir -> zero segments for this repo
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(".zap")) {
            continue;
          }
          repo.completionStores += 1;
          try {
            repo.completionBytes += statSync(join(store, e.name)).size;
          } catch {
            // segment removed mid-scan: count the file, not the bytes
          }
        }
      }

      // 3. git index: file_record work queue (paths + hashes)
      const gitV1 = join(base, "shared_client", "index", "git", "v1");
      for (const dir of listSubDirs(gitV1)) {
        const dbPath = join(gitV1, dir, "commit_store.db");
        if (!existsSync(dbPath) || mod === null) {
          continue;
        }
        const repo = getRepo(repoNameFromDir(dir));
        copyCounter += 1;
        const n = copyCounter;
        const err = readDbCopy(mod, work, n, dbPath, (db) => {
          const rows = scalar(db, "SELECT COUNT(*) AS n FROM file_record");
          if (rows === null) {
            warnings.push(`${dir}/commit_store.db: file_record unreadable (schema changed?)`);
            return;
          }
          repo.gitRows = rows;
        });
        if (err !== null) {
          warnings.push(`${dir}/commit_store.db: unreadable (${err})`);
        }
      }

      // 4. symbol graph: node/edge counts
      const graphV4 = join(base, "shared_client", "index", "graph", "v4");
      for (const dir of listSubDirs(graphV4)) {
        const dbPath = join(graphV4, dir, "graph.db");
        if (!existsSync(dbPath) || mod === null) {
          continue;
        }
        const repo = getRepo(repoNameFromDir(dir));
        copyCounter += 1;
        const n = copyCounter;
        const err = readDbCopy(mod, work, n, dbPath, (db) => {
          const nodes = scalar(db, "SELECT COUNT(*) AS n FROM node");
          const edges = scalar(db, "SELECT COUNT(*) AS n FROM edge");
          if (nodes === null && edges === null) {
            warnings.push(`${dir}/graph.db: node/edge unreadable (schema changed?)`);
            return;
          }
          if (nodes !== null) {
            repo.graphNodes = nodes;
          }
          if (edges !== null) {
            repo.graphEdges = edges;
          }
        });
        if (err !== null) {
          warnings.push(`${dir}/graph.db: unreadable (${err})`);
        }
      }

      // 5. agent memory: workspace NAME columns only (scope, scope_id);
      // title/content/keywords are never selected.
      const localDb = join(base, "shared_client", "cache", "db", "local.db");
      if (existsSync(localDb) && mod !== null) {
        copyCounter += 1;
        const n = copyCounter;
        const perWorkspace = new Map<string, number>();
        const err = readDbCopy(mod, work, n, localDb, (db) => {
          let total = 0;
          eachRow(db, "SELECT scope, scope_id FROM agent_memory ORDER BY rowid", (row) => {
            total += 1;
            const ws =
              typeof row["scope_id"] === "string" && row["scope_id"]
                ? row["scope_id"]
                : "(unknown)";
            perWorkspace.set(ws, (perWorkspace.get(ws) ?? 0) + 1);
          });
          agentMemories.count = total;
          agentMemories.workspaces = [...perWorkspace.entries()]
            .map(([workspace, memories2]) => ({ workspace, memories: memories2 }))
            .sort((a, b) => comparePaths(a.workspace, b.workspace));
        });
        if (err !== null) {
          warnings.push(`local.db: agent_memory unreadable (${err})`);
        }
      }
    }
  } finally {
    if (work) {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Memory projects that match no indexed repo are still local footprint.
  const unmatchedMemoryProjects = [...memories.entries()]
    .filter(([name]) => !matchedProjects.has(name))
    .map(([project, files]) => ({ project, fileCount: files.length }))
    .sort((a, b) => comparePaths(a.project, b.project));

  return {
    root: base,
    repos: [...repos.values()].sort((a, b) => comparePaths(a.repo, b.repo)),
    agentMemories,
    unmatchedMemoryProjects,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// --- terminal rendering ---------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function humanBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 ** 2) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 ** 3) {
    return `${(n / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function timeRange(lo: string | null, hi: string | null): string {
  if (lo === null && hi === null) {
    return "—";
  }
  const day = (s: string) => s.slice(0, 10);
  if (lo !== null && hi !== null) {
    return lo === hi ? day(lo) : `${day(lo)}..${day(hi)}`;
  }
  return day((lo ?? hi)!);
}

export function renderFootprint(report: FootprintReport): string {
  const lines: string[] = [];
  lines.push("──── agent-audit footprint ────");
  lines.push(`qoder · root ${report.root}`);
  if (report.repos.length === 0) {
    lines.push("no Qoder index data found");
  } else {
    const chunks = report.repos.reduce((acc, r) => acc + r.vectorChunks, 0);
    const files = report.repos.reduce((acc, r) => acc + r.vectorFiles, 0);
    const zap = report.repos.reduce((acc, r) => acc + r.completionStores, 0);
    const bytes = report.repos.reduce((acc, r) => acc + r.completionBytes, 0);
    lines.push(
      `repos ${report.repos.length} · chunks ${fmt(chunks)} · files ${fmt(files)}` +
        ` · zap ${fmt(zap)} files (${humanBytes(bytes)})` +
        ` · memory projects ${fmt(report.repos.reduce((acc, r) => acc + r.memoryFiles.length, 0))} files`,
    );
    const table = new Table({
      head: ["REPO", "CHUNKS", "FILES", "ZAP", "GIT", "GRAPH N/E", "MEM", "INDEXED"],
      style: { head: [], border: [] },
    });
    for (const r of report.repos) {
      table.push([
        r.repo,
        fmt(r.vectorChunks),
        fmt(r.vectorFiles),
        `${r.completionStores} / ${humanBytes(r.completionBytes)}`,
        r.gitRows === undefined ? "—" : fmt(r.gitRows),
        r.graphNodes === undefined && r.graphEdges === undefined
          ? "—"
          : `${fmt(r.graphNodes ?? 0)}/${fmt(r.graphEdges ?? 0)}`,
        String(r.memoryFiles.length),
        timeRange(r.vectorFirstSeen, r.vectorLastSeen),
      ]);
    }
    lines.push(table.toString());
    if (report.agentMemories.count > 0) {
      lines.push(
        `agent memory notes: ${fmt(report.agentMemories.count)} across ` +
          `${report.agentMemories.workspaces.length} workspace(s): ` +
          report.agentMemories.workspaces.map((w) => w.workspace).join(", "),
      );
    }
    if (report.unmatchedMemoryProjects.length > 0) {
      const names = report.unmatchedMemoryProjects.map((p) => p.project);
      const shown = names.slice(0, 3).join(", ");
      lines.push(
        `memory projects outside the vector index: ${names.length}` +
          (names.length > 3 ? ` (${shown}, …)` : names.length > 0 ? ` (${shown})` : ""),
      );
    }
  }
  for (const w of report.warnings) {
    lines.push(`[!] ${w}`);
  }
  lines.push("metadata only — file contents are never read or printed");
  return lines.map((l) => `${l}\n`).join("");
}
