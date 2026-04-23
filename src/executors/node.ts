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
 * stable directory. Skips `npm install` only when a specific version was
 * requested and the same version is already present — common on repeat
 * invocations in a single job. For `latest` we always run npm so an older
 * cached install gets upgraded.
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

  // Skip only on exact-version match. For `latest` we always run npm so an
  // older cached copy actually gets upgraded to the current latest — skipping
  // purely because *something* is there would silently violate the contract.
  const existing = await readJsSdkVersion(nodeModulesDir);
  if (existing && sdkVersion !== "latest" && existing === sdkVersion) {
    core.info(`JS SDK already present (${JS_SDK_PACKAGE}@${existing}); skipping install.`);
    return nodeModulesDir;
  }
  if (existing) {
    core.debug(
      `${JS_SDK_PACKAGE} ${existing} already at ${nodeModulesDir}; running npm to ` +
        `${sdkVersion === "latest" ? "refresh to latest" : `switch to ${sdkVersion}`}.`,
    );
  }

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
