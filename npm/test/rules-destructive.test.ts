// Ported 1:1 from tests/test_rules_destructive.py (Python implementation is the spec).
import { expect, test } from "vitest";

import type { Rule } from "../src/rules/base.js";
import { rules } from "../src/rules/destructive.js";
import { shell } from "./helpers.js";

const R = new Map<string, Rule>(rules().map((r) => [r.id, r]));

// from test_rule_hits
test.each([
  ["D001", "rm -rf /tmp/build"],
  ["D001", "rm -fr ./x"],
  ["D001", "rm -rfi ./node_modules"],
  ["D001", "rm -r -f ./build"],
  ["D001", "rm -r ./build -f"],
  ["D001", "rm --recursive --force ./build"],
  ["D001", "rd /s /q C:\\temp"],
  ["D001", "del /q /s *.log"],
  ["D001", "del /f /s /q *.log"],
  ["D001", "git rm -rf build"],
  ["D001", "Remove-Item -Recurse -Force C:\\x"],
  ["D002", "git reset --hard HEAD~1"],
  ["D002", "git clean -fd"],
  ["D002", "git push origin main --force"],
  ["D002", "git push -fn origin main"],
  ["D002", "git reflog expire --expire=now --all"],
  ["D003", "chmod 777 /var/www"],
  ["D003", "chmod -R 777 ./site"],
  ["D003", "chmod 0777 ./site"],
  ["D004", "dd if=img.iso of=/dev/sdb"],
  ["D004", "mkfs.ext4 /dev/sda1"],
  ["D004", "diskutil eraseDisk JHFS+ New /dev/disk2"],
  ["D004", "format D:"],
  ["D004", "format C:; echo done"],
  ["D005", "docker system prune -a --volumes"],
  ["D005", "docker system prune -af"],
  ["D005", "killall Finder"],
  ["D005", "taskkill /f /im explorer.exe"],
])("%s should match: %s", (ruleId, cmd) => {
  const finding = R.get(ruleId)!.check(shell(cmd));
  expect(finding, `${ruleId} should match: ${cmd}`).not.toBeNull();
  expect(finding!.ruleId).toBe(ruleId);
});

// from test_rule_misses
test.each([
  ["D001", "rm file.txt"],
  ["D001", "rm -r ./build"],
  ["D001", "mkdir build"],
  ["D002", "git push origin main"],
  ["D002", "git push -n origin main"],
  ["D002", "git status"],
  ["D003", "chmod +x run.sh"],
  ["D004", "diskutil list"],
  ["D005", "docker ps"],
  ["D005", "docker system prune"],
  ["D005", "taskkill /im notepad.exe"],
])("%s should NOT match: %s", (ruleId, cmd) => {
  expect(R.get(ruleId)!.check(shell(cmd)), `${ruleId} should NOT match: ${cmd}`).toBeNull();
});
