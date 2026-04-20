#!/usr/bin/env node
// Bump every `langfuse/experiment-action@…` reference in README.md to the
// given commit SHA, with the release tag as an inline comment.
//
//   node scripts/bump-readme-pin.mjs <sha> <tag>
//
// Invoked by .github/workflows/release-bump-readme.yml on every release.

import { readFile, writeFile } from "node:fs/promises";

const [sha, tag] = process.argv.slice(2);
if (!sha || !tag) {
  console.error("Usage: bump-readme-pin.mjs <sha> <tag>");
  process.exit(2);
}

const README_PATH = "README.md";

// Match `langfuse/experiment-action@<ref>` plus an optional ` # <comment>`
// suffix (may contain the old tag / placeholder). We intentionally don't
// try to constrain the SHA/tag shape — anything up to whitespace or a
// markdown backtick counts as "the ref".
const PATTERN = /langfuse\/experiment-action@[^\s`]+(?:\s+#[^\n`]*)?/g;

const before = await readFile(README_PATH, "utf8");
const after = before.replace(PATTERN, `langfuse/experiment-action@${sha} # ${tag}`);

if (after === before) {
  console.log(`README already references ${tag} / ${sha}.`);
  process.exit(0);
}

await writeFile(README_PATH, after);
console.log(`Bumped README to ${tag} (${sha}).`);
