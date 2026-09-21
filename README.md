# agentaudit

**npm audit for your AI coding agents.**

One command scans your local Claude Code session history and reports every
dangerous action your agents ever took — destructive commands, credential
access, data exfiltration, persistence installs, unsafe downloads.

```bash
npx agent-audit         # audit ~/.claude/projects immediately
agent-audit --demo      # no Claude Code? try the built-in demo
```

```
───────────────────── agentaudit ─────────────────────
files 42 · sessions 87 · events 12,340 · findings 23
 4 CRITICAL   9 HIGH   6 MEDIUM   4 LOW
──────────────────────────────────────────────────────
```

## What it detects (28 rules)

| Category | Examples |
|---|---|
| 🟥 Destructive | `rm -rf`, `git reset --hard`, force push, disk erase |
| 🔑 Credential access | reading `.env`, `id_rsa`, `~/.aws`, keychain queries |
| 📤 Exfiltration | `cat .env \| curl`, uploads to paste sites/webhooks |
| 🚪 Bypass & persistence | loosened `settings.json`, `.bashrc` edits, cron, `authorized_keys` |
| ⚠️ Unsafe execution | `curl \| sh`, base64 payloads, cloud metadata endpoints, reverse shells |

`agentaudit --list-rules` shows all of them with severities.

## Why

Agents run shell commands all day. In April 2026, Claude Code's deny rules
were shown to be silently bypassable and multiple command-injection flaws
were disclosed. Nobody reviews what their agent already did — until now.

## Install & usage

Requires Node 18+.

```bash
npx agent-audit            # run without installing, or: npm i -g agent-audit
agent-audit                # audit default location
agent-audit ~/somewhere    # audit a custom projects dir / .jsonl file
agent-audit --json         # machine-readable output
agent-audit --severity high --rules E,C
agent-audit --session <id> # one session only
agent-audit --share        # print a shareable summary card
agent-audit --watch        # LIVE egress monitor (Windows; see below)
agent-audit --footprint    # what Qoder indexed locally (see below)
```

Python 3.10+ alternative: `uvx agent-audit` (no install) or
`pipx install agent-audit` (command name: `agentaudit`).

- 100% local parsing. No network calls, no telemetry, ever.
- Works on Windows, macOS and Linux.

## Watch mode (v0.2.x, Windows only)

Besides auditing history, agent-audit can also watch what your AI coding
tools are connecting to RIGHT NOW: it polls the TCP table (each poll spawns a PowerShell query — effective cadence is a few seconds) for the
watched processes' established connections, labels each target against a
built-in registry of known-agent domains (`model-api` / `telemetry` /
`update` / `captcha` / `community`), and alerts on anything outside it.

```bash
agent-audit --watch                          # watch all known AI tools, 60s
agent-audit --watch --proc ZCode,QoderCN     # specific processes (no .exe)
agent-audit --watch --seconds 300 --csv out.csv   # record to CSV
```

```
[10:13:37] claude(11852) → 160.79.104.10:443 api.anthropic.com (model-api)
[!] [10:13:37] claude(11852) → 47.96.134.91:443 (unknown — no DNS mapping observed)
──── agent-audit watch ────
watched 14s · procs 3 · polls 5 · new connections 3 · dns entries 11
by category: model-api 1 · unknown 2
[!] unknown targets: 47.96.134.91:443 (claude)
```

Hostnames come from the Windows DNS cache sampled during the watch — an IP
that never resolves there is reported as unknown, never guessed. Ctrl+C stops
early and still prints the summary. On non-Windows platforms `--watch` exits
with code 2 (`watch: Windows-only in v0.2.x`).

Exit codes: `0` on success (findings do NOT change the exit code yet — a
`--fail-on` flag is planned), `2` on bad options or missing data dir.

## Footprint mode (v0.2.x): what has Qoder collected?

`--footprint` answers a different question than the audit: not "what did an
agent DO" but "what does a tool hold FROM you". For Qoder CN it inventories
the local index stores under `~/.qoder-cn/shared_client/`: per repo it reads
the vector index's chunk table (absolute file paths — metadata
only), counts completion-index `.zap` segments (which hold recoverable source
text — reported as files + bytes, never opened), git/graph index sizes,
project-memory file names, and workspace memory notes.

```bash
agent-audit --footprint                  # inventory ~/.qoder-cn
agent-audit --footprint --json           # machine-readable (includes the file list)
agent-audit --footprint --agent qoder    # explicit (only qoder in v0.2.x)
```

Privacy: the report LISTS what was collected (repos, file paths, chunk
counts, index timestamps) — it never reads or prints file CONTENT. Exits 2
for any other `--agent`.

## Non-goals (v0.2.x, stated plainly)

- **A tool's own background network traffic at content level**: TLS-encrypted
  on the wire; `--watch` reports WHO it talks to, not WHAT it sends. For
  content-level proof use the canary method (unique marker strings planted in
  a throwaway repo, then searched in the tool's local stores and captured
  traffic).
- **Trae chat history**: stored locally in an encrypted database — not
  auditable until the format opens up.
- **Qoder chat history**: lives server-side; only the local data footprint
  (see `--footprint`) is visible.

## Implementation note

v0.2 rewrote agent-audit in TypeScript as the canonical implementation
(`npm/`) — output-equivalent to the Python original on the v0.1 surface,
verified by an automated equivalence harness on the demo, boundary corpora,
and real session data (v0.2.x adds TS-only summary fields such as `by_agent`,
which the harness normalizes out of the parity comparison). The Python
implementation (`src/agentaudit`) is frozen at v0.1.1 as the porting
reference and spec.

## Roadmap

- v0.2: done — TypeScript/npm canonical port (byte-for-byte equivalent to the Python original)
- v0.2.x: Codex CLI / Gemini CLI parsers, SARIF export
- v0.3: guard mode — block dangerous actions before they run (PreToolUse hooks)

## License

MIT
