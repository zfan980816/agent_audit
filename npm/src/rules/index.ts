// Ported 1:1 from src/agentaudit/rules/__init__.py (Python implementation is the spec).
// allRules() MUST return fresh instances (E005 holds state).
import type { Rule } from "./base.js";
import { rules as bypass } from "./bypass.js";
import { rules as credentials } from "./credentials.js";
import { rules as destructive } from "./destructive.js";
import { rules as exfiltration } from "./exfiltration.js";
import { rules as unsafe } from "./unsafe.js";

export const CATEGORY_TITLES: ReadonlyMap<string, string> = new Map([
  ["D", "Destructive operations"],
  ["C", "Credential access"],
  ["E", "Data exfiltration"],
  ["B", "Bypass & persistence"],
  ["U", "Unsafe execution"],
]);

export function allRules(): Rule[] {
  return [
    ...destructive(),
    ...credentials(),
    ...exfiltration(),
    ...bypass(),
    ...unsafe(),
  ];
}
