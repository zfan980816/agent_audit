# Trae CN / Qoder CN / Kimi-Code / Gemini CLI — Local History & Storage Research Spike for agentaudit

- Date: 2026-09-20
- Scope: READ-ONLY local-data research. No code changed, nothing committed.
- Machine: Windows 11, Git Bash. All four tools installed and used on this machine.
- Method: filesystem survey + SQLite opened with `file:...?mode=ro` URI (SELECT only) via
  `uv run --no-project python` (env: `UV_CACHE_DIR=D:/uv-cache TMP=D:/tmp TEMP=D:/tmp`).
  Binary formats probed with header inspection and `grep -a` string extraction only.
- Note on sqlite-vec: several Qoder DBs use `vec0` virtual tables; the plain Python
  `sqlite3` module lacks that extension, so virtual-table rows are unreadable — their
  shadow tables (`*_rowids`, `*_chunks`, `*_vector_chunks00`, `*_info`) were read instead.
- Secrets: tokens/keys present on disk (`~/.trae-cn/trae-jwt-token`,
  `secret://...` rows in Trae state.vscdb, `~/.kimi-code/config.toml`) were located but
  are NOT quoted anywhere in this document.

## 0. Verdict table

| Tool | Where AI history lives | Format | Readable locally? | Tool-call events recoverable? | Source code stored locally? | Adapter difficulty |
|---|---|---|---|---|---|---|
| **Kimi-Code** (`~/.kimi-code/`) | `sessions/wd_<dir>_<hash>/session_<uuid>/agents/main/wire.jsonl` | JSONL, self-describing event log (protocol 1.5) | YES, plaintext | YES — explicit `tool.call` / `tool.result` events | Only what tool outputs captured (e.g. `ls` output) — not by design | **LOW** — best adapter target |
| **Gemini CLI** (`~/.gemini/`) | `tmp/<project-dir>/chats/session-*.jsonl` | JSONL, simple typed records | YES, plaintext | Probably (in `gemini` records' functionCall parts) — **no local sample exists** (both local sessions quota-died before any tool use) | No | **LOW-MEDIUM** (shape of tool records unverified locally) |
| **Trae CN** (`$APPDATA/Trae CN/`) | `ModularData/ai-agent/database.db` (+ `-wal` 5.2 MB) | SQLite-in-WAL but **encrypted** (random header) | NO — header is not `SQLite format 3`, unreadable without key | NO (only indirect traces) | YES, as side effects: `User/History/` file snapshots + (likely) inside the encrypted DB | **HIGH** — encrypted; only fragments recoverable |
| **Qoder CN** (`~/.qoder-cn/`) | Chat: **not persisted locally** — `chat_*` tables in `shared_client/cache/db/local.db` exist but all 0 rows (server-side sessions; only agent *memories* sync down) | SQLite | Chat: nothing to read. Memories: YES | NO | **YES — in the code-completion index** (see §1) | Chat adapter **infeasible** from local data |

Recommended adapter order: **Kimi-Code → Gemini CLI → (Trae partial) → (Qoder: none)**. Rationale in §5.

---

## 1. Qoder CN — `~/.qoder-cn/` (Alibaba, VS Code-based)

### 1.1 THE CORE ANSWER: does Qoder store user source code locally?

**YES.** User source code IS persisted locally, in the code-completion full-text index:

- Path: `~/.qoder-cn/shared_client/index/completion/v4/<repo>_<md5>/store/*.zap`
  (bleve/"scorch" full-text index segments, manifest in `root.bolt`; `index_meta.json`
  says `{"storage":"boltdb","index_type":"scorch"}`).
- The `.zap` segments contain **compressed stored fields with real source-code text**.
  Extracted with `grep -a` from the `cyjc3` repo store (45 MB of zap segments):
  - `LocalDateTime searchStart p= org.springframework.util.St...Utils.hasText(s...) ? ...parse(...)...STANDARD_D...`
  - `.in(!org.springframework.util.St...Utils.isEmpty(trafficLineIds), T...(Status::get...`
  - The fragments are method/symbol-level code chunks interleaved with binary framing and
    what looks like light token compression — but the code text is plainly recoverable.
- Coverage is **whole repos**: 1,467 unique `*.java` basenames occur in the cyjc3 zap
  segments; the companion vector DB for the same repo tracks 1,850 files / 4,280 chunks.
  Five repos are indexed on this machine (78 MB completion index total).
- The zap doc IDs are internal hashes; a direct chunk_id → zap-doc join was NOT found
  (40 chunk_ids tested, 0 literal matches), but the vector DB (§1.2) provides the
  file-path ↔ line-range mapping, and the zap provably holds the chunk bodies.
- Plaintext-ness: not raw plaintext files — bleve segment encoding (boltdb pages +
    per-field dictionaries + stored fields). No encryption. Readable with bleve tooling
    or by direct segment parsing.
- Also contains **project summary text**: `index/memory_text/v1/memory_text_engine/store/*.zap`
  holds generated project-intro/tech-stack text (not raw source).

If "did my code leave my repo?" is the threat model: for any repo opened in Qoder CN,
**yes — compressed copies of file/chunk contents sit in `%USERPROFILE%\.qoder-cn\shared_client\index\completion\`**.

### 1.2 The named SQLite stores (all opened read-only)

**`shared_client/cache/db/local.db`** (2.8 MB, 59 tables) — the agent cache DB.
Chat-related tables are ALL EMPTY (0 rows): `chat_session`, `chat_message`, `chat_record`
(columns: request_id, chat_task, chat_context, system_role_content, question, answer,
reasoning_content, chat_prompt, ...), `chat_snapshot`, `resource_snapshot`,
`agent_source_file`, `agent_code_snippet`, `chat_working_space_file`, `local_execution`.
→ **Qoder chat transcripts are not persisted here**; schema is provisioned but unused,
sessions live server-side. What IS populated:
- `agent_memory` (11 rows): workspace-scoped memory notes. Columns incl. `scope`,
  `scope_id` (= workspace path, e.g. `D:\Project\huaihua-3-cyjc`), `title`, `content`
  (markdown tech-stack summaries, ~400 chars each), `keywords`, `category`,
  `retention_score`, `forget_count`, ... Agent-memory lifecycle metadata.
- `agent_memory_embedding*` shadow tables + `memory_common_embedding*`: sqlite-vec
  embedding infra over those memories (binary vectors only).
- `broker_environment_state`, `broker_session_mapping`, `sync_metadata`, `task_tree`,
  `agent_memory_system_strategy`: operational state.

**`shared_client/index/vector/v5/<repo>_<md5>/chat.db`** (13.7 MB for cyjc3):
- `chunk_table_512` (4,280 rows): `chunk_id` (sha256), **absolute file path**
  (`D:\Project\cyjc3\...\MarketServiceImpl.java`), `file_name`, `start_line`, `end_line`,
  `start_offset`, `end_offset` → a complete map of every code chunk taken from the repo.
  **Metadata only — no file bodies.**
- `embedding_table_512`: vec0 virtual table (vectors only; shadow
  `_vector_chunks00` rows are 2 MB float32 blobs ≈ 512-dim vectors).
- `index_record_512` (1,850 rows): per-file index records.
- A global `vector/v5/.chunks/chat.db` exists alongside per-repo ones.

**`shared_client/index/graph/v4/<repo>_<sha>/graph.db`** (61.5 MB for cyjc3) — symbol graph:
- `node` (18,250): `node_id` (`com.cydata.cyjc.Application`), `node_type`, `package`,
  `start_line/end_line/offsets`, name positions, signature JSON, `file_path`, language.
- `edge` (60,069): `source_id`, `target_id`, `edge_type` (int codes), `meta_data` JSON,
  `file_path`. → call/reference graph. Metadata only, no source text.

**`shared_client/index/git/v1/<repo>_<sha>/commit_store.db`** (5 repos, 160–754 KB):
- `file_record` (185–1,852 rows): `file_path`, `file_status` ('init'), `file_hash`
  (sha256), timestamps. Indexing work queue — paths + hashes only.
- `commit_vector` (vec0) + shadow tables: all empty — no commit embeddings stored here yet.

**`shared_client/atlas/work/atlas-store/atlas.db`** (+ `v1alpha1/atlas.db`,
`v1alpha2/atlas.db` — older schema generations, 266/… KB):
- Tables for the Atlas/Repo-Wiki feature: `card`, `card_embedding` (vec0),
  `card_embedding_chunks`, `card_link`, `card_module_file`, `card_partition`,
  `knowledge_link`, `knowledge_module`, `wiki_article`, `wiki_artifact`, `wiki_run`,
  `work_artifact`, `work_run`, `work_progress`, `schema_state`.
- All content tables 0 rows (v1alpha1/v1alpha2 have only `schema_state` + empty
  embedding infra) → Atlas artifacts not (yet) generated/cached locally.

**`shared_client/repowiki/knowledge.db`**: no readable data rows (empty schema).

**`shared_client/index/.settings/v1/index.db`** and **`index/meta/v8/<repo>/index.db`**:
NOT SQLite — 32 KB files starting with 16 zero bytes then `04 00 ...`; custom/encrypted
format, unreadable. Same for `index/tree/v2/<repo>.json` (binary despite extension).

**`shared_client/memories/<uid>/projects/<proj-hash>/*.md`**: plaintext markdown project
memories (tech stack, build config, environment) — human-readable, no source bodies.

### 1.3 Chat/AI-conversation storage hunt

- No VS Code-style `User/` dir exists anywhere for Qoder on this machine:
  `~/.qoder-cn/app` holds only `bundled-resources`; `$APPDATA` and `$LOCALAPPDATA`
  contain **no Qoder entry at all**. A second data root exists at `D:\app\qoder-cn`
  (mirrors the `shared_client` layout: atlas/bin/cache/extension/index/logs/model/...).
- `shared_client/logs/qoder.log` (6.8 MB): LSP/broker/IDE-transport logs
  (`codebase engine`, `vector client engine`, workspace paths, OAuth state flags) —
  operational logs, no transcripts.
- Conclusion: on this machine, Qoder conversation history exists **only server-side**;
  locally you get the (empty) chat schema, agent memories, and — the privacy finding —
  the full-repo completion/vector/graph indexes described above.

---

## 2. Trae CN — `$APPDATA/Trae CN/`

### 2.1 Where chat history lives

- **`ModularData/ai-agent/database.db`** (8.9 MB, + 5.2 MB `-wal`, 32 KB `-shm`,
  `-shm` still being touched while Trae runs): the AI-agent module's store. Header is
  random bytes — **encrypted SQLite (SQLCipher-style)**; "file is not a database" for
  plain sqlite3. This is where session/tool-call history must live, but it is **not
  readable** without the key.
- `ModularData/ai-agent/sandbox/<id>.json`: per-agent permission config (workspace dirs,
  `~/.trae-cn/memory`, builtin work dirs) — plaintext, reveals agent sandboxing model.
- `ModularData/ai-agent/snapshot/<session-id>/v2/.git`: a **shadow git repo per session**
  for checkpointing (here: bare, "init empty branch", 1 housekeeping file; 4.6 MB objects).
- `ModularData/ckg_server/`: Go "code knowledge graph" sidecar (IPC via FFI, port 51060).
  Its startup log leaks the config: `local_embedding: true`,
  `embedding_storage_type: sqlite_vec`, `storage_path: ...\ModularData\ckg_server`.
  `env_codekg.db` — **also encrypted** (random header). `codekg.log.*` — plaintext
  service logs (process init, IPC wiring; no code content).

### 2.2 What IS readable

- **`User/workspaceStorage/<hash>/state.vscdb`** (ItemTable): key
  `icube-ai-agent-storage-input-history` — JSON array of past user prompts with
  `inputText`, `parsedQuery`, `multiMedia`, `files` (13.8 KB here; real prompts, Chinese
  text, readable). This is prompt history only — no assistant replies, no tool calls.
- **`User/globalStorage/state.vscdb`** (ItemTable, ~85 keys): UI/editor state +
  AI-settings keys (`AI.agent.model.*`, `ai-chat:sessionRelation:*`,
  `chat.ChatSessionStore.index` = `{"version":1,"entries":{}}` — empty), plus
  `secret://...` rows (auth — not quoted). Extension-scoped keys prefixed with the
  numeric user id `2226973115697849:`.
- **`User/History/`** (VS Code local history): per-file dirs with `entries.json`
  (`{"resource":"file:///d%3A/cc/src/main/java/.../FileService.java","entries":[
  {"id":"6BQt.java","source":"工作区编辑","timestamp":...}]}`) + snapshot files with
  **full file contents** — Trae AI edits land here. Source-code copies by design
  (standard VS Code History behavior), small on this machine (236 KB).
- **`User/globalStorage/.ckg/storage/u_<userhash>/<ws>_file_cache.db`**: 16 KB, opaque
  header — encrypted, not SQLite-readable.
- `~/.trae-cn/` (note: separate home dir): `plugins/`, `toolhost/`, `mcps/`,
  `permission/`, `worktrees/`, `installed-plugins.json`, **`trae-jwt-token`**
  (plaintext credential file — flagged, contents not quoted).

### 2.3 Tool-call / event mapping

Not recoverable from local data (encrypted store). Indirect traces only: input-history
prompts, session badges (`all_session_badges_...` = `{"<session>":"completed"}`),
shadow-git checkpoints, `codekg.log` service activity. No `trajectory`-style keys found
in either state.vscdb (checked — nothing matching 'trajectory' exists).

---

## 3. Kimi-Code — `~/.kimi-code/`

### 3.1 Layout

- `session_index.jsonl` — one JSON per line: `{"sessionId":"session_<uuid>",
  "sessionDir":"C:/Users/31838/.kimi-code/sessions/wd_<dir>_<hash>/session_<uuid>",
  "workDir":"D:/..."}`. 7 lines on this machine (5 distinct workDirs).
- `sessions/wd_<workdirname>_<hash>/session_<uuid>/`:
  - `state.json` — `{"id","version":2,"cwd","createdAt","updatedAt","archived",
    "agents":{"main":{"homedir":...,"type":"main"}},"lastTurnReason":"completed",...}`.
  - **`agents/main/wire.jsonl` — the full transcript (append-only event log).**
  - `logs/kimi-code.log` — per-session INFO log (llm config/request/response with
    ttftMs, token counts, toolCount=27).
  - `notify/state.json`.
- `logs/kimi-code.log` (global): query-store openings (`cache/query-store` minidb with
  16 shards — internal retrieval cache, binary), session-index generations.
- `user-history/<md5>.jsonl` — per-user prompt history.
- `config.toml`, `tui.toml`, `workspaces.json`, `device_id` — config (config.toml may
  hold credentials; not quoted).
- 14 wire.jsonl files on this machine; largest 425 KB.

### 3.2 wire.jsonl event taxonomy (protocol_version 1.5, first line `{"type":"metadata"}`)

Every record has `type` + `time` (epoch ms). Observed types and shapes:

| type | keys | notes |
|---|---|---|
| `metadata` | protocol_version, created_at | file header |
| `runtime.set_binding` | workspaceId, runtimeId, agentId | |
| `profile.bind` | modelAlias (`kimi-code/k3`), thinkingEffort, **systemPrompt** (full text), agentsMdPaths, activeToolNames, disallowedTools, subagents | one per session |
| `permission.set_mode` | mode (`manual`) | |
| `turn.prompt` | input: `[{type:"text",text:...}]`, origin, promptId, turnId | user turn start |
| `context.append_message` | message `{role, content:[{type,text}]}` | canonical message log |
| `agent.message.appended` | message (nested), kind | mirror of context |
| `agent.turn.started/ended`, `turn.ended`, `prompt.completed` | turnId/queueItemId | turn boundaries |
| `context.append_loop_event` | event: see below | **tool activity lives here** |
| `llm.tools_snapshot` | hash, tools:[full JSON-schema tool defs] | reproducibility |
| `llm.request` / `usage.record` / `token_counting.*` | provider, model, maxTokens / usage{inputOther,output,inputCacheRead,...} | telemetry |
| `task.started/terminated`, `turn.steer`, `prompt.steered` | | control flow |

`context.append_loop_event.event` types: `step.begin` {uuid, turnId, step} →
`content.part` → **`tool.call`** → **`tool.result`** → `step.end`
{finishReason:"tool_use", usage, llmFirstTokMs}.

**Tool-call representation (direct mapping to canonical events):**
```json
{"type":"tool.call","uuid":"6cd4...","turnId":"0","step":1,"stepUuid":"9036...",
 "toolCallId":"tool_wy4TnCXbnQC71q6SH6k7IArR","name":"Bash","args":{"command":"ls ..."}}
{"type":"tool.result","parentUuid":"6cd4...","toolCallId":"tool_wy4...",
 "result":{"output":"D:/compare/src:\ntotal 156\ndrwxr-xr-x ..."}}
```
- Names observed across all 14 sessions: Read 31, Bash 23, Grep 9, FetchURL 3, Glob 2,
  Skill 2, WaitFor 1, TaskStop 1 (claude-code-style tool naming).
- Mapping: `Bash`→ShellCommand; `Read`/`Grep`/`Glob`→file ops; `FetchURL`→NetworkRequest;
  args are plain JSON objects (no stringified-JSON or freeform-grammar wrinkles).

**Difficulty: LOW.** Self-describing, UTF-8, one JSON per line, explicit uuid parent
links, timestamps monotonic. Only care points: `kind` field vs nested `message.message`
duplication in `agent.message.appended`, and profile/turn records being chatty.

---

## 4. Gemini CLI — `~/.gemini/`

### 4.1 Layout (note: `tmp/<project-dir-name>/`, not a content hash — hash is inside)

- `tmp/<dirname>/chats/session-<localtime>-<id8>.jsonl` — session transcripts, keyed by
  project directory name (`31838`, `sa`, `compare`, `gemini-relay-probe` here; 4.5 MB total).
- `tmp/<dirname>/logs.json` — flat array `{sessionId, messageId, type, message, timestamp}`
  (user prompts incl. slash commands like `/model`).
- `history/<dirname>/.project_root` — empty placeholder dirs.
- `settings.json`, `state.json`, `trustedFolders.json`, `installation_id`,
  `google_accounts.json` — small config/state (no secrets quoted).
- `tmp/bin/rg.exe` — vendored ripgrep, not data.

### 4.2 Session JSONL shape

Line 1 = header: `{"sessionId","projectHash","startTime","lastUpdated","kind":"main"}`.
Then typed records: `{"id","timestamp","type","content"}` with `type` ∈
`user` (`content:[{"text":...}]`), `gemini`, `info`, `error`, `warning`,
`tool_confirmation`. Local corpus: only 2 sessions (2026-04-27), both died on
"[API Error: You have exhausted your daily quota on this model.]" → records are
`user`/`info`/`error` only; **no `gemini` records and no tool-call records exist
locally**, so the exact persisted tool-call shape could not be confirmed from this
machine. (Upstream gemini-cli persists model turns including functionCall /
functionResponse parts inside `gemini`-type record `content`; `tool_confirmation`
records cover approve/cancel — but treat that as to-be-verified.)

**Difficulty: LOW-MEDIUM** — format is trivially parseable; the work is mapping
`functionCall`/`functionResponse` parts (names like `run_shell_command`, `write_file`,
`web_fetch`, `google_web_search`) to canonical events, and that mapping is currently
unverified against real local data. Generating one live session with tool use would close this.

---

## 5. Recommended adapter order (and why)

1. **Kimi-Code** — wire up first. Plaintext JSONL, explicit `tool.call`/`tool.result`
   with uuid parent links, tool vocabulary already claude-code-like
   (Bash/Read/Grep/Glob/FetchURL), full system-prompt + tool-def snapshots included.
   Estimated effort: days, not weeks.
2. **Gemini CLI** — second. Same trivial JSONL mechanics; needs one live verification
   session to pin down persisted tool-call records before writing the mapper.
3. **Trae CN — partial only.** A "best-effort" adapter could ingest:
   (a) `icube-ai-agent-storage-input-history` prompts from workspaceStorage state.vscdb,
   (b) `User/History/entries.json` + snapshots as FileEdit evidence. Full
   ShellCommand/tool-call fidelity is blocked by the encrypted
   `ModularData/ai-agent/database.db`. Do not plan on decrypting it.
4. **Qoder CN — no chat adapter possible from local data.** Chat tables exist but are
   empty (server-side sessions). There is nothing to parse into tool events.
   The actionable Qoder deliverable is the §1.1 privacy finding: source code of every
   indexed repo is stored (recoverable) under
   `~/.qoder-cn/shared_client/index/completion/v4/*/store/*.zap`, with a complete
   chunk→path→line-range map in `index/vector/v5/*/chat.db`. A "local data footprint"
   audit feature (list repos/chunks Qoder kept, with sizes) is feasible from those DBs.

## 6. Repro notes

- SQLite access pattern used throughout:
  `sqlite3.connect('file:' + path + '?mode=ro', uri=True)`, SELECT/PRAGMA only.
- vec0 shadow-table pattern for reading sqlite-vec DBs without the extension:
  read `*_rowids` / `*_chunks` / `*_vector_chunksNN` / `*_info` directly.
- Header probe for "is this really SQLite": first 16 bytes must be
  `SQLite format 3\0`. Zeroed-header (`\0\0\0\0\0\0\0\0 04 00...`) = Qoder custom store;
  random bytes = encrypted (Trae).
- bleve zap segment mining: `grep -aoE '.{60}<needle>.{60}' *.zap` extracts stored-field
  fragments; doc IDs and file basenames are greppable, full reassembly needs bleve.
