import * as path from "node:path";

import * as core from "@actions/core";
import * as glob from "@actions/glob";

import type { Runtime } from "./types";

const EXT_TO_RUNTIME: Record<string, Runtime> = {
  ".py": "python",
  ".ts": "node",
  ".mts": "node",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
};

const SUPPORTED_EXTS = Object.keys(EXT_TO_RUNTIME);

export interface DiscoveredScript {
  path: string;
  runtime: Runtime;
}

function runtimeForPath(filePath: string): Runtime | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_RUNTIME[ext] ?? null;
}

function shouldSkipEntry(entryPath: string): boolean {
  const name = path.basename(entryPath);
  if (name.startsWith(".")) return true;
  if (name.startsWith("_")) return true;
  // Avoid traversing into nested tooling directories.
  return entryPath.split(path.sep).some((seg) => seg === "node_modules");
}

/**
 * Resolve `experiment_path` into a list of scripts. Handles three input
 * shapes with a single glob call — no stat-based branching:
 *
 * - single file (`foo/bar.py`): the raw path line of the pattern matches it
 * - directory (`foo/bar/`): the `<input>/**\/*.<ext>` expansion lines match
 *   everything inside
 * - glob pattern (`foo/*.py`): the raw path line evaluates the pattern; the
 *   expansion lines typically match nothing and are harmless
 *
 * Whatever returns, we de-dupe, filter to supported extensions, and skip
 * dotfiles / underscore-prefixed files / anything under `node_modules/`.
 */
export async function discoverScripts(inputPath: string): Promise<DiscoveredScript[]> {
  const absPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  const pattern = [absPath, ...SUPPORTED_EXTS.map((ext) => `${absPath}/**/*${ext}`)].join("\n");
  core.debug(`discoverScripts: input=${inputPath} pattern=\n${pattern}`);

  const globber = await glob.create(pattern, { matchDirectories: false });
  const matches = await globber.glob();
  core.debug(`Glob matched ${matches.length} candidate path(s)`);

  const seen = new Set<string>();
  const scripts: DiscoveredScript[] = [];
  for (const filePath of matches) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (shouldSkipEntry(filePath)) {
      core.debug(`Skipping ${filePath} (dotfile/underscore/node_modules)`);
      continue;
    }
    const runtime = runtimeForPath(filePath);
    if (!runtime) continue;
    scripts.push({ path: filePath, runtime });
  }

  if (scripts.length === 0) {
    throw new Error(
      `No experiment scripts matched "${inputPath}". ` +
        `Expected files with extensions: ${SUPPORTED_EXTS.join(", ")}.`,
    );
  }

  scripts.sort((a, b) => a.path.localeCompare(b.path));
  return scripts;
}

export function runtimesIn(scripts: DiscoveredScript[]): Set<Runtime> {
  return new Set(scripts.map((s) => s.runtime));
}
