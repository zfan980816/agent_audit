// Qoder local-footprint fixtures (M6). Synthetic `~/.qoder-cn`-shaped tree
// built with node:sqlite using the REAL schema columns, verbatim-introspected
// via `PRAGMA table_info` on the live stores 2026-09-21:
//   index/vector/v5/<repo>_<md5>/chat.db      chunk_table_512 + index_record_512
//   index/completion/v4/<repo>_<md5>/store/*.zap
//   index/git/v1/<repo>_<sha>/commit_store.db  file_record
//   index/graph/v4/<repo>_<sha>/graph.db       node + edge
//   cache/db/local.db                          agent_memory
//   memories/<uid>/projects/<proj>/**/*.md
// The guard variant adds SOURCE TEXT where the real schema never has it (an
// extra `content` column on chunk_table_512, marker bytes inside .zap blobs,
// agent_memory.content, .md bodies) — the footprint reader must never surface
// any of it (see footprint.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { openZcodeDb, type ZcodeDb } from "./zcode-fixtures.js";

// dir-name hash suffixes: md5 (32 hex) for vector/completion, sha256 (64 hex)
// for git/graph — both stripped by repoNameFromDir.
export const MD5_A = "c1a48e2b7f5d9036a1b2c3d4e5f60718";
export const MD5_B = "d2b59f3c8a6e0147b2c3d4e5f6071829";
export const MD5_A2 = "e3c60a4d9b7f1258c3d4e5f60718293a";
export const MD5_B2 = "f4d71b5eac802369d4e5f60718293040";
export const SHA_A = "112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0";
export const SHA_C = "fedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcba9876";

// Live-magnitude epoch SECONDS (index_record_512.record_time).
export const TIME_LO = 1786601498;
export const TIME_HI = 1786606966;

export const WS_A = "D:\\Project\\repoa";
export const WS_B = "D:\\Project\\repo-b";

// Guard marker: planted where real stores hold source text / memory bodies.
export const MARKER = "SECRET-SOURCE-MARKER-7f3a";

export interface ChatDbSpec {
  files: Array<{ path: string; chunks: number }>;
  // [lo, hi] -> index_record_512 rows (first file gets lo, the rest hi);
  // null -> the table is not created at all (schema-drift variant: no time).
  recordTime?: [number, number] | null;
  // guard variant: value for an extra `content TEXT` column on every chunk row
  extraContentColumn?: string | null;
}

export function writeChatDb(dbPath: string, spec: ChatDbSpec): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openZcodeDb(dbPath);
  try {
    const contentCol = spec.extraContentColumn ? ", content TEXT" : "";
    db.exec(
      `CREATE TABLE chunk_table_512 (
        chunk_id TEXT, file_path TEXT, file_name TEXT, start_line INTEGER,
        end_line INTEGER, start_offset INTEGER, end_offset INTEGER${contentCol}
      );` +
        (spec.recordTime === null
          ? ""
          : `CREATE TABLE index_record_512 (
              file_path TEXT, identifier TEXT, record_time INTEGER
            );`),
    );
    const contentHolder = spec.extraContentColumn ? ", content" : "";
    const contentPh = spec.extraContentColumn ? ", ?" : "";
    const insertChunk = db.prepare(
      `INSERT INTO chunk_table_512
        (chunk_id, file_path, file_name, start_line, end_line, start_offset, end_offset${contentHolder})
       VALUES (?, ?, ?, ?, ?, ?, ?${contentPh})`,
    );
    const insertRecord =
      spec.recordTime === null
        ? null
        : db.prepare(
            "INSERT INTO index_record_512 (file_path, identifier, record_time) VALUES (?, ?, ?)",
          );
    let chunkIdx = 0;
    spec.files.forEach((f, fileIdx) => {
      for (let i = 0; i < f.chunks; i++) {
        const params: unknown[] = [
          `sha256chunk${chunkIdx}`,
          f.path,
          basename(f.path),
          i * 30,
          i * 30 + 29,
          0,
          4096,
        ];
        if (spec.extraContentColumn) {
          params.push(spec.extraContentColumn);
        }
        insertChunk.run(...params);
        chunkIdx += 1;
      }
      if (insertRecord && spec.recordTime) {
        const t = fileIdx === 0 ? spec.recordTime[0] : spec.recordTime[1];
        insertRecord.run(f.path, `ident_${fileIdx}`, t);
      }
    });
  } finally {
    db.close();
  }
}

// Binary-safe .zap stand-ins: opaque bytes (never parsed back as text by the
// reader); the guard variant embeds the marker like real segments embed code.
export function writeZapStore(
  storeDir: string,
  files: Array<{ name: string; size: number; marker?: string }>,
): void {
  mkdirSync(storeDir, { recursive: true });
  for (const f of files) {
    const buf = Buffer.alloc(f.size, 0x41);
    if (f.marker) {
      buf.write(f.marker, Math.max(0, f.size - f.marker.length - 1), "utf8");
    }
    writeFileSync(join(storeDir, f.name), buf);
  }
}

// file_record (live columns): paths + hashes only — the git work queue.
export function writeCommitStore(dbPath: string, paths: string[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openZcodeDb(dbPath);
  try {
    db.exec(`CREATE TABLE file_record (
      file_path VARCHAR(500), next_execute_time INTEGER,
      file_status VARCHAR(255), file_hash VARCHAR(255),
      gmt_created INTEGER, gmt_modified INTEGER
    );`);
    const insert = db.prepare(
      "INSERT INTO file_record (file_path, file_status, file_hash, gmt_created) VALUES (?, 'init', ?, ?)",
    );
    paths.forEach((p, i) => insert.run(p, `hash${i}`, TIME_LO + i));
  } finally {
    db.close();
  }
}

// node/edge (live columns, verbatim): symbol-graph metadata, no source text.
export function writeGraphDb(dbPath: string, nodes: number, edges: number): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openZcodeDb(dbPath);
  try {
    db.exec(`CREATE TABLE node (
      node_id VARCHAR(255), node_type INTEGER, package VARCHAR(255),
      start_line INTEGER, end_line INTEGER, start_offset INTEGER,
      end_offset INTEGER, name_start_line INTEGER, name_end_line INTEGER,
      name_start_offset INTEGER, name_end_offset INTEGER,
      name_start_char INTEGER, name_end_char INTEGER, file_path VARCHAR(500),
      simple_name VARCHAR(255), meta_data TEXT, segmentation_field1 VARCHAR(255),
      segmentation_field2 VARCHAR(255), segmentation_field3 VARCHAR(255),
      segmentation_field4 VARCHAR(255), lang VARCHAR(32)
    );
    CREATE TABLE edge (
      source_id VARCHAR(255), target_id VARCHAR(255), edge_type INTEGER,
      meta_data TEXT, file_path VARCHAR(500)
    );`);
    const nodeIns = db.prepare(
      "INSERT INTO node (node_id, node_type, file_path, simple_name, lang) VALUES (?, 1, ?, ?, 'java')",
    );
    for (let i = 0; i < nodes; i++) {
      nodeIns.run(`com.example.Sym${i}`, "src/Main.java", `Sym${i}`);
    }
    const edgeIns = db.prepare(
      "INSERT INTO edge (source_id, target_id, edge_type, file_path) VALUES (?, ?, 2, 'src/Main.java')",
    );
    for (let i = 0; i < edges; i++) {
      edgeIns.run(`com.example.Sym${i % Math.max(nodes, 1)}`, `com.example.Sym${(i + 1) % Math.max(nodes, 1)}`);
    }
  } finally {
    db.close();
  }
}

// agent_memory (full live column list): the reader touches ONLY
// scope/scope_id — `content` exists here so the guard test can plant a marker.
export function writeLocalDb(
  dbPath: string,
  rows: Array<{ scope: string; scopeId: string; content: string }>,
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openZcodeDb(dbPath);
  try {
    db.exec(`CREATE TABLE agent_memory (
      id TEXT, gmt_create INTEGER, gmt_modified INTEGER, scope TEXT,
      scope_id TEXT, keywords TEXT, title TEXT, usage_scenario TEXT,
      content TEXT, session_id TEXT, is_merged INTEGER, freq INTEGER,
      source TEXT, token_count INTEGER, type TEXT, user_id TEXT,
      category TEXT, retention_score REAL, next_review_time INTEGER,
      last_review_time INTEGER, forget_count INTEGER, status TEXT,
      review_history TEXT, quality_score REAL, timeliness TEXT,
      timeliness_time INTEGER, remember_count INTEGER, learn_count INTEGER,
      content_updated_at INTEGER, request_id TEXT
    );`);
    const insert = db.prepare(
      "INSERT INTO agent_memory (id, scope, scope_id, title, content, category) VALUES (?, ?, ?, 'tech stack', ?, 'tech_stack')",
    );
    rows.forEach((r, i) => insert.run(`mem_${i}`, r.scope, r.scopeId, r.content));
  } finally {
    db.close();
  }
}

export function writeMemoryFiles(projectDir: string, relPaths: string[], content = "# note\n"): void {
  for (const rel of relPaths) {
    const p = join(projectDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
}

export interface QoderTreeSpec {
  // when set, plants SOURCE MARKERS in every content-bearing spot (guard test)
  guardMarker?: string;
}

// Three repos exercising the union: repoa in every index, repo-b only in
// vector+completion, repo_c only in graph.
export function writeQoderTree(root: string, spec: QoderTreeSpec = {}): void {
  const guard = spec.guardMarker ?? null;
  const sc = join(root, "shared_client");

  writeChatDb(join(sc, "index", "vector", "v5", `repoa_${MD5_A}`, "chat.db"), {
    files: [
      { path: "D:\\Project\\repoa\\src\\Main.java", chunks: 2 },
      { path: "D:\\Project\\repoa\\src\\Util.java", chunks: 3 },
      { path: "D:\\Project\\repoa\\lib\\Helper.java", chunks: 1 },
    ],
    recordTime: [TIME_LO, TIME_HI],
    extraContentColumn: guard,
  });
  writeChatDb(join(sc, "index", "vector", "v5", `repo-b_${MD5_B}`, "chat.db"), {
    files: [{ path: "D:\\Project\\repo-b\\app.ts", chunks: 2 }],
    recordTime: null,
    extraContentColumn: guard,
  });

  writeZapStore(join(sc, "index", "completion", "v4", `repoa_${MD5_A2}`, "store"), [
    { name: "seg1.zap", size: 1000, marker: guard ?? undefined },
    { name: "seg2.zap", size: 2000 },
  ]);
  writeZapStore(join(sc, "index", "completion", "v4", `repo-b_${MD5_B2}`, "store"), [
    { name: "only.zap", size: 500, marker: guard ?? undefined },
  ]);

  writeCommitStore(
    join(sc, "index", "git", "v1", `repoa_${SHA_A}`, "commit_store.db"),
    ["src/Main.java", "src/Util.java", "lib/Helper.java", "pom.xml"],
  );

  writeGraphDb(join(sc, "index", "graph", "v4", `repoa_${SHA_A}`, "graph.db"), 5, 7);
  writeGraphDb(join(sc, "index", "graph", "v4", `repo_c_${SHA_C}`, "graph.db"), 2, 1);

  writeLocalDb(join(sc, "cache", "db", "local.db"), [
    { scope: "workspace", scopeId: WS_A, content: guard ?? "stack: java/maven" },
    { scope: "workspace", scopeId: WS_A, content: guard ?? "build: nexus mirror" },
    { scope: "workspace", scopeId: WS_B, content: guard ?? "stack: node/ts" },
  ]);

  const projects = join(sc, "memories", "15907996", "projects");
  writeMemoryFiles(join(projects, "D-Project-repoa"), ["dev/note1.md", "ops/note2.md"], guard ?? "# a\n");
  writeMemoryFiles(join(projects, "D-Project-repo-b"), ["x.md"], guard ?? "# b\n");
  writeMemoryFiles(join(projects, "D-Project-unmatched"), ["y.md"], guard ?? "# u\n");
}
