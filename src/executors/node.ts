import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import type { ScriptError, ScriptResult } from "@/types";

import { ExperimentScript } from "./script";
import { buildEnv, readResultFile, readStatusFile, type RunnerEnv } from "./shared";

const WRAPPER_PATH = path.join(__dirname, "wrappers", "node_runner.mjs");

/**
 * Primary SDK package the user's script is expected to import. The version
 * check + `sdk_version` pin both apply to this package.
 */
const JS_SDK_PACKAGE = "@langfuse/client";

/**
 * Installed alongside the SDK so experiment scripts can set up OpenTelemetry
 * tracing without extra scaffolding. Always installed at "latest" — pinning
 * only applies to `JS_SDK_PACKAGE`.
 */
const JS_SUPPORT_PACKAGES = ["@langfuse/otel", "@opentelemetry/sdk-node"];

export class NodeScript extends ExperimentScript {
  readonly runtime = "node" as const;

  constructor(
    path: string,
    public readonly nodeModulesDir: string,
  ) {
    super(path);
  }

  async run(env: RunnerEnv): Promise<ScriptResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langfuse-run-"));
    const resultFile = path.join(tmpDir, "result.json");
    const statusFile = path.join(tmpDir, "status.json");

    core.debug(`NodeScript.run path=${this.path} tmpDir=${tmpDir}`);
    core.debug(`Node wrapper: ${WRAPPER_PATH}, node_modules: ${this.nodeModulesDir}`);

    const runnerEnv: Record<string, string> = {
      ...buildEnv(env),
      NODE_PATH: this.nodeModulesDir,
    };

    const tsxBin = path.join(this.nodeModulesDir, ".bin", "tsx");

    const started = Date.now();
    let execError: Error | null = null;
    try {
      await exec.exec(tsxBin, [WRAPPER_PATH, this.path, resultFile, statusFile], {
        env: runnerEnv,
      });
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err));
      core.debug(`Node runner exec threw: ${execError.message}`);
    }
    const durationMs = Date.now() - started;

    const status = await readStatusFile(statusFile);
    const result = await readResultFile(resultFile);

    let error: ScriptError | null = null;
    if (!status && execError) {
      error = {
        name: "RunnerError",
        message: `Node runner crashed before writing status: ${execError.message}`,
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

async function readJsSdkVersion(nodeModulesDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(nodeModulesDir, JS_SDK_PACKAGE, "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Stable directory where the Node runtime packages live for the duration of
 * a job. Using a fixed path (under `$RUNNER_TEMP` when available, OS tmpdir
 * otherwise) means repeated action invocations within the same job see the
 * existing install and can skip `npm install`.
 */
function nodeSdkRoot(): string {
  const base = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(base, "langfuse-experiment-action", "node");
}

/**
 * Install the Langfuse JS SDK (and OTel support packages + tsx) into a
 * stable directory. Skips `npm install` when a compatible copy is already
 * present — which is the common case when the action runs multiple times in
 * a single job.
 *
 * When `skipInstallation` is true we don't install anything and instead
 * return the caller's CWD `node_modules` — the user's workflow is expected
 * to have put `@langfuse/client` (and `tsx`) there already.
 */
export async function ensureNodeSdk(
  sdkVersion: string,
  skipInstallation: boolean,
): Promise<string> {
  if (skipInstallation) {
    const cwdNodeModules = path.join(process.cwd(), "node_modules");
    core.info(
      `JS SDK install skipped (should_skip_sdk_installation=true) — using ${cwdNodeModules}.`,
    );
    return cwdNodeModules;
  }

  const tmpRoot = nodeSdkRoot();
  const nodeModulesDir = path.join(tmpRoot, "node_modules");
  await fs.mkdir(tmpRoot, { recursive: true });

  const pkgPath = path.join(tmpRoot, "package.json");
  try {
    await fs.access(pkgPath);
  } catch {
    await fs.writeFile(
      pkgPath,
      JSON.stringify({ name: "langfuse-action-runtime", private: true, type: "module" }, null, 2),
    );
  }

  const existing = await readJsSdkVersion(nodeModulesDir);
  if (existing) {
    core.debug(`${JS_SDK_PACKAGE} already present at ${nodeModulesDir}: ${existing}`);
    if (sdkVersion === "latest" || existing === sdkVersion) {
      core.info(`JS SDK already present (${JS_SDK_PACKAGE}@${existing}); skipping install.`);
      return nodeModulesDir;
    }
  }

  const sdkSpec = sdkVersion === "latest" ? JS_SDK_PACKAGE : `${JS_SDK_PACKAGE}@${sdkVersion}`;
  const specs = [sdkSpec, ...JS_SUPPORT_PACKAGES, "tsx"];
  core.info(`Installing JS SDK into ${tmpRoot}: ${specs.join(", ")}`);
  await exec.exec(
    "npm",
    ["install", "--silent", "--no-audit", "--no-fund", "--omit=dev", ...specs],
    { cwd: tmpRoot },
  );
  return nodeModulesDir;
}
