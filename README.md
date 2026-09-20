# agentaudit

**npm audit for your AI coding agents.**

One command scans your local Claude Code session history and reports every
dangerous action your agents ever took — destructive commands, credential
access, data exfiltration, persistence installs, unsafe downloads.

```bash
uvx agent-audit         # audit ~/.claude/projects immediately
agentaudit --demo       # no Claude Code? try the built-in demo
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

Requires Python 3.10+.

```bash
pipx install agent-audit   # or: uvx agent-audit (no install)
agentaudit                # audit default location
agentaudit ~/somewhere    # audit a custom projects dir / .jsonl file
agentaudit --json         # machine-readable output
agentaudit --severity high --rules E,C
agentaudit --session <id> # one session only
agentaudit --share        # print a shareable summary card
```

- 100% local parsing. No network calls, no telemetry, ever.
- Works on Windows, macOS and Linux.

Exit codes: `0` on success (findings do NOT change the exit code yet — a
`--fail-on` flag is planned for v0.2), `2` on bad options or missing data dir.

## Roadmap

- v0.2: Codex CLI / Gemini CLI parsers, SARIF export
- v0.3: guard mode — block dangerous actions before they run (PreToolUse hooks)

## License

MIT
