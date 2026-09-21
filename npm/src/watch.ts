// M5: watch mode core — live per-process TCP egress monitoring with domain
// classification. TS port of the manual D:/zcode-test/watch_egress.ps1
// polling design (Get-NetTCPConnection + Get-DnsClientCache, ~700ms cadence,
// dedupe on proc|ip|port), productized per the multi-agent plan.
//
// Testability contract: runWatch(opts, deps) takes EVERYTHING it touches as
// an injectable dep (poll/now/sleep/writeLine/appendCsv/platform). Unit
// tests NEVER spawn powershell — the real poller lives in watch-poller.ts
// and is wired only by the CLI (cli.ts -> defaultWatchDeps()).
//
// Honesty rules (binding design decisions):
//   - connections are remote IPs; hostname labels only come from the DNS
//     cache sampled during the watch window;
//   - an IP with no DNS mapping is category "unknown" with a note, never a
//     guessed IP-range label (domain registries' ranges are too broad);
//   - a DNS-resolved hostname outside DOMAIN_RULES is also "unknown" and is
//     alerted ([!]) as a whitelist-external domain.
import { existsSync, appendFileSync, statSync } from "node:fs";

import { CATEGORY_ORDER, classify } from "./domains.js";

export const WATCH_INTERVAL_MS = 700;
export const WATCH_DEFAULT_SECONDS = 60;
export const WATCH_WINDOWS_MESSAGE =
  "watch: Windows-only in v0.2.x (needs Get-NetTCPConnection/Get-DnsClientCache via PowerShell)";

export class WatchUnsupportedError extends Error {
  constructor() {
    super(WATCH_WINDOWS_MESSAGE);
    this.name = "WatchUnsupportedError";
  }
}

// Default watch list: AI coding tool process names observed on the dev
// machine / known installs (Get-Process names, no .exe suffix). Users add to
// it with --proc (replaces the default; comma separated).
export const DEFAULT_WATCH_PROCS: readonly string[] = [
  "ZCode",
  "QoderCN",
  "Qoder",
  "Trae",
  "Trae CN",
  "kimi",
  "kimi-code",
  "codex",
  "claude",
  "gemini",
];

export interface RawConn {
  proc: string;
  pid: number;
  ip: string;
  port: number;
}

export interface DnsEntry {
  host: string;
  ip: string;
}

export interface PollSample {
  conns: RawConn[];
  dns: DnsEntry[];
}

export interface WatchConn {
  at: Date;
  proc: string;
  pid: number;
  ip: string;
  port: number;
  // DNS-cache-resolved hostname, null when the IP was never resolved during
  // the watch window.
  host: string | null;
  // Registry category or "unknown".
  category: string;
  note: string | null;
}

export interface WatchResult {
  procs: string[];
  seconds: number;
  elapsedMs: number;
  // completed poll cycles with a successful sample
  polls: number;
  // poll cycles whose sample could not be collected
  pollErrors: number;
  // unique hostnames observed in the DNS cache during the watch
  dnsEntries: number;
  connections: WatchConn[];
  byCategory: Record<string, number>;
  byProc: Record<string, number>;
  // "[!] host|ip:port (proc)" strings in first-seen order (unknown category)
  unknownTargets: string[];
}

export interface WatchOptions {
  procs: string[];
  seconds: number;
  csvPath?: string;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface WatchDeps {
  platform?: string;
  poll: (procs: string[]) => Promise<PollSample>;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  writeLine?: (line: string) => void;
  appendCsv?: (path: string, line: string) => void;
}

export const CSV_HEADER = "ts,proc,pid,remote,host,category,note";

// CSV field escaping: quote when the value contains comma/quote/newline.
function csvField(value: string | number | null): string {
  const s = value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(conn: WatchConn): string {
  return [
    conn.at.toISOString(),
    conn.proc,
    conn.pid,
    `${conn.ip}:${conn.port}`,
    conn.host,
    conn.category,
    conn.note,
  ]
    .map(csvField)
    .join(",");
}

// Real CSV writer (CLI default dep): header is prepended on file creation
// only, rows are appended (crash-safe, matches the ps1 prototype).
export function appendCsvLine(path: string, line: string): void {
  let needsHeader = true;
  try {
    needsHeader = !existsSync(path) || statSync(path).size === 0;
  } catch {
    needsHeader = true;
  }
  appendFileSync(path, (needsHeader ? `${CSV_HEADER}\n` : "") + line + "\n", "utf8");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Local wall-clock stamp for live lines: [HH:MM:SS]
function formatClock(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
}

export function formatLiveLine(conn: WatchConn): string {
  const stamp = `[${formatClock(conn.at)}]`;
  const target = `${conn.ip}:${conn.port}`;
  const dest = conn.host ? `${target} ${conn.host}` : target;
  if (conn.category === "unknown") {
    const why = conn.note ?? "not in known-agent registry";
    return `[!] ${stamp} ${conn.proc}(${conn.pid}) → ${dest} (unknown — ${why})`;
  }
  return `${stamp} ${conn.proc}(${conn.pid}) → ${dest} (${conn.category})`;
}

export function renderWatchSummary(result: WatchResult, csvPath?: string): string {
  const lines: string[] = [];
  lines.push("──── agent-audit watch ────");
  const head =
    `watched ${Math.round(result.elapsedMs / 1000)}s · procs ${result.procs.length}` +
    ` · polls ${result.polls} · new connections ${result.connections.length}` +
    ` · dns entries ${result.dnsEntries}`;
  lines.push(result.pollErrors > 0 ? `${head} · poll errors ${result.pollErrors}` : head);
  if (result.connections.length > 0) {
    const cats = CATEGORY_ORDER.filter(
      (c) => (result.byCategory[c] ?? 0) > 0,
    ).map((c) => `${c} ${result.byCategory[c]}`);
    if (cats.length > 0) {
      lines.push(`by category: ${cats.join(" · ")}`);
    }
    lines.push(
      `by process: ${Object.entries(result.byProc)
        .map(([p, n]) => `${p} ${n}`)
        .join(" · ")}`,
    );
    if (result.unknownTargets.length > 0) {
      lines.push(`[!] unknown targets: ${result.unknownTargets.join(" · ")}`);
    }
  }
  if (csvPath) {
    lines.push(`csv: ${csvPath}`);
  }
  return lines.map((l) => `${l}\n`).join("");
}

// CLI parsing for --proc: trim, strip .exe (users paste Task-Manager names),
// drop empties, dedupe preserving order.
export function parseWatchProcs(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    let name = raw.trim();
    if (name.toLowerCase().endsWith(".exe")) {
      name = name.slice(0, -4);
    }
    if (name && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

// Default sleep: real timer, wakes early on abort so Ctrl+C is snappy.
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function buildConn(raw: RawConn, dnsMap: Map<string, string>, at: Date): WatchConn {
  const host = dnsMap.get(raw.ip) ?? null;
  const hit = host !== null ? classify(host) : null;
  const note =
    host === null
      ? "no DNS mapping observed"
      : hit === null
        ? "domain not in known-agent registry"
        : (hit.note ?? null);
  return {
    at,
    proc: raw.proc,
    pid: raw.pid,
    ip: raw.ip,
    port: raw.port,
    host,
    category: hit !== null ? hit.category : "unknown",
    note,
  };
}

export async function runWatch(
  opts: WatchOptions,
  deps: WatchDeps,
): Promise<WatchResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    throw new WatchUnsupportedError();
  }
  if (opts.procs.length === 0) {
    throw new Error("watch: no process names given");
  }
  if (!(opts.seconds > 0) || !Number.isFinite(opts.seconds)) {
    throw new Error(`watch: seconds must be a positive number (got ${opts.seconds})`);
  }
  const poll = deps.poll;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const writeLine = deps.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const appendCsv = deps.appendCsv ?? appendCsvLine;
  const intervalMs = opts.intervalMs ?? WATCH_INTERVAL_MS;
  const signal = opts.signal;

  const empty: WatchResult = {
    procs: opts.procs,
    seconds: opts.seconds,
    elapsedMs: 0,
    polls: 0,
    pollErrors: 0,
    dnsEntries: 0,
    connections: [],
    byCategory: {},
    byProc: {},
    unknownTargets: [],
  };
  if (signal?.aborted) {
    return empty;
  }

  const dnsMap = new Map<string, string>(); // ip -> latest observed hostname
  const dnsHosts = new Set<string>();
  const seen = new Set<string>(); // dedupe key: proc|ip|port (prototype parity)
  const connections: WatchConn[] = [];
  const byCategory: Record<string, number> = {};
  const byProc: Record<string, number> = {};
  const unknownTargets: string[] = [];

  const start = now().getTime();
  let polls = 0;
  let pollErrors = 0;
  let attempts = 0;
  let warnedPollFailure = false;

  // do-at-least-one semantics for a healthy run, but a pre-aborted signal
  // (checked above) and abort mid-run stop immediately. The loop guard uses
  // ATTEMPTS, not successful polls, so a persistently failing poller still
  // terminates.
  while (
    !signal?.aborted &&
    (attempts === 0 || now().getTime() - start < opts.seconds * 1000)
  ) {
    attempts += 1;
    let sample: PollSample | null = null;
    try {
      sample = await poll(opts.procs);
    } catch (err) {
      pollErrors += 1;
      if (!warnedPollFailure) {
        warnedPollFailure = true;
        const msg = err instanceof Error ? err.message : String(err);
        writeLine(`[!] watch: poll failed (will retry): ${msg}`);
      }
    }
    if (sample !== null) {
      polls += 1;
      for (const d of sample.dns) {
        if (d && d.host && d.ip) {
          dnsMap.set(d.ip, d.host);
          dnsHosts.add(d.host);
        }
      }
      for (const c of sample.conns) {
        if (!c || !c.ip || !c.port || !c.proc) {
          continue; // malformed row from the poller: skip silently
        }
        if (!opts.procs.includes(c.proc)) {
          continue; // defensive: the real poller filters already
        }
        // dedupe on pid (prototype parity): two same-named processes (IDE
        // main + extension host, node helpers) hitting the same endpoint are
        // distinct connections and must both be reported
        const key = `${c.pid}|${c.ip}|${c.port}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const conn = buildConn(c, dnsMap, now());
        connections.push(conn);
        byCategory[conn.category] = (byCategory[conn.category] ?? 0) + 1;
        byProc[conn.proc] = (byProc[conn.proc] ?? 0) + 1;
        if (conn.category === "unknown") {
          unknownTargets.push(`${conn.host ?? conn.ip}:${conn.port} (${conn.proc})`);
        }
        writeLine(formatLiveLine(conn));
        if (opts.csvPath) {
          appendCsv(opts.csvPath, csvRow(conn));
        }
      }
    }
    await sleep(intervalMs, signal);
  }

  return {
    procs: opts.procs,
    seconds: opts.seconds,
    elapsedMs: now().getTime() - start,
    polls,
    pollErrors,
    dnsEntries: dnsHosts.size,
    connections,
    byCategory,
    byProc,
    unknownTargets,
  };
}
