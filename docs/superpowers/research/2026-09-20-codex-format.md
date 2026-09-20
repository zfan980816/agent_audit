# Codex CLI Session Log Format — Research Spike for agentaudit Adapter

- Date: 2026-09-20
- Scope: READ-ONLY format research. No code changed.
- Real data: `~/.codex/sessions/` (C:\Users\31838\.codex\sessions), 5 files, all `codex exec` runs, 2026-08-19 → 2026-09-17.
- Schema authority: `openai/codex` (codex-rs) source @ master 2026-09, cross-checked against local files written by CLI 0.148.0 / 0.149.1. Key sources: `codex-rs/history/src/lib.rs` (`RolloutLine`, `RolloutItem`), `codex-rs/history/src/rollout_payload.rs` (wire tags), `codex-rs/protocol/src/models.rs` (`ResponseItem`), `codex-rs/protocol/src/protocol.rs` (`SessionMeta`, `EventMsg`, `SessionSource`, `InterAgentCommunication`), `codex-rs/rollout/src/policy.rs` (persistence policy), `codex-rs/core/src/tools/handlers/{shell_spec,apply_patch_spec,mcp}.rs` (tool names/args).

## 1. Verdict

**Easily parseable.** One JSON object per line, strict UTF-8, no BOM, LF-terminated, `ordinal` strictly 0..n and timestamps monotonic (verified on all 5 local files). Envelope is uniform: every line has `timestamp`, `ordinal`, `type`, `payload`. Difficulty: **low-medium** — the envelope and message records are trivial; the only real work is (a) tool-call → unified-event mapping (JSON-string args, apply_patch freeform grammar) and (b) version drift tolerance (field sets grow across CLI versions; unknown `type`s must be skipped, never rejected).

**Critical finding:** in current CLI versions, **tool calls are persisted ONLY as `response_item` records** (`function_call` / `local_shell_call` / `custom_tool_call` / `web_search_call` + matching `*_output`). The `event_msg` channel deliberately does NOT persist `ExecCommandBegin/End`, `PatchApplyBegin/End`, `McpToolCallBegin/End`, `WebSearchBegin/End` (they are transient UI events; see `rollout/src/policy.rs::should_persist_event_msg`). An adapter that only reads `event_msg` (like a Claude Code adapter reading progress events) would see **zero tool activity**. Read `response_item`.

## 2. Location, naming, scale on this machine

- Path layout: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<UTC-timestamp-compact>-<thread-uuid>.jsonl`
  - e.g. `rollout-2026-09-17T16-22-53-01a0ae76-2436-7590-9a11-216f21269bb4.jsonl` (filename timestamp is local-time-formatted but the embedded `timestamp` fields are UTC RFC3339 — do not cross-derive).
  - Thread revert forks: `rollout-<ts>-<thread-id>_<rollout-id>.jsonl`; newer builds may store `.jsonl.zst` (compressed rollouts, decompressed transparently by codex itself — parser should accept `.zst` or skip with warning).
  - `~/.codex/archived_sessions/` exists as a concept (`ARCHIVED_SESSIONS_SUBDIR`) but is empty here.
- Scale on this machine:
  - 5 files, **208,944 bytes total (~204 KB)**, largest 47,668 bytes.
  - Lines per file: 9–17 (total 65 records). All runs are short `codex exec` sessions; 4 of 5 ended in provider errors (402/404) or user interrupt — hence **no tool-call records exist in the local corpus at all** (verified by grep + full type survey).
  - `~/.codex/history.jsonl`: separate 1-line-per-user-prompt history (session_id, ts, text) — useful as a cross-check, not an event source.
  - `~/.codex/logs_2.sqlite`: tracing/HTTP logs (h2 frames, app-server RPC), NOT session events — out of adapter scope.

## 3. Envelope (`RolloutLine`, from `history/src/lib.rs`)

```rust
pub struct RolloutLine {
    pub timestamp: String,          // RFC3339 UTC, e.g. "2026-09-17T08:22:53.411Z"
    pub ordinal: Option<u64>,       // omitted-able in theory; always present in practice, 0..n
    #[serde(flatten)]
    pub item: RolloutItem,          // internally tagged -> contributes "type" and "payload"
}
```

Wire: `{"timestamp": "...", "ordinal": N, "type": "<item-type>", "payload": {...}}`. Compact serde JSON (no spaces). Line order == append order == causal order; `ordinal` starts at 0 and increments by exactly 1 (verified). A file may gain more lines at any time while its thread is active (append-only) — suitable for tailing.

`RolloutItem` wire tags (`history/src/rollout_payload.rs`, `snake_case`):

| `type` | payload schema | Persisted? | Observed locally |
|---|---|---|---|
| `session_meta` | `SessionMetaLine` = flattened `SessionMeta` + optional `git` | always | yes (line 1 of every file) |
| `response_item` | `ResponseItem` (+ optional `metadata`: harness metadata) | most variants (see policy) | yes |
| `inter_agent_communication` | `{author, recipient, other_recipients, content, trigger_turn}` | always | no (multi-agent sessions only) |
| `inter_agent_communication_metadata` | `{trigger_turn}` | always | no |
| `compacted` | `CompactedItem` (summary message, replacement_history, window ids) | always | no |
| `turn_context` | `TurnContextItem` (cwd, model, sandbox, approval, turn_id) | always | yes |
| `token_usage_record` | `{thread_id, turn_id, session_id, root_turn_id, response_id, usage...}` | always | no |
| `world_state` | `{full: bool, state: map}` (env/sandbox/instructions snapshot) | always | yes |
| `retained_context` | RetainedContextEvent | always | no |
| `security_risk_score` | SecurityRiskScore | always | no |
| `event_msg` | `EventMsg` (subset persisted) | subset (see §6) | yes |
| `realtime_item` | RealtimeItem | paginated mode only | no |

**Adapter rule: unknown `type` → skip. Codex adds variants across versions (e.g. `world_state` did not exist in older releases).**

## 4. `session_meta` payload (first line of every file)

Fields observed locally: `session_id`, `id` (both = thread UUID; equal for root threads), `timestamp` (session creation, RFC3339), `cwd` (native Windows path with backslashes), `originator` (`codex_exec` | `codex-tui` | ...), `cli_version`, `source` (`exec` | `cli` | `vscode` | `mcp` | `sub_agent` | custom/internal strings), `thread_source` (`user` | `subagent` | `guardian_review` | `memory_consolidation` | freeform), `model_provider`, `base_instructions` ({text, provenance{type, model}} — 17–21 KB of text in these files), `history_mode` (`paginated` here; older files `legacy`), `context_window` ({window_id}), optional `git` ({commit_hash, branch, repository_url — URL is sanitized}), and (newer CLIs, multi-agent relevant): `parent_thread_id`, `agent_nickname`, `agent_role` (alias `agent_type`), `agent_path`, `forked_from_id`, `subagent_history_start_ordinal`, `multi_agent_version`, `dynamic_tools`.

**Multi-agent note:** sub-agent sessions get their OWN rollout file (own thread id) with `source: "sub_agent"` / `thread_source: "subagent"` / `parent_thread_id` set. Inter-agent messages are additionally recorded in-file as `inter_agent_communication` items with `author`/`recipient` agent paths. This is the primary hook for agentaudit's multi-agent attribution.

## 5. `response_item` payload variants (the tool-call source of truth)

`ResponseItem` enum (`protocol/src/models.rs`), internally `snake_case` tagged. Persisted variants per `policy.rs`: `message`, `agent_message`, `reasoning`, `local_shell_call`, `function_call`, `tool_search_call`, `function_call_output`, `tool_search_output`, `custom_tool_call`, `custom_tool_call_output`, `web_search_call`, `image_generation_call`, `configuration_update`, `compaction` (alias `compaction_summary`), `context_compaction`. NOT persisted: `additional_tools`, `compaction_trigger`, and anything unrecognized (deserializes to `Other` → still written? No: `Other` lines are never produced; but a newer CLI reading an older file tolerates unknowns).

### 5.1 Shell — three encodings depending on model/provider/tool surface

1. `function_call`, `name: "exec_command"` (current unified-exec surface):
   `payload.arguments` is a **JSON-encoded string** (must json.loads twice: line, then arguments), shape:
   `{"cmd": "<shell command string>", "workdir": "...?", "tty": bool?, "yield_time_ms": N?, "max_output_tokens": N?, "shell": "...?", "login": bool?, "environment_id": "...?", "sandbox_permissions": "use_default|require_escalated|with_additional_permissions"?, "justification": "...?", "prefix_rule": [...]?, "additional_permissions": {...}?}` (required: only `cmd`).
2. `function_call`, `name: "shell"` (legacy Responses-API shell tool): arguments string `{"command": ["bash","-lc","..."], "timeout_ms": N?, "workdir": "...?"}` (array form).
3. `local_shell_call`: `payload.call_id`, `payload.status` (`completed|in_progress|incomplete`), `payload.action: {"type": "exec", "command": ["..."], "timeout_ms"?, "working_directory"?, "env"?, "user"?}` — here the command is a **parsed array**, not a string.

Result: matching `response_item` `function_call_output` with the same `call_id`: `payload.output` is either a plain string or `{content | content_items: [{type: input_text|input_image,...}]}`; unified-exec outputs embed `{"output": "...", "exit_code": N, "wall_time_seconds": N, ...}` inside the string/JSON. Exit code extraction is best-effort.

### 5.2 File edits — `custom_tool_call`, `name: "apply_patch"` (freeform)

`payload.input` is a **raw patch string** (V4A grammar, NOT JSON):
```
*** Begin Patch
*** Add File: path/to/file.py
+content...
*** Update File: other.txt
@@ context
-old
+new
*** Delete File: gone.txt
*** End Patch
```
Path + intent (add/update/delete) parseable by line scan; **content is full only for Add File** — Update File carries a diff, not the resulting file. There is no dedicated "file write" tool otherwise; writes via shell redirection appear only inside `exec_command` commands.

### 5.3 Web — `web_search_call`

`payload.status`, `payload.action`: `{"type": "search", "query"?: str, "queries"?: [str]}` | `{"type": "open_page", "url"?: str}` | `{"type": "find_in_page", "url"?: str, "pattern"?: str}` (tag values serialize snake_case: `search` / `open_page` / `find_in_page`). This is the only first-class network URL record; `curl`/`git fetch` inside shell commands are only visible as `ShellCommand` text (rule-layer concern, same as Claude Code adapter).

### 5.4 MCP — `function_call` with namespaced name

MCP tools surface as ordinary `function_call`s: `payload.name` = flat `"<server>__<tool>"` (delimiter `__`; legacy prefix variant `mcp__<server>__<tool>`; a server named/aliased `mcp__foo` stays `mcp__foo__exec_command`), `payload.namespace` = server name (newer CLIs populate it directly — prefer `namespace` when present, else split name on `__`), `payload.arguments` = JSON string, `payload.call_id`. Result via `function_call_output`.

### 5.5 Messages / other

- `message`: `{id: "msg_...", role: "user|assistant|developer", content: [{type: "input_text"|"output_text"|"input_image"..., text}], phase?, internal_chat_message_metadata_passthrough: {turn_id, create_time}}`. Developer-role messages carry injected system scaffolding (environment context, skills list, multi-agent instructions) — they are model-facing, not user actions.
- `agent_message`: `{author, recipient, content}` — agent-to-agent chat inside one thread.
- `reasoning`: `{summary: [{type: summary_text, text}], content?, encrypted_content}`.
- `image_generation_call`: `{status, revised_prompt?, result}`.
- `compaction`/`context_compaction`: encrypted summary markers.
- Every persisted item may carry `internal_chat_message_metadata_passthrough.turn_id` — the reliable turn grouping key alongside the most recent `turn_context`.

## 6. `event_msg` payloads (what actually persists)

Persisted in **paginated** mode (all local files): `item_completed` (TurnItem; `item.type` is **PascalCase** on the wire, e.g. `"UserMessage"`, `"FunctionCallOutput"`, `"PlanUpdate"`, `"SubAgentActivity"`), `token_count`, `task_started` (v1 wire name; newer CLIs emit `turn_started`, serde alias accepts both — treat as same event), `task_complete`/`turn_complete` (fields: `last_agent_message`, `error{message, codex_error_info}`, `duration_ms`), `turn_aborted` (`reason: "interrupted"|...`), `thread_settings_applied`, `thread_rolled_back`, `thread_goal_updated`. In **legacy**-mode files you may additionally see `user_message`, `agent_message`, `agent_reasoning`, `patch_apply_end`, `mcp_tool_call_end`, `web_search_end`, `sub_agent_activity` — do not rely on them (absent in paginated files).

## 7. Real record examples (local corpus, values truncated where marked)

`session_meta (real, codex exec 0.149.1) - line 1`
```json
{"timestamp": "2026-09-17T08:22:53.411Z", "ordinal": 0, "type": "session_meta", "payload": {"session_id": "01a0ae76-2436-7590-9a11-216f21269bb4", "id": "01a0ae76-2436-7590-9a11-216f21269bb4", "timestamp": "2026-09-17T08:22:53.242Z", "cwd": "D:\\compare", "originator": "codex_exec", "cli_version": "0.149.1", "source": "exec", "thread_source": "user", "model_provider": "custom", "base_instructions": {"text": "You are Codex, a coding agent based on GPT-5. You and the user share one workspace, and your job is  ...[TRUNCATED, 21335 chars total]", "provenance": {"type": "model", "model": "glm-5.3"}}, "history_mode": "paginated", "context_window": {"window_id": "01a0ae76-2436-7590-9a11-217324147bd9"}}}
```

`turn_context (real) - line 6`
```json
{"timestamp": "2026-09-17T08:22:53.506Z", "ordinal": 5, "type": "turn_context", "payload": {"turn_id": "01a0ae76-249c-7d50-8741-f6c69ea4ef30", "cwd": "D:\\compare", "workspace_roots": ["D:\\compare"], "current_date": "2026-09-17", "timezone": "Asia/Shanghai", "approval_policy": "never", "approvals_reviewer": "user", "sandbox_policy": {"type": "read-only"}, "permission_profile": {"type": "managed", "file_system": {"type": "restricted", "entries": [{"path": {"type": "special", "value": {"kind": "root"}}, "access": "read"}]}, "network": "restricted"}, "model": "glm-5.3", "personality": "pragmatic", "collaboration_mode": {"mode": "default", "settings": {"model": "glm-5.3", "reasoning_effort": "high", "developer_instructions": null}}, "multi_agent_version": "v1", "realtime_active": false, "effort": "high", "summary": "auto"}}
```

`response_item / message (real, user prompt) - line 7`
```json
{"timestamp": "2026-09-17T08:22:53.537Z", "ordinal": 6, "type": "response_item", "payload": {"type": "message", "id": "msg_01a0ae76-2561-7941-af2c-726e317cff04", "role": "user", "content": [{"type": "input_text", "text": "reply with just: ok"}], "internal_chat_message_metadata_passthrough": {"turn_id": "01a0ae76-249c-7d50-8741-f6c69ea4ef30", "create_time": 1789633373.5372808}}}
```

`event_msg / task_started (real) - line 2`
```json
{"timestamp": "2026-09-17T08:22:53.412Z", "ordinal": 1, "type": "event_msg", "payload": {"type": "task_started", "turn_id": "01a0ae76-249c-7d50-8741-f6c69ea4ef30", "started_at": 1789633373, "model_context_window": 190000, "collaboration_mode_kind": "default"}}
```

`event_msg / task_complete with backend error (real) - line 9`
```json
{"timestamp": "2026-09-17T08:23:00.280Z", "ordinal": 8, "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "01a0ae76-249c-7d50-8741-f6c69ea4ef30", "last_agent_message": null, "error": {"message": "unexpected status 404 Not Found: Unknown error, url: https://open.bigmodel.cn/api/coding/paas/v4/responses", "codex_error_info": "other"}, "started_at": 1789633373, "completed_at": 1789633380, "duration_ms": 6902}}
```

`event_msg / turn_aborted (real) - line 17`
```json
{"timestamp": "2026-08-19T02:17:38.343Z", "ordinal": 16, "type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": "01a017cd-606e-7c51-9b77-8a07c827509e", "reason": "interrupted", "started_at": 1787105730, "completed_at": 1787105858, "duration_ms": 127657}}
```

`event_msg / item_completed (real) - line 10`
```json
{"timestamp": "2026-08-19T02:15:31.017Z", "ordinal": 9, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": "01a017cc-b8dc-7362-9893-c81c975294d2", "turn_id": "01a017cd-606e-7c51-9b77-8a07c827509e", "item": {"type": "UserMessage", "id": "01a017cd-61c8-7b91-898c-f474690bddbd", "content": [{"type": "text", "text": "你是谁？", "text_elements": []}]}, "started_at_ms": 1787105731016, "completed_at_ms": 1787105731016}}
```

`world_state (real structure, values truncated by hand) - line 7`
```json
{"timestamp": "2026-08-19T02:15:30.957Z", "ordinal": 6, "type": "world_state", "payload": {"full": true, "state": {"agents_md": {}, "apps_instructions": false, "collaboration_mode": {"mode": "default", "model": "gpt-5.6-sol"}, "environments": {"environments": {"local": {"cwd": "D:\\Project\\hunan-3-resource", "status": "available", "shell": "powershell"}}, "current_date": "2026-08-19", "timezone": "Asia/Shanghai", "filesystem": "<filesystem><workspace_roots>...</workspace_roots></filesystem> [TRUNCATED]"}, "environments_instructions": false, "git_attribution": false, "host_ski": "... [TRUNCATED, 3863 chars total payload]"}}}
```

## 8. Mapping to agentaudit `Event` model (`src/agentaudit/events.py`)

Common: `session_id = session_meta.session_id` (== thread id; for sub-agent files this is the sub-agent's own id — `parent_thread_id` links to the root); `project = session_meta.cwd` (matches claude parser convention: project = cwd); `timestamp = line.timestamp` (RFC3339 → datetime). `cwd` for ShellCommand: most recent `turn_context.cwd` at or before the line, else `session_meta.cwd`.

| Codex record (JSON path) | agentaudit Event | Field derivation | Gaps / notes |
|---|---|---|---|
| `response_item` / `function_call`, name `exec_command` or `shell` | `ShellCommand` | `raw = json.loads(payload.arguments)["cmd"]` (exec_command) or `join(command)` (shell, array form); `cwd = arguments["workdir"] else turn_context.cwd` | args is a JSON **string** (double parse); output/exit code only via `function_call_output` join on `call_id` |
| `response_item` / `local_shell_call` | `ShellCommand` | `raw = join(payload.action.command)`; `cwd = payload.action.working_directory else turn_context.cwd` | legacy/provider-specific; command already an array |
| `response_item` / `custom_tool_call`, name `apply_patch` | `FileWrite` (one per file entry) | parse V4A text in `payload.input`; `path` from `Add/Update/Delete File:` line; `content` = added lines for Add, `None` (diff) for Update | Update File gives diff not content; Delete File → content None; shell-redirect writes invisible (only ShellCommand) |
| `response_item` / `web_search_call` | `NetworkRequest` | `url = payload.action.url or query-derived`; `method = None` | only web_search tool surfaces URLs; HTTP via shell is not represented |
| `response_item` / `function_call` with `namespace` or name containing `__` | `McpToolCall` | `server = payload.namespace or name.split("__")[0]` (strip legacy `mcp__`); `tool = remainder`; `args_hint = truncate(arguments string)` | arguments JSON string; result via `function_call_output` |
| `response_item` / `message` (role user) | (candidate new `UserPrompt` event) | `content[].text` | current Event model has no prompt event — skip or extend |
| `response_item` / `message` (role developer) | skip | — | injected scaffolding, not user action |
| `inter_agent_communication` | **gap — propose `AgentMessage`/`Delegation` event** | `author`, `recipient`, `content`, `trigger_turn` | multi-agent delegation audit needs this; not in current model |
| `event_msg` / `task_complete` (error != null) | (session health annotation) | `error.message` contains backend URL + status | useful for "session died" contexts |
| `event_msg` / `turn_aborted` | (annotation) | `reason` | user interrupt |
| `token_count`, `world_state`, `turn_context`, `compacted`, `reasoning`, `image_generation_call`, `tool_search_*` | skip (v1) | — | `turn_context` still consumed for cwd/model context |

Rule-engine relevant nuance: `sandbox_permissions: "require_escalated"` in exec_command args = explicit sandbox-escape request — cheap, high-signal rule for the unsafe-command detector, unique to Codex.

## 9. Parser hazards

1. **Double-encoded JSON**: `function_call.arguments` is a string; `apply_patch.input` is raw text — three different decodings across tool families.
2. **Huge lines**: base_instructions alone yields 17–22 KB lines here; production TUI sessions embed full command outputs and file patches → lines of MBs are possible. Read line-by-line with no length cap; do not use fixed-size buffers. (Related: `.jsonl.zst` rollouts exist in newer builds.)
3. **Unknown types, both levels**: new `RolloutItem` and new `ResponseItem` variants appear across versions (`world_state`, `turn_context` gained fields mid-2026; `item_completed` items are PascalCase vs snake_case elsewhere). Never hard-fail on unknown `payload.type`.
4. **Name drift**: `task_started`/`task_complete` (older) vs `turn_started`/`turn_complete` (newer alias); shell tool `shell` (array) vs `exec_command` (string cmd) vs `local_shell_call`; MCP name with/without `mcp__` prefix; `agent_type`→`agent_role` alias.
5. **Unicode**: CJK text appears verbatim (UTF-8, unescaped by serde unless control chars). On Windows, open files with `encoding="utf-8"` explicitly (default cp936/GBK would crash — this is the single most likely Windows-only bug).
6. **No BOM / trailing newline present** locally, but tolerate BOM and a missing final newline anyway.
7. **Non-JSON lines**: none observed; still, skip-and-count rather than raise (crash-safety: codex itself may die mid-write leaving a partial last line — an append-only log can be torn at the tail).
8. **Multi-window/paginated history**: `history_mode: "paginated"` + `compacted`/`window_id` means a session's early lines may be summarized away; ordinals are per-file, so "one session" == "one file" (or several files after fork/revert: `<thread>_<rollout>` suffix).

## 10. Suggested parser task breakdown (estimate: ~0.5–1 dev-day total)

1. **T1 Discovery** (0.5h): glob `~/.codex/sessions/*/*/*/*.jsonl` (+ `archived_sessions`, ignore/skip `.zst` v1), sort by mtime; parse filename → (timestamp, thread_id).
2. **T2 Line reader** (1h): streaming UTF-8 reader, per-line `try/except` → skip bad/torn lines with counter; tolerant BOM handling.
3. **T3 Envelope + session context** (1h): parse envelope; capture `session_meta` (session_id/cwd/project/parent_thread_id/thread_source), track rolling `turn_context.cwd` per file.
4. **T4 Shell mapping** (1.5h): function_call(exec_command|shell) + local_shell_call → `ShellCommand`; double-parse arguments; flag `sandbox_permissions: require_escalated`.
5. **T5 FileWrite mapping** (2h): apply_patch V4A line-scan parser (Add/Update/Delete) → `FileWrite[]`; keep raw patch in content for Update.
6. **T6 Network + MCP** (1h): web_search_call → NetworkRequest; namespaced function_call → McpToolCall.
7. **T7 Tolerant skip + fixtures** (1h): unknown-type skip policy; fixture = one local real file (has CJK, errors, turn_aborted) + synthetic tool-call lines built from §5 shapes (no tool-call records exist locally).
8. **T8 Multi-agent (optional, after v1)**: inter_agent_communication → proposed Delegation event; sub-agent files joined via `parent_thread_id`.

## 11. Sample corpus for tests

All 5 local files are small enough to commit as fixtures after truncating `base_instructions.text` (they contain no secrets; provider error messages contain public API URLs only). Recommended: keep `2026-09-17` (exec, glm, error path) and `2026-08-19` (tui, gpt-5.6-sol, turn_aborted, git meta) as the primary fixtures.
