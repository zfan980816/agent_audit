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

// T8 real-data gate regression: a joined-string sort reorders exactly the two
// shapes real ~/.claude/projects contains. Python sorted() compares pathlib
// Path objects element-wise over os.path.normcase()-folded parts (lowercased
// on win32, identity on POSIX; prefix-shorter-first), so:
//   - "C--zoo" vs "c--app" interleave under the lowercase compare (a code-unit
//     sort puts all "C--" first: 0x43 < 0x63);
//   - "<uuid>/subagents/a.jsonl" precedes "<uuid>.jsonl" (part "uuid" is a
//     string-prefix of "uuid.jsonl"), while a string compare flips it
//     ("." 0x2E < separator 0x5C after the shared "uuid").
test("sorts like pathlib: normcase-folded parts, element-wise", () => {
  const tmp = makeTmpDir();
  const uuid = "71b42199-5e85-4220-8fc9-685b2ea0c9b5";
  mkdirSync(join(tmp, "C--zoo"));
  writeFileSync(join(tmp, "C--zoo", "s1.jsonl"), "{}", "utf8");
  mkdirSync(join(tmp, "c--app"));
  writeFileSync(join(tmp, "c--app", "s2.jsonl"), "{}", "utf8");
  mkdirSync(join(tmp, "D--proj", uuid, "subagents"), { recursive: true });
  writeFileSync(join(tmp, "D--proj", uuid, "subagents", "a.jsonl"), "{}", "utf8");
  writeFileSync(join(tmp, "D--proj", `${uuid}.jsonl`), "{}", "utf8");

  const files = findSessionFiles(tmp).map((f) =>
    f.slice(tmp.length + 1).replaceAll("\\", "/"),
  );

  // normcase lowercases parts on win32 only, so the case pair interleaves
  // there ("c--app" first) but keeps code-unit order on POSIX.
  const casePair =
    process.platform === "win32"
      ? ["c--app/s2.jsonl", "C--zoo/s1.jsonl"]
      : ["C--zoo/s1.jsonl", "c--app/s2.jsonl"];
  expect(files).toEqual([
    ...casePair,
    `D--proj/${uuid}/subagents/a.jsonl`,
    `D--proj/${uuid}.jsonl`,
  ]);
});
