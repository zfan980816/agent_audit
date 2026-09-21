// Pipeline engine: files -> events -> findings.
// Faithful port of src/agentaudit/engine.py (Python is the spec), extended in
// v0.2.x (M1) for multi-agent input: entries may be plain paths (routed to the
// claude-code parser, keeping every v0.1 caller/test unchanged) or
// {agent, path} tags routed through the agent registry.
import { AGENTS, type AgentFileEntry } from "./agents.js";
import { FileWrite, SEVERITY_ORDER, ShellCommand } from "./events.js";
import { applyCreatorImmunity, extractCreatedPaths, normalizeForCompare } from "./immunity.js";
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
  // M7 (v0.3.x TS-canonical): per-run, per-session set of written paths,
  // accumulated in stream order (same per-run state discipline as E005's
  // lastArchive map — never outlives one scan). Feeds the D001
  // creator-immunity downgrade: writes AFTER a delete do not cover it.
  const writtenBySession = new Map<string, Set<string>>();
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
        if (event instanceof FileWrite && event.path) {
          let written = writtenBySession.get(event.sessionId);
          if (written === undefined) {
            written = new Set();
            writtenBySession.set(event.sessionId, written);
          }
          written.add(normalizeForCompare(event.path));
        } else if (event instanceof ShellCommand) {
          // M7v2: bash-creation provenance — paths this command line CREATES
          // (mkdir/touch/redirect/tee/cp/mv/git clone/curl -o) join the same
          // per-session set in stream order, so creations cover only LATER
          // deletes. Documented choice: creations from segments BEFORE the
          // line's first delete count for that line too (`mkdir x &&
          // rm -rf x` is info) — but a delete that runs BEFORE its creation
          // (`rm -rf x && mkdir x`) is NOT whitewashed (M7v2 review Issue 1;
          // beforeFirstDelete makes the feed position-aware).
          const created = extractCreatedPaths(event.raw, event.cwd, {
            beforeFirstDelete: true,
          });
          if (created.length > 0) {
            let written = writtenBySession.get(event.sessionId);
            if (written === undefined) {
              written = new Set();
              writtenBySession.set(event.sessionId, written);
            }
            for (const p of created) {
              written.add(normalizeForCompare(p));
            }
          }
        }
        for (const rule of rules) {
          if (!rule.appliesTo.some((ctor) => event instanceof ctor)) {
            continue;
          }
          const finding = rule.check(event);
          if (finding !== null) {
            // M7: downgrade BEFORE the severity sort below, so both the sort
            // and by_severity reflect the exemption (spec rule 5). Only D001
            // participates — applyCreatorImmunity re-guards on the rule id.
            if (finding.ruleId === "D001") {
              applyCreatorImmunity(
                finding,
                writtenBySession.get(event.sessionId),
              );
            }
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
