// Pipeline engine: files -> events -> findings.
// Faithful port of src/agentaudit/engine.py (Python is the spec), extended in
// v0.2.x (M1) for multi-agent input: entries may be plain paths (routed to the
// claude-code parser, keeping every v0.1 caller/test unchanged) or
// {agent, path} tags routed through the agent registry.
import { AGENTS, type AgentFileEntry } from "./agents.js";
import { SEVERITY_ORDER } from "./events.js";
import { ParseStats } from "./parsers/claude-code.js";
import type { Finding } from "./rules/base.js";
import { allRules } from "./rules/index.js";

export type AuditEntry = string | AgentFileEntry;

// Python: @dataclass AuditResult — fresh mutable defaults per instance
// (default_factory for findings / sessions).
export class AuditResult {
  findings: Finding[] = [];
  filesScanned = 0;
  filesFailed = 0;
  linesTotal = 0;
  linesSkipped = 0;
  events = 0;
  sessions: Set<string> = new Set();
  // v0.2.x (TS canonical, no Python parity): files attempted per agent,
  // insertion-ordered by first encounter (deterministic given sorted input).
  byAgent: Record<string, number> = {};
}

export async function runAudit(
  files: Iterable<AuditEntry> | AsyncIterable<AuditEntry>,
  rulePrefixes?: Set<string>,
  sessionId?: string,
): Promise<AuditResult> {
  // rules built ONCE per call, filtered by the category letter (id[0]).
  const rules = allRules().filter(
    (r) => rulePrefixes === undefined || rulePrefixes.has(r.id[0]),
  );
  const result = new AuditResult();
  const stats = new ParseStats();
  // Python iterates a plain list of paths; the TS entry also accepts an async
  // source (for-await handles sync iterables too), so discovery can stream.
  for await (const entry of files) {
    const tagged: AgentFileEntry =
      typeof entry === "string" ? { agent: "claude-code", path: entry } : entry;
    const agent = AGENTS[tagged.agent];
    if (!agent) {
      throw new Error(
        `unknown agent id: ${tagged.agent} (known: ${Object.keys(AGENTS).join(", ")})`,
      );
    }
    result.filesScanned += 1;
    result.byAgent[tagged.agent] = (result.byAgent[tagged.agent] ?? 0) + 1;
    try {
      // Error-class catch strategy (port decision): Python wraps the WHOLE
      // per-file block — including rule checks — in `except OSError`. OSError
      // has no JS equivalent; Node fs errors are `Error` instances carrying a
      // string `code` property (ENOENT/EACCES/EISDIR, ...). Catch exactly
      // those (unreadable file -> count loudly instead of aborting the audit)
      // and rethrow everything else so a rule-check bug still surfaces
      // instead of being silently eaten as "unreadable file".
      for await (const event of agent.parser.iterEvents(tagged.path, stats)) {
        // session filter BEFORE sessions.add
        if (sessionId != null && event.sessionId !== sessionId) {
          continue;
        }
        result.sessions.add(event.sessionId);
        for (const rule of rules) {
          if (!rule.appliesTo.some((ctor) => event instanceof ctor)) {
            continue;
          }
          const finding = rule.check(event);
          if (finding !== null) {
            result.findings.push(finding);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string") {
        // unreadable file (deleted mid-run, AV/indexer lock, permissions):
        // count loudly instead of aborting the whole audit
        result.filesFailed += 1;
      } else {
        throw err;
      }
    }
  }
  result.linesTotal = stats.linesTotal;
  result.linesSkipped = stats.linesSkipped;
  result.events = stats.events;
  // severity-descending, STABLE: Array.prototype.sort is guaranteed stable
  // since ES2019 (matching Python's Timsort), so same-severity findings keep
  // file order.
  result.findings = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity),
  );
  return result;
}
