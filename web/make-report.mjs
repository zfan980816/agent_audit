#!/usr/bin/env node
// agent-audit HTML report generator.
// Runs the audit (real data by default, --demo for the built-in dataset),
// injects the JSON into web/dashboard.html, writes a standalone report file
// that opens offline in any browser (double-click, no server needed).
//
// Usage:
//   node web/make-report.mjs [--demo] [--out path.html] [-- claude|kimi|codex|zcode|all]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : resolve(ROOT, "..", "agent-audit-report.html");
const passthrough = args.filter((a, i) => a !== "--demo" && a !== "--out" && i !== outIdx + 1 && (outIdx < 0 || i !== outIdx));

// Prefer the LOCAL build (always current with the repo — the M7 review found
// the global install lagging a published version, silently dropping notes);
// fall back to the globally installed CLI.
// --severity info: the report must INCLUDE the M7-exempted findings (D001
// downgraded to info with an exemption note) so the dashboard can show the
//「已豁免」badge — the CLI's default floor "low" would filter them out.
function runAudit() {
  const candidates = [
    [process.execPath, [resolve(ROOT, "npm", "dist", "cli.js"), ...(demo ? ["--demo"] : []), "--json", "--severity", "info", ...passthrough]],
    ["agent-audit", [...(demo ? ["--demo"] : []), "--json", "--severity", "info", ...passthrough]],
  ];
  for (const [cmd, argv] of candidates) {
    const r = spawnSync(cmd, argv, { encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, NO_COLOR: "1" } });
    if (r.status === 0 && r.stdout.trim().startsWith("{")) return r.stdout;
    if (candidates.indexOf([cmd, argv]) === candidates.length - 1 || r.error) continue;
  }
  throw new Error("could not run agent-audit --json (is it installed? try: npm i -g @fanzhen/agent-audit)");
}

const json = runAudit();
const template = readFileSync(resolve(here, "dashboard.html"), "utf8");
const html = template.replace("/*__REPORT_JSON__*/null", json);
try { mkdirSync(dirname(out), { recursive: true }); } catch { /* exists or drive root */ }
writeFileSync(out, html, "utf8");
const summary = JSON.parse(json).summary;
console.log(`report written: ${out}`);
console.log(`  findings ${summary.total} · files ${summary.files} · sessions ${summary.sessions} · events ${summary.events}`);
