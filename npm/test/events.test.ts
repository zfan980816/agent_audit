// Ported 1:1 from tests/test_events.py (Python implementation is the spec).
import { expect, test } from "vitest";

import {
  FileWrite,
  SEVERITY_ORDER,
  ShellCommand,
  isConfigPath,
  severityAtLeast,
  type Severity,
} from "../src/events.js";

// from test_severity_order_and_compare
test("severity order and compare", () => {
  expect(severityAtLeast("critical", "high")).toBe(true);
  expect(severityAtLeast("high", "high")).toBe(true);
  expect(severityAtLeast("low", "high")).toBe(false);
  expect(SEVERITY_ORDER[0]).toBe<Severity>("info");
});

// from test_is_config_path_hits
test("is_config_path hits", () => {
  expect(isConfigPath("/home/u/.claude/settings.json")).toBe(true);
  expect(isConfigPath("/home/u/.bashrc")).toBe(true);
  expect(isConfigPath("C:\\Users\\u\\.ssh\\authorized_keys")).toBe(true);
  expect(isConfigPath("/home/u/project/settings.local.json")).toBe(true);
});

// from test_is_config_path_misses
test("is_config_path misses", () => {
  expect(isConfigPath("/home/u/project/src/main.py")).toBe(false);
  expect(isConfigPath("/home/u/project/.env")).toBe(false);
  expect(isConfigPath("/home/u/notes.txt")).toBe(false);
});

// from test_shell_command_fields
test("ShellCommand fields", () => {
  const ev = new ShellCommand("s1", "demo", null, "ls -la", "/tmp");
  expect(ev.raw).toBe("ls -la");
  expect(ev.cwd).toBe("/tmp");
  expect(ev.timestamp).toBeNull();
});

// from test_file_write_defaults
test("FileWrite defaults", () => {
  const ev = new FileWrite("s1", "demo", null, "/x/.bashrc");
  expect(ev.isConfig).toBe(true);
  expect(ev.content).toBeNull();
});

// from test_file_write_explicit_false_respected
test("FileWrite explicit false respected", () => {
  const ev = new FileWrite("s1", "demo", null, "/x/.bashrc", false);
  expect(ev.isConfig).toBe(false);
});
