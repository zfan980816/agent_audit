// Ported 1:1 from tests/test_rules_base.py (Python implementation is the spec).
import { expect, test } from "vitest";

import { ShellCommand, type Severity } from "../src/events.js";
import { RegexRule, evidenceOf, type Finding } from "../src/rules/base.js";
import { fwrite, netreq, shell } from "./helpers.js";

class DemoRule extends RegexRule {
  static override pattern = String.raw`rm\s+-rf`;
  id = "X001";
  severity: Severity = "high";
  title = "demo";
  explanation = "exp";
  recommendation = "rec";
}

// from test_regex_rule_matches
test("regex rule matches", () => {
  const f = new DemoRule().check(shell("rm -rf /tmp/x"));
  expect(f).not.toBeNull();
  const finding = f as Finding;
  expect(finding.ruleId).toBe("X001");
  expect(finding.severity).toBe<Severity>("high");
  expect(finding.evidence).toBe("rm -rf");
  expect(finding.event instanceof ShellCommand).toBe(true);
  expect((finding.event as ShellCommand).raw).toBe("rm -rf /tmp/x");
});

// from test_regex_rule_no_match
test("regex rule no match", () => {
  expect(new DemoRule().check(shell("ls -la"))).toBeNull();
});

// from test_regex_rule_case_insensitive
test("regex rule case insensitive", () => {
  expect(new DemoRule().check(shell("RM -RF /tmp/x"))).not.toBeNull();
});

// from test_empty_pattern_rejected_loudly
class ForgetfulRule extends RegexRule {
  id = "X002";
  title = "forgot pattern";
}

test("empty pattern rejected loudly", () => {
  expect(() => new ForgetfulRule()).toThrow(/pattern is empty/);
});

// from test_evidence_of_variants
test("evidence of variants", () => {
  expect(evidenceOf(shell("cmd"))).toBe("cmd");
  expect(evidenceOf(fwrite("/a/.bashrc"))).toBe("/a/.bashrc");
  expect(evidenceOf(netreq("https://x.com"))).toBe("https://x.com");
});
