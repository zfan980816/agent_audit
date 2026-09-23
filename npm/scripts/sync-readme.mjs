// Sync the root README into the npm package as its single source of truth.
// Runs automatically on `npm publish` (prepublishOnly); also runnable by hand:
//   node npm/scripts/sync-readme.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "README.md");
const dst = join(here, "..", "README.md");

const body = readFileSync(src, "utf8");
const banner =
  "<!-- GENERATED from the repository root README.md by npm/scripts/sync-readme.mjs — " +
  "edit the root file, never this one. -->\n\n";
writeFileSync(dst, banner + body, "utf8");
copyFileSync(src, src); // no-op touch for symmetry
console.log(`synced ${src} -> ${dst} (${body.length} bytes)`);
