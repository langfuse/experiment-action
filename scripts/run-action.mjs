#!/usr/bin/env node
// Local harness for invoking the built action against a fixture script.
//
//   node scripts/run-action.mjs tests/fixtures/e2e/experiment.py
//
// Reads .env from the repo root (if present), maps the action's inputs onto
// INPUT_* env vars exactly the way GitHub Actions does, and spawns
// dist/index.js as a subprocess.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

await loadDotenv(join(repoRoot, ".env"));

const fixture = process.argv[2];
if (!fixture) {
  console.error("usage: run-action.mjs <fixture-path-or-directory>");
  process.exit(2);
}

const requiredVars = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"];
for (const v of requiredVars) {
  if (!process.env[v]) {
    console.error(
      `Missing ${v}. Create a .env from .env.example, or start local Langfuse with \`pnpm run dev\`.`,
    );
    process.exit(2);
  }
}

const actionEnv = {
  ...process.env,
  INPUT_EXPERIMENT_PATH: resolve(fixture),
  INPUT_LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
  INPUT_LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
  INPUT_LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000",
  INPUT_SHOULD_COMMENT_ON_PR: "false",
  INPUT_SHOULD_FAIL_ON_ERROR: "true",
  INPUT_SDK_VERSION: process.env.LANGFUSE_SDK_VERSION ?? "latest",
};

const distEntry = join(repoRoot, "dist", "index.js");
const child = spawn(process.execPath, [distEntry], { env: actionEnv, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));

async function loadDotenv(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue.startsWith("#")) continue;
    if (key in process.env) continue;
    process.env[key] = rawValue.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  }
}
