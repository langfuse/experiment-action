// Copy runner wrappers next to the bundled dist/index.js so the action can
// locate them at runtime via `__dirname`.

import { mkdir, copyFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, "..", "src", "executors", "wrappers");
const DEST_DIR = join(here, "..", "dist");

await mkdir(DEST_DIR, { recursive: true });
for (const entry of await readdir(SRC_DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  await copyFile(join(SRC_DIR, entry.name), join(DEST_DIR, entry.name));
  process.stdout.write(`copied ${entry.name}\n`);
}
