import * as core from "@actions/core";

import { publishExperimentComment } from "./comment";
import { discoverScripts } from "./discover";
import { setupExperimentScripts } from "./executors";
import { resolveInputs } from "./inputs";
import { resolveDefaultMetadata } from "./metadata";
import { setOutputs } from "./output";
import type { ScriptResult } from "./types";

export async function run(): Promise<void> {
  const inputs = resolveInputs();
  core.debug(
    `Resolved inputs: experimentPath=${inputs.experimentPath} ` +
      `dataset=${inputs.datasetName ?? "<none>"} ` +
      `pythonSdkVersion=${inputs.pythonSdkVersion} jsSdkVersion=${inputs.jsSdkVersion} ` +
      `shouldSkipSdkInstallation=${inputs.shouldSkipSdkInstallation} ` +
      `shouldFailOnError=${inputs.shouldFailOnError} ` +
      `shouldCommentOnPr=${inputs.shouldCommentOnPr}`,
  );

  const discovered = await discoverScripts(inputs.experimentPath);
  core.info(
    `Discovered ${discovered.length} experiment script(s): ` +
      discovered.map((s) => `${s.path} (${s.runtime})`).join(", "),
  );

  const scripts = await setupExperimentScripts(discovered, {
    pythonSdkVersion: inputs.pythonSdkVersion,
    jsSdkVersion: inputs.jsSdkVersion,
    shouldSkipSdkInstallation: inputs.shouldSkipSdkInstallation,
  });

  const metadata = await resolveDefaultMetadata({
    token: inputs.githubToken,
    custom: inputs.customMetadata,
  });
  const runnerEnv = { inputs, metadata };

  const results: ScriptResult[] = [];
  for (const script of scripts) {
    core.startGroup(`Running ${script.path}`);
    try {
      results.push(await script.run(runnerEnv));
    } finally {
      core.endGroup();
    }
    const last = results[results.length - 1];
    if (last.error) {
      const tag = last.error.isRegression ? "regression" : "error";
      core.warning(`${script.path}: ${last.error.name} (${tag}) — ${last.error.message}`);
    } else {
      core.info(`${script.path}: passed in ${last.durationMs}ms`);
    }
  }

  const anyFailed = results.some((r) => r.error !== null);
  core.debug(`Any failures: ${anyFailed}`);

  setOutputs(results);

  if (inputs.shouldCommentOnPr) {
    await publishExperimentComment({ inputs, results, metadata });
  }

  if (anyFailed && inputs.shouldFailOnError) {
    const regressions = results.filter((r) => r.error?.isRegression).length;
    const errors = results.filter((r) => r.error && !r.error.isRegression).length;
    core.setFailed(
      `Experiment run failed: ${regressions} regression(s), ${errors} other error(s). ` +
        `Set should_fail_on_error: false to treat these as warnings.`,
    );
  }
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`langfuse/experiment-action crashed: ${message}`);
});
