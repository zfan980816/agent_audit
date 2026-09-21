// Ported 1:1 from src/agentaudit/rules/base.py (Python implementation is the spec).
import {
  Event,
  FileWrite,
  McpToolCall,
  NetworkRequest,
  ShellCommand,
  type Severity,
} from "../events.js";

export interface Finding {
  ruleId: string; // Python: rule_id
  severity: Severity;
  title: string;
  event: Event;
  evidence: string;
  explanation: string;
  recommendation: string;
  // M7 (v0.3.x TS-canonical, Python frozen at v0.1.1 has none): exemption
  // note set by the engine's creator-immunity downgrade (D001 only). Absent
  // on every non-exempt finding; report.toDict emits it LAST when present.
  note?: string;
}

export function evidenceOf(event: Event): string {
  if (event instanceof ShellCommand) {
    return event.raw;
  }
  if (event instanceof FileWrite) {
    // path only — to match written content, write a custom Rule.check()
    return event.path;
  }
  if (event instanceof NetworkRequest) {
    return event.url;
  }
  if (event instanceof McpToolCall) {
    return `${event.server}::${event.tool} ${event.argsHint}`;
  }
  return "";
}

// Python: applies_to is a tuple of Event subclasses; here, their constructors.
// (any[], not unknown[]: constructor parameters are contravariant, so a ctor
// taking (sessionId: string, ...) is only a supertype of ...args: any[].)
export type EventCtor = new (...args: any[]) => Event;

export class Rule {
  id: string = "?";
  severity: Severity = "low";
  title: string = "";
  explanation: string = "";
  recommendation: string = "";
  appliesTo: readonly EventCtor[] = [ShellCommand];

  check(event: Event): Finding | null {
    throw new Error("NotImplementedError");
  }
}

export class RegexRule extends Rule {
  // JS porting note: in Python, `pattern` is a class attribute that subclasses
  // override, visible to the base __init__ via attribute lookup. JS instance
  // fields are NOT visible to the base constructor (subclass field initializers
  // only run after super() returns), so subclasses override the *static*
  // `pattern` instead, and the constructor reads it via this.constructor.
  static pattern: string = "";
  private readonly re: RegExp;

  constructor() {
    super();
    const ctor = this.constructor as typeof RegexRule;
    if (!ctor.pattern) {
      throw new Error(`${ctor.name}.pattern is empty`);
    }
    this.re = new RegExp(ctor.pattern, "i");
  }

  override check(event: Event): Finding | null {
    if (!this.appliesTo.some((ctor) => event instanceof ctor)) {
      return null;
    }
    const text = evidenceOf(event);
    if (!text) {
      return null;
    }
    const m = this.re.exec(text);
    if (!m) {
      return null;
    }
    return {
      ruleId: this.id,
      severity: this.severity,
      title: this.title,
      event,
      evidence: m[0].slice(0, 200),
      explanation: this.explanation,
      recommendation: this.recommendation,
    };
  }
}
