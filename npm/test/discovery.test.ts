// Ported 1:1 from tests/test_discovery.py (Python implementation is the spec).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { DataDirNotFoundError, findSessionFiles } from "../src/discovery.js";
import { makeTmpDir } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// from test_finds_nested_jsonl
test("finds nested jsonl", () => {
  const tmp = makeTmpDir();
  mkdirSync(join(tmp, "proj-a"));
  writeFileSync(join(tmp, "proj-a", "s1.jsonl"), "{}", "utf8");
  writeFileSync(join(tmp, "proj-a", "s2.jsonl"), "{}", "utf8");
  mkdirSync(join(tmp, "proj-b", "sub"), { recursive: true });
  writeFileSync(join(tmp, "proj-b", "sub", "s3.jsonl"), "{}", "utf8");
  writeFileSync(join(tmp, "proj-b", "notes.txt"), "x", "utf8");

  const files = findSessionFiles(tmp);

  expect(files).toHaveLength(3);
  expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
  expect(files).toEqual([...files].sort());
});

// from test_missing_dir_raises_with_hint
test("missing dir raises with hint", () => {
  const tmp = makeTmpDir();
  let message = "";
  try {
    findSessionFiles(join(tmp, "nope"));
  } catch (err) {
    expect(err).toBeInstanceOf(DataDirNotFoundError);
    message = String(err);
  }
  expect(message).toContain("WSL");
});

// from test_default_dir_is_claude_projects (Python monkeypatches Path.home;
// os.homedir() reads HOME (POSIX) / USERPROFILE (Windows) at call time).
test("default dir is claude projects", () => {
  const tmp = makeTmpDir();
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("USERPROFILE", tmp);
  mkdirSync(join(tmp, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "projects", "p", "a.jsonl"), "{}", "utf8");

  expect(findSessionFiles()).toHaveLength(1);
});
