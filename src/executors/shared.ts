import * as fs from "node:fs/promises";

import * as core from "@actions/core";

import type { ResolvedInputs } from "@/types";

export interface RunnerEnv {
  inputs: ResolvedInputs;
  tags: Record<string, string>;
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

/**
 * Environment variables passed to user scripts. We use LANGFUSE_* names that
 * match the SDK's default env lookups, plus a few experiment-scoped vars so
 * the user's script can read them without needing context injection.
 */
export function buildEnv(env: RunnerEnv): Record<string, string> {
  const { inputs, tags } = env;
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }

  out.LANGFUSE_PUBLIC_KEY = inputs.langfusePublicKey;
  out.LANGFUSE_SECRET_KEY = inputs.langfuseSecretKey;
  out.LANGFUSE_HOST = inputs.langfuseBaseUrl;
  out.LANGFUSE_BASEURL = inputs.langfuseBaseUrl;
  out.LANGFUSE_EXPERIMENT_TAGS = JSON.stringify(tags);

  if (inputs.datasetName) out.LANGFUSE_DATASET_NAME = inputs.datasetName;
  if (inputs.datasetVersion) out.LANGFUSE_DATASET_VERSION = inputs.datasetVersion;
  return out;
}
