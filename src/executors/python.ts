import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import type { RawScriptResult, ScriptError } from "@/types";

import { ExperimentScript } from "./script";
import { readResultFile, readStatusFile, type RunnerEnv } from "./shared";

const WRAPPER_PATH = path.join(__dirname, "wrappers", "python_runner.py");
const PY_PACKAGE = "langfuse";

export class PythonScript extends ExperimentScript {
  readonly runtime = "python" as const;

  async run(env: RunnerEnv): Promise<RawScriptResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langfuse-run-"));
    const resultFile = path.join(tmpDir, "result.json");
    const statusFile = path.join(tmpDir, "status.json");

    core.debug(`PythonScript.run path=${this.path} tmpDir=${tmpDir}`);
    core.debug(`Python wrapper: ${WRAPPER_PATH}`);

    const runnerEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
    runnerEnv.LANGFUSE_PUBLIC_KEY = env.inputs.langfusePublicKey;
    runnerEnv.LANGFUSE_SECRET_KEY = env.inputs.langfuseSecretKey;
    runnerEnv.LANGFUSE_HOST = env.inputs.langfuseBaseUrl;
    runnerEnv.LANGFUSE_BASEURL = env.inputs.langfuseBaseUrl;
    runnerEnv.LANGFUSE_EXPERIMENT_METADATA = JSON.stringify(env.metadata);
    if (env.inputs.datasetName) {
      runnerEnv.LANGFUSE_DATASET_NAME = env.inputs.datasetName;
    }
    if (env.inputs.datasetVersion) {
      runnerEnv.LANGFUSE_DATASET_VERSION = env.inputs.datasetVersion;
    }

    const started = Date.now();
    let execError: Error | null = null;
    try {
      await exec.exec("python", [WRAPPER_PATH, this.path, resultFile, statusFile], {
        env: runnerEnv,
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
 * Install the Python SDK into the ambient Python environment. Skips only
 * when a specific version was requested and that exact version is already
 * importable — `latest` always invokes pip so an older preinstalled copy
 * gets upgraded (otherwise the contract "install the latest SDK" would be
 * silently violated by any stale ambient install). When `skipInstallation`
 * is true nothing is installed and we trust the caller's environment to
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
  if (installed && sdkVersion !== "latest" && installed === sdkVersion) {
    core.info(`Python SDK already present (langfuse==${installed}); skipping install.`);
    return;
  }
  if (installed) {
    core.debug(
      `Python langfuse ${installed} already installed; running pip to ` +
        `${sdkVersion === "latest" ? "upgrade to latest" : `switch to ${sdkVersion}`}.`,
    );
  }

  const args = ["-m", "pip", "install", "--disable-pip-version-check", "--quiet"];
  if (sdkVersion === "latest") {
    // Ensure an older ambient install actually upgrades to the current
    // latest; without --upgrade pip would no-op on a stale copy.
    args.push("--upgrade", PY_PACKAGE);
  } else {
    args.push(`${PY_PACKAGE}==${sdkVersion}`);
  }
  core.info(`Installing Python SDK: ${args[args.length - 1]}`);
  await exec.exec("python", args);
}
