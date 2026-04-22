import * as fs from "node:fs/promises";

import * as core from "@actions/core";

import type { ResolvedInputs } from "@/types";

export interface RunnerEnv {
  inputs: ResolvedInputs;
  metadata: Record<string, string>;
}

export interface StatusFile {
  status: "ok" | "error";
  error_name?: string;
  message?: string;
  is_regression?: boolean;
  traceback?: string;
}

export async function readStatusFile(file: string): Promise<StatusFile | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    core.debug(`Status file at ${file}: ${raw}`);
    return JSON.parse(raw) as StatusFile;
  } catch (err) {
    core.debug(`Could not read status file ${file}: ${(err as Error).message}`);
    return null;
  }
}

export async function readResultFile(file: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return null;
    core.debug(`Result file at ${file} is ${raw.length} bytes`);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
