import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import type { RawScriptResult, ResolvedInputs, Runtime, ScriptError } from "@/types";

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

export function buildBaseRunnerEnv(env: RunnerEnv): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;

  const runnerEnv: Record<string, string> = {
    ...inherited,
    LANGFUSE_PUBLIC_KEY: env.inputs.langfusePublicKey,
    LANGFUSE_SECRET_KEY: env.inputs.langfuseSecretKey,
    LANGFUSE_HOST: env.inputs.langfuseBaseUrl,
    LANGFUSE_BASEURL: env.inputs.langfuseBaseUrl,
    LANGFUSE_EXPERIMENT_METADATA: JSON.stringify(env.metadata),
  };

  if (env.inputs.datasetName) {
    runnerEnv.LANGFUSE_DATASET_NAME = env.inputs.datasetName;
  }
  if (env.inputs.datasetVersion) {
    runnerEnv.LANGFUSE_DATASET_VERSION = env.inputs.datasetVersion;
  }

  return runnerEnv;
}

function toScriptError(
  status: StatusFile | null,
  execError: Error | null,
  runtimeLabel: "Node" | "Python",
): ScriptError | null {
  if (!status && execError) {
    return {
      name: "RunnerError",
      message: `${runtimeLabel} runner crashed before writing status: ${execError.message}`,
      isRegression: false,
    };
  }
  if (status?.status === "error") {
    return {
      name: status.error_name ?? "Error",
      message: status.message ?? "",
      isRegression: Boolean(status.is_regression),
      details: status.traceback,
    };
  }
  return null;
}

export async function executeWrapper(opts: {
  scriptPath: string;
  scriptName: string;
  runtime: Runtime;
  command: string;
  wrapperPath: string;
  runnerEnv: Record<string, string>;
  runtimeLabel: "Node" | "Python";
}): Promise<RawScriptResult> {
  const { scriptPath, scriptName, runtime, command, wrapperPath, runnerEnv, runtimeLabel } = opts;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langfuse-run-"));
  const resultFile = path.join(tmpDir, "result.json");
  const statusFile = path.join(tmpDir, "status.json");

  core.debug(`${runtimeLabel}Script.run path=${scriptPath} tmpDir=${tmpDir}`);
  core.debug(`${runtimeLabel} wrapper: ${wrapperPath}`);

  const started = Date.now();
  let execError: Error | null = null;
  try {
    await exec.exec(command, [wrapperPath, scriptPath, resultFile, statusFile], {
      env: runnerEnv,
    });
  } catch (err) {
    execError = err instanceof Error ? err : new Error(String(err));
    core.debug(`${runtimeLabel} runner exec threw: ${execError.message}`);
  }
  const durationMs = Date.now() - started;

  const status = await readStatusFile(statusFile);
  const result = await readResultFile(resultFile);

  return {
    scriptPath,
    scriptName,
    runtime,
    result,
    error: toScriptError(status, execError, runtimeLabel),
    durationMs,
  };
}
