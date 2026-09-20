// Ported 1:1 from tests/test_demo.py (Python implementation is the spec).
// The single Python test grows the byte-contract assertions the port plan
// demands for demo output (utf-8 no BOM, LF, Python json.dumps separators) —
// folded in here so the 1:1 test count is preserved.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { writeDemoSession } from "../src/demo.js";
import { runAudit } from "../src/engine.js";
import { makeTmpDir } from "./helpers.js";

test("demo triggers many rules", async () => {
  const path = writeDemoSession(makeTmpDir());
  const result = await runAudit([path]);
  const ids = result.findings.map((f) => f.ruleId);
  expect(ids).toEqual(
    expect.arrayContaining([
      "D001", "D002", "C001", "E001", "E003",
      "U001", "B006", "E005", "B001", "B004",
    ]),
  );

  // Byte contract vs Python write_demo_session: written under <root>/demo/,
  // utf-8 without BOM, LF newlines (Python's write_text additionally translates
  // \n -> CRLF on win32; the plan pins the TS output to the LF source string),
  // 15 records, and Python json.dumps default separators (", " / ": ").
  expect(path).toContain(join("demo", "demo-session.jsonl"));
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  const text = bytes.toString("utf8");
  expect(text).not.toContain("\r");
  const lines = text.split("\n");
  expect(lines).toHaveLength(16); // 15 records + trailing newline
  expect(lines[0]).toBe(
    '{"type": "assistant", "sessionId": "demo-session-0001", ' +
    '"timestamp": "2026-09-19T09:00:00.000Z", "cwd": "/home/dev/proj", ' +
    '"message": {"role": "assistant", "content": [{"type": "tool_use", ' +
    '"id": "t", "name": "Bash", "input": {"command": "ls -la"}}]}}',
  );
  expect(lines[14]).toBe(
    '{"type": "assistant", "sessionId": "demo-session-0001", ' +
    '"timestamp": "2026-09-19T09:00:00.000Z", "cwd": "/home/dev/proj", ' +
    '"message": {"role": "assistant", "content": [{"type": "tool_use", ' +
    '"id": "t", "name": "Write", "input": {"file_path": ' +
    '"/home/dev/proj/.claude/settings.json", "content": ' +
    '"{\\"permissions\\": {\\"allow\\": [\\"Bash(rm:*)\\", \\"Edit(*)\\"]}}"}}]}}',
  );
});
