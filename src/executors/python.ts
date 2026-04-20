import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import type { ScriptError, ScriptResult } from "@/types";

import { ExperimentScript } from "./script";
import { buildEnv, readResultFile, readStatusFile, type RunnerEnv } from "./shared";

const WRAPPER_PATH = path.join(__dirname, "wrappers", "python_runner.py");
const PY_PACKAGE = "langfuse";

export class PythonScript extends ExperimentScript {
  readonly runtime = "python" as const;

  async run(env: RunnerEnv): Promise<ScriptResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langfuse-run-"));
    const resultFile = path.join(tmpDir, "result.json");
    const statusFile = path.join(tmpDir, "status.json");

    core.debug(`PythonScript.run path=${this.path} tmpDir=${tmpDir}`);
    core.debug(`Python wrapper: ${WRAPPER_PATH}`);

    const started = Date.now();
    let execError: Error | null = null;
    try {
      await exec.exec("python", [WRAPPER_PATH, this.path, resultFile, statusFile], {
        env: buildEnv(env),
      });
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err));
      core.debug(`Python runner exec threw: ${execError.message}`);
    }
    const durationMs = Date.now() - started;

    const status = await readStatusFile(statusFile);
    const result = await readResultFile(resultFile);

    let error: ScriptError | null = null;
    if (!status && execError) {
      error = {
        name: "RunnerError",
        message: `Python runner crashed before writing status: ${execError.message}`,
        isRegression: false,
      };
    } else if (status?.status === "error") {
      error = {
        name: status.error_name ?? "Error",
        message: status.message ?? "",
        isRegression: Boolean(status.is_regression),
        details: status.traceback,
      };
    }

    return {
      scriptPath: this.path,
      scriptName: this.name,
      runtime: this.runtime,
      result,
      error,
      durationMs,
    };
  }
}

/**
 * Returns the installed langfuse version, or null if the package is not
 * importable in the ambient Python environment.
 */
export async function getInstalledPythonSdkVersion(): Promise<string | null> {
  let stdout = "";
  const exitCode = await exec.exec(
    "python",
    ["-c", "import importlib.metadata as m; print(m.version('langfuse'))"],
    {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data) => {
          stdout += data.toString();
        },
      },
    },
  );
  if (exitCode !== 0) return null;
  const version = stdout.trim();
  return version || null;
}

/**
 * Install the Python SDK into the ambient Python environment — unless it is
 * already present at a compatible version (any version when `sdkVersion` is
 * "latest", the exact match otherwise). When `skipInstallation` is true the
 * installation is skipped entirely; we trust the caller's environment to
 * provide `langfuse`.
 */
export async function ensurePythonSdk(
  sdkVersion: string,
  skipInstallation: boolean,
): Promise<void> {
  if (skipInstallation) {
    core.info(
      "Python SDK install skipped (should_skip_sdk_installation=true) — relying on ambient environment.",
    );
    return;
  }

  const installed = await getInstalledPythonSdkVersion();
  if (installed) {
    core.debug(`Python langfuse already installed: ${installed}`);
    if (sdkVersion === "latest" || installed === sdkVersion) {
      core.info(`Python SDK already present (langfuse==${installed}); skipping install.`);
      return;
    }
    core.debug(`Installed version ${installed} != requested ${sdkVersion}; reinstalling.`);
  }

  const spec = sdkVersion === "latest" ? PY_PACKAGE : `${PY_PACKAGE}==${sdkVersion}`;
  core.info(`Installing Python SDK: ${spec}`);
  await exec.exec("python", [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--quiet",
    spec,
  ]);
}
