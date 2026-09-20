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
```

Python 3.10+ alternative: `uvx agent-audit` (no install) or
`pipx install agent-audit` (command name: `agentaudit`).

- 100% local parsing. No network calls, no telemetry, ever.
- Works on Windows, macOS and Linux.

Exit codes: `0` on success (findings do NOT change the exit code yet — a
`--fail-on` flag is planned), `2` on bad options or missing data dir.

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
