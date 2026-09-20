// Ported 1:1 from tests/test_rules_credentials.py (Python implementation is the spec).
import { expect, test } from "vitest";

import type { Rule } from "../src/rules/base.js";
import { rules } from "../src/rules/credentials.js";
import { shell } from "./helpers.js";

const R = new Map<string, Rule>(rules().map((r) => [r.id, r]));

// from test_rule_hits
test.each([
  ["C001", "cat .env"],
  ["C001", "Get-Content .env.production"],
  ["C001", "head -20 .env.local"],
  ["C002", "cat ~/.ssh/id_rsa"],
  ["C002", "openssl x509 -in cert.pem"],
  ["C002", "type server.key"],
  ["C002", "cat serviceAccount-prod.json"],
  ["C003", "ls ~/.aws"],
  ["C003", "cat ~/.ssh/config"],
  ["C003", "cat ~/.npmrc"],
  ["C004", "security find-generic-password -s github"],
  ["C004", "pass show work/aws"],
  ["C005", "strings 'Login Data'"],
  ["C005", "sqlite3 cookies.sqlite 'select *'"],
  ["C006", "env"],
  ["C006", "printenv | grep TOKEN"],
  ["C006", "Get-ChildItem env:"],
])("%s should match: %s", (ruleId, cmd) => {
  const finding = R.get(ruleId)!.check(shell(cmd));
  expect(finding, `${ruleId} should match: ${cmd}`).not.toBeNull();
});

// from test_rule_misses
test.each([
  ["C001", "cat main.py"],
  ["C002", "cat readme.md"],
  ["C003", "ls ~/.config"],
  ["C004", "pass ls"],
  ["C005", "sqlite3 main.db"],
  ["C006", "conda env create"],
  ["C006", "python -m venv env"],
])("%s should NOT match: %s", (ruleId, cmd) => {
  expect(R.get(ruleId)!.check(shell(cmd)), `${ruleId} should NOT match: ${cmd}`).toBeNull();
});
