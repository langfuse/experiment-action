import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";

import type { RawScriptResult } from "@/types";

import { ExperimentScript } from "./script";
import { buildBaseRunnerEnv, executeWrapper, type RunnerEnv } from "./shared";

const WRAPPER_PATH = path.join(__dirname, "wrappers", "node_runner.mjs");

/**
 * Primary SDK package the user's script is expected to import. The version
 * check + `sdk_version` pin both apply to this package.
 */
const JS_SDK_PACKAGE = "@langfuse/client";

/**
 * Installed alongside the SDK so the action-owned Node runner can initialize
 * Langfuse OpenTelemetry tracing before invoking the user's experiment.
 * Always installed at "latest" — pinning only applies to `JS_SDK_PACKAGE`.
 */
const JS_SUPPORT_PACKAGES = ["@langfuse/tracing", "@langfuse/otel", "@opentelemetry/sdk-node"];

export class NodeScript extends ExperimentScript {
  readonly runtime = "node" as const;

  constructor(
    path: string,
    public readonly nodeModulesDir: string,
  ) {
    super(path);
  }

  async run(env: RunnerEnv): Promise<RawScriptResult> {
    core.debug(`Node wrapper: ${WRAPPER_PATH}, node_modules: ${this.nodeModulesDir}`);

    const runnerEnv: Record<string, string> = {
      ...buildBaseRunnerEnv(env),
      // CJS `require` honors NODE_PATH, so this keeps those callers
      // working. ESM `import` ignores it — the wrapper registers a
      // resolver (see node_resolver.mjs) that reads the install dir
      // from `LANGFUSE_ACTION_INSTALL_DIR` and redirects @langfuse/*,
      // @opentelemetry/*, and `tsx` specifiers there.
      NODE_PATH: this.nodeModulesDir,
      LANGFUSE_ACTION_INSTALL_DIR: path.dirname(this.nodeModulesDir),
    };

    const tsxBin = path.join(this.nodeModulesDir, ".bin", "tsx");
    return executeWrapper({
      scriptPath: this.path,
      scriptName: this.name,
      runtime: this.runtime,
      command: tsxBin,
      wrapperPath: WRAPPER_PATH,
      runnerEnv,
      runtimeLabel: "Node",
    });
  }
}

/**
 * Private directory where the Node runtime packages live for this action
 * invocation. Use a freshly-created temp directory instead of a predictable
 * shared path so self-hosted/shared runners cannot pre-seed files there.
 */
async function createNodeSdkRoot(): Promise<string> {
  const base = process.env.RUNNER_TEMP ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const tmpRoot = await fs.mkdtemp(path.join(base, "langfuse-experiment-action-node-"));
  await fs.chmod(tmpRoot, 0o700);
  return tmpRoot;
}

/**
 * Install the Langfuse JS SDK (and OTel support packages + tsx) into a
 * private temporary directory. Each action invocation installs into a fresh
 * directory to avoid trusting predictable shared temp paths on self-hosted
 * runners.
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

  const tmpRoot = await createNodeSdkRoot();
  const nodeModulesDir = path.join(tmpRoot, "node_modules");
  await fs.writeFile(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "langfuse-action-runtime", private: true, type: "module" }, null, 2),
  );

  const sdkSpec =
    sdkVersion === "latest" ? `${JS_SDK_PACKAGE}@latest` : `${JS_SDK_PACKAGE}@${sdkVersion}`;
  const specs = [sdkSpec, ...JS_SUPPORT_PACKAGES, "tsx"];
  core.info(`Installing JS SDK into ${tmpRoot}: ${specs.join(", ")}`);
  await exec.exec(
    "npm",
    ["install", "--silent", "--no-audit", "--no-fund", "--omit=dev", ...specs],
    { cwd: tmpRoot },
  );
  return nodeModulesDir;
}
