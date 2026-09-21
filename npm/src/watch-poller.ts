// M5: the REAL watch deps for Windows — one PowerShell child process per
// poll (design decision: Node has no native per-process TCP table). Port of
// D:/zcode-test/watch_egress.ps1:
//   - Get-NetTCPConnection -State Established, OwningProcess -> process name
//   - Get-DnsClientCache A/AAAA entries piped in the SAME poll for ip->host
// NOT imported by unit tests (they inject fake deps into runWatch); only
// cli.ts wires this in.
//
// Robustness: the script is passed via -EncodedCommand (base64 UTF-16LE) so
// process names with spaces/quotes need no shell quoting; malformed JSON
// rows are skipped; a failed poll rejects and runWatch counts it (never
// aborts the watch).
import { execFile } from "node:child_process";

import type { PollSample, WatchDeps } from "./watch.js";
import { appendCsvLine } from "./watch.js";

function psQuote(name: string): string {
  // inside PowerShell single-quoted string, ' is escaped by doubling
  return `'${name.replace(/'/g, "''")}'`;
}

export function buildPollScript(procs: string[]): string {
  const want = procs.map(psQuote).join(",");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$want=@(${want})`,
    "$pn=@{}",
    "Get-Process | ForEach-Object { $pn[[uint32]$_.Id]=$_.ProcessName }",
    "$rows=@(" +
      "Get-NetTCPConnection -State Established | ForEach-Object { " +
      "$n=$pn[[uint32]$_.OwningProcess]; " +
      "if($n -and ($want -contains $n)){ " +
      "[pscustomobject]@{t='c';p=$n;i=$_.OwningProcess;ip=$_.RemoteAddress;pt=$_.RemotePort}" +
      " } }" +
      ") + @(" +
      "Get-DnsClientCache | ForEach-Object { " +
      "if($_.Entry -match '\\.' -and ($_.Type -eq 1 -or $_.Type -eq 28)){ " +
      "[pscustomobject]@{t='d';h=$_.Entry;ip=([string]$_.Data)}" +
      " } }" +
      ")",
    "if($rows.Count -gt 0){ $rows | ConvertTo-Json -Compress }",
  ].join(";");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parsePollOutput(stdout: string): PollSample {
  const conns: PollSample["conns"] = [];
  const dns: PollSample["dns"] = [];
  const text = stdout.trim();
  if (!text) {
    return { conns, dns };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { conns, dns }; // never let a garbled poll crash the watch
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const port = Number(row.pt);
    const pid = Number(row.i);
    if (row.t === "c" && typeof row.p === "string" && typeof row.ip === "string") {
      if (Number.isInteger(port) && port > 0 && port < 65536 && Number.isFinite(pid)) {
        conns.push({ proc: row.p, pid, ip: row.ip, port });
      }
    } else if (row.t === "d" && typeof row.h === "string" && typeof row.ip === "string") {
      dns.push({ host: row.h, ip: row.ip });
    }
  }
  return { conns, dns };
}

export function powershellPoll(procs: string[]): Promise<PollSample> {
  const script = buildPollScript(procs);
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(parsePollOutput(stdout));
      },
    );
  });
}

// The CLI's default dep set (tests override any part of it via MainIo.watchDeps).
export function defaultWatchDeps(): WatchDeps {
  return {
    platform: process.platform,
    poll: powershellPoll,
    appendCsv: appendCsvLine,
  };
}
