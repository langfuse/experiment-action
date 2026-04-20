import * as core from "@actions/core";

import type { DiscoveredScript } from "@/discover";

import { ensureNodeSdk, NodeScript } from "./node";
import { ensurePythonSdk, PythonScript } from "./python";
import { ExperimentScript } from "./script";

export { ExperimentScript } from "./script";
export type { RunnerEnv } from "./shared";
export { NodeScript } from "./node";
export { PythonScript } from "./python";

export interface SetupOptions {
  /** Version spec for the Python SDK (`pip install langfuse==<version>`). */
  pythonSdkVersion: string;
  /** Version spec for the JS SDK (`npm install @langfuse/client@<version>`). */
  jsSdkVersion: string;
  /**
   * When true, skip the automatic SDK installation entirely and trust the
   * ambient environment (user's `pip` / `npm` state) to provide the SDK
   * and, for the Node runtime, `tsx`.
   */
  shouldSkipSdkInstallation: boolean;
}

/**
 * Install any SDKs the discovered scripts need, then wrap each path in the
 * right `ExperimentScript` subclass. SDK installs are coordinated across
 * scripts so each runtime is set up at most once per action invocation.
 */
export async function setupExperimentScripts(
  discovered: DiscoveredScript[],
  options: SetupOptions,
): Promise<ExperimentScript[]> {
  const runtimes = new Set(discovered.map((d) => d.runtime));
  core.debug(`Runtimes to prepare: ${[...runtimes].join(", ")}`);

  let nodeModulesDir: string | undefined;

  if (runtimes.has("python")) {
    await ensurePythonSdk(options.pythonSdkVersion, options.shouldSkipSdkInstallation);
  }
  if (runtimes.has("node")) {
    nodeModulesDir = await ensureNodeSdk(options.jsSdkVersion, options.shouldSkipSdkInstallation);
  }

  return discovered.map((d) => {
    if (d.runtime === "python") return new PythonScript(d.path);
    if (!nodeModulesDir) {
      throw new Error("Node runtime required but SDK setup did not produce a node_modules path.");
    }
    return new NodeScript(d.path, nodeModulesDir);
  });
}
