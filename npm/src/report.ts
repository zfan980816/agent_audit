// Report rendering: terminal (picocolors + cli-table3), JSON dict, share card.
// Faithful port of src/agentaudit/report.py (Python is the spec).
import Table from "cli-table3";
import pc from "picocolors";

import type { AuditResult } from "./engine.js";
import { SEVERITY_ORDER, type Severity } from "./events.js";
import type { Finding } from "./rules/base.js";

export type WriteFn = (chunk: string) => void;

// Python: SEV_LABEL (also consumed by the CLI's --list-rules table)
export const SEV_LABEL: Record<Severity, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

// Python: SEV_STYLE via picocolors — "bold white on red" -> white text on red
// background, bolded. NOTE: picocolors colors UNCONDITIONALLY on win32 (even
// off-TTY); the CLI layer must set NO_COLOR when stdout is not a TTY to match
// rich's isatty gating.
function colorSev(text: string, sev: Severity): string {
  switch (sev) {
    case "critical":
      return pc.bgRed(pc.bold(pc.white(text)));
    case "high":
      return pc.bold(pc.red(text));
    case "medium":
      return pc.yellow(text);
    case "low":
      return pc.cyan(text);
    case "info":
      return pc.dim(text);
  }
}

// Python: _SEV_ORDERED = list(reversed(SEVERITY_ORDER))  # critical -> info
const SEV_ORDERED: readonly Severity[] = [...SEVERITY_ORDER].reverse();

// Python datetime.isoformat() for tz-aware UTC values: "+00:00" offset,
// microseconds included only when nonzero (6 digits). Parsed timestamps are
// always UTC-normalized (Z inputs), so a UTC formatter is exact.
function pyIso(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const us = d.getUTCMilliseconds() * 1000;
  return us ? `${base}.${p(us, 6)}+00:00` : `${base}+00:00`;
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
  // zero-fill all five severities in critical->info order so the object is
  // directly JSON-serializable as Python's by_severity (insertion order kept)
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
  }
  return counts;
}

export function filterBySeverity(
  findings: Finding[],
  floor: Severity,
): Finding[] {
  const floorIdx = SEVERITY_ORDER.indexOf(floor);
  return findings.filter((f) => SEVERITY_ORDER.indexOf(f.severity) >= floorIdx);
}

// Python: re.split(r"[\\/]", project.replace("\\\\", "\\"))[-1] or project
// (collapse doubled backslashes first, then take the last /-or-\-separated
// segment; a trailing separator leaves an empty last segment -> whole string)
function shortProject(project: string): string {
  const parts = project.replace(/\\\\/g, "\\").split(/[\\/]/);
  return parts[parts.length - 1] || project;
}

// Python: ts.strftime("%m-%d %H:%M") if ts else "-"
// UTC getters on purpose: Python stores tz-aware UTC datetimes (real data is
// always Z-suffixed) and strftime prints the stored fields, which getUTC*
// recovers exactly. Local getters would shift them outside UTC timezones.
function shortTs(ts: Date | null): string {
  if (!ts) {
    return "-";
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${p2(ts.getUTCMonth() + 1)}-${p2(ts.getUTCDate())} ` +
    `${p2(ts.getUTCHours())}:${p2(ts.getUTCMinutes())}`
  );
}

// SGR sequences wrap whole segments, so border/padding math must measure the
// visible (code-stripped) width while emitting colored content verbatim.
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.replace(ANSI_SGR, "").length));
}

// Python render_terminal(result, floor, console=None) -> the injected `write`
// replaces Console(file=buf) for tests; default writes to process.stdout.
export function renderTerminal(
  result: AuditResult,
  floor: Severity = "low",
  write: WriteFn = (chunk) => process.stdout.write(chunk),
): void {
  const out = (line: string) => write(`${line}\n`);
  const findings = filterBySeverity(result.findings, floor);
  const counts = severityCounts(findings);

  // summary block (Python: rich Panel titled "agentaudit", expand=False)
  const summaryLine =
    `files ${result.filesScanned} · sessions ${result.sessions.size} · ` +
    `events ${result.events} · findings ${findings.length}`;
  const sevLine = SEV_ORDERED.map(
    (sev) => `${counts[sev]} ${colorSev(SEV_LABEL[sev], sev)}`,
  ).join("  ");
  const width = Math.max(
    summaryLine.length,
    sevLine.replace(ANSI_SGR, "").length,
  );
  out(`┌─ agentaudit ${"─".repeat(Math.max(0, width - 11))}┐`);
  out(`│ ${padEndVisible(summaryLine, width)} │`);
  out(`│ ${padEndVisible(sevLine, width)} │`);
  out(`└${"─".repeat(width + 2)}┘`);

  // 7-col table. rich ratios SEV8/RULE6/FINDING30/PROJECT16/SESSION10/WHEN11/
  // EVIDENCE40 are usable text width, but cli-table3 colWidths INCLUDE the
  // 1+1 padding, so each is widened by 2. wordWrap + wrapOnWordBoundary:false
  // reproduces rich's overflow="fold": hard character fold, never the
  // ellipsis truncation cli-table3 defaults to on unbroken strings.
  // Evidence cells stay RAW text: cli-table3 interprets nothing, so the rich
  // markup-injection pitfall (evidence "del /s [/etc] /q") has no TS
  // equivalent to defend against.
  const table = new Table({
    head: ["SEV", "RULE", "FINDING", "PROJECT", "SESSION", "WHEN", "EVIDENCE"],
    colWidths: [10, 8, 32, 18, 12, 13, 42],
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: { head: [], border: [] },
  });
  for (const f of findings.slice(0, 200)) {
    table.push([
      // plain label: Python passes SEV_LABEL as a plain str too — SEV_STYLE
      // colors only the summary panel's severity line (and a colored cell
      // would be split mid-escape-sequence by cli-table3's hard fold)
      SEV_LABEL[f.severity],
      f.ruleId,
      f.title,
      shortProject(f.event.project),
      f.event.sessionId.slice(0, 8),
      shortTs(f.event.timestamp),
      f.evidence,
    ]);
  }
  out(table.toString());

  if (result.linesSkipped) {
    out(pc.dim(`skipped ${result.linesSkipped} malformed lines`));
  }
  if (result.filesFailed) {
    out(pc.yellow(`failed to read ${result.filesFailed} file(s)`));
  }
  // M7: exempted findings (info + note) are hidden by the default floor —
  // surface the count so the downgrade is visible, never silent
  const exempted = result.findings.filter((f) => f.note !== undefined).length;
  if (exempted > 0) {
    out(pc.dim(`${exempted} finding(s) exempted → info (agent-deleted own content / build artifacts)`));
  }
  if (findings.length > 200) {
    out(pc.dim(`showing first 200 of ${findings.length} findings`));
  }
}

// JSON shape of one finding — Python emits snake_case, and the key order below
// is Python's dict-literal order (T8 equivalence gate; Object.keys preserves
// insertion order in JSON.stringify).
export interface ReportFindingDict {
  rule_id: string;
  severity: Severity;
  title: string;
  evidence: string;
  project: string;
  session_id: string;
  timestamp: string | null;
  explanation: string;
  recommendation: string;
  // M7 (v0.3.x TS-canonical): exemption note from the D001 creator-immunity
  // downgrade. Emitted ONLY when present and appended LAST, so noteless
  // findings keep the exact Python v0.1 key list (T8 gate).
  note?: string;
}

export interface ReportDict {
  summary: {
    files: number;
    files_failed: number;
    sessions: number;
    events: number;
    lines_skipped: number;
    total: number;
    by_severity: Record<Severity, number>;
    // v0.2.x multi-agent (M1): files attempted per agent. TS canonical schema
    // (Python frozen at v0.1.1 has no by_agent); appended AFTER the
    // Python-parity prefix so the v0.1 key order is preserved.
    by_agent: Record<string, number>;
  };
  findings: ReportFindingDict[];
}

export function toDict(result: AuditResult): ReportDict {
  const counts = severityCounts(result.findings);
  return {
    summary: {
      files: result.filesScanned,
      files_failed: result.filesFailed,
      sessions: result.sessions.size,
      events: result.events,
      lines_skipped: result.linesSkipped,
      total: result.findings.length,
      // severityCounts zero-fills in critical->info order, matching Python's
      // {sev.value: counts[sev] for sev in _SEV_ORDERED}
      by_severity: { ...counts },
      by_agent: { ...result.byAgent },
    },
    findings: result.findings.map((f): ReportFindingDict => {
      const d: ReportFindingDict = {
        rule_id: f.ruleId,
        severity: f.severity,
        title: f.title,
        evidence: f.evidence,
        project: f.event.project,
        session_id: f.event.sessionId,
        // Python: datetime.isoformat() emits "+00:00" offsets and omits
        // microseconds when zero — NOT what toISOString() produces ("Z",
        // always ".000"). pyIso mirrors it for byte-identical JSON output.
        timestamp: f.event.timestamp ? pyIso(f.event.timestamp) : null,
        explanation: f.explanation,
        recommendation: f.recommendation,
      };
      // M7: note only when present, appended LAST in key order
      if (f.note !== undefined) {
        d.note = f.note;
      }
      return d;
    }),
  };
}

export function shareCard(result: AuditResult): string {
  const counts = severityCounts(result.findings);
  const stats =
    SEV_ORDERED.filter((sev) => counts[sev] > 0)
      .map((sev) => `${SEV_LABEL[sev]} ${counts[sev]}`)
      .join(" · ") || "no findings";
  return (
    "──── agent-audit · AI agent safety report ────\n" +
    `Sessions: ${result.sessions.size}   ${stats}\n` +
    "Audit your own agents → npx @fanzhen/agent-audit"
  );
}
