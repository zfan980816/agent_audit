// Unified event model shared by all parsers and the rules engine.
// Faithful port of src/agentaudit/events.py (Python is the spec).

// Python: class Severity(str, Enum) — CRITICAL/HIGH/MEDIUM/LOW/INFO.
// Port-plan decision (binding): const tuple + derived string-literal union.
export const SEVERITY_ORDER = [
  "info", "low", "medium", "high", "critical",
] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

// ascending severity, index-based comparison
export function severityAtLeast(value: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER.indexOf(value) >= SEVERITY_ORDER.indexOf(floor);
}

export const CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "settings.json", "settings.local.json",
  ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
  "Microsoft.PowerShell_profile.ps1",
  "authorized_keys", "known_hosts", "config",
]);

export const SHELL_RC_NAMES: ReadonlySet<string> = new Set([
  ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
  "Microsoft.PowerShell_profile.ps1",
]);

export function pathBasename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
}

export function isConfigPath(path: string): boolean {
  return CONFIG_BASENAMES.has(pathBasename(path));
}

// Python: @dataclass Event (session_id, project, timestamp).
// Classes over a discriminated union so rules can use `instanceof`,
// matching Python `isinstance(event, rule.applies_to)` semantics 1:1.
export class Event {
  sessionId: string;
  project: string;
  timestamp: Date | null;

  constructor(sessionId: string, project: string, timestamp: Date | null) {
    this.sessionId = sessionId;
    this.project = project;
    this.timestamp = timestamp;
  }
}

export class ShellCommand extends Event {
  raw: string;
  cwd: string | null;

  constructor(
    sessionId: string,
    project: string,
    timestamp: Date | null,
    raw = "",
    cwd: string | null = null,
  ) {
    super(sessionId, project, timestamp);
    this.raw = raw;
    this.cwd = cwd;
  }
}

export class FileWrite extends Event {
  path: string;
  isConfig: boolean | null; // null = auto-detect from path
  content: string | null;

  constructor(
    sessionId: string,
    project: string,
    timestamp: Date | null,
    path = "",
    isConfig: boolean | null = null,
    content: string | null = null,
  ) {
    super(sessionId, project, timestamp);
    this.path = path;
    this.content = content;
    // Python __post_init__: auto-detect only when is_config is None,
    // so an explicit false is respected.
    this.isConfig = isConfig === null ? isConfigPath(path) : isConfig;
  }
}

export class NetworkRequest extends Event {
  url: string;
  method: string | null;

  constructor(
    sessionId: string,
    project: string,
    timestamp: Date | null,
    url = "",
    method: string | null = null,
  ) {
    super(sessionId, project, timestamp);
    this.url = url;
    this.method = method;
  }
}

export class McpToolCall extends Event {
  server: string;
  tool: string;
  argsHint: string;

  constructor(
    sessionId: string,
    project: string,
    timestamp: Date | null,
    server = "",
    tool = "",
    argsHint = "",
  ) {
    super(sessionId, project, timestamp);
    this.server = server;
    this.tool = tool;
    this.argsHint = argsHint;
  }
}
