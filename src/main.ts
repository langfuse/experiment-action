import * as core from "@actions/core";

import { publishExperimentComment } from "./comment";
import { discoverScripts } from "./discover";
import { setupExperimentScripts } from "./executors";
import { normalizeExperimentResult, resolveLangfuseExperimentUrl } from "./experiment-result";
import { resolveInputs } from "./inputs";
import { resolveProjectId } from "./langfuse/project";
import { resolveDefaultMetadata } from "./metadata";
import { setOutputs } from "./output";
import type { RawScriptResult, ScriptResult } from "./types";

export async function run(): Promise<void> {
  const inputs = resolveInputs();
  core.debug(
    `Resolved inputs: experimentPath=${inputs.experimentPath} ` +
      `dataset=${inputs.datasetName ?? "<none>"} ` +
      `pythonSdkVersion=${inputs.pythonSdkVersion} jsSdkVersion=${inputs.jsSdkVersion} ` +
      `shouldSkipSdkInstallation=${inputs.shouldSkipSdkInstallation} ` +
      `shouldFailOnRegression=${inputs.shouldFailOnRegression} ` +
      `shouldFailOnScriptError=${inputs.shouldFailOnScriptError} ` +
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
  const langfuseProjectId =
    (await resolveProjectId({
      baseUrl: inputs.langfuseBaseUrl,
      publicKey: inputs.langfusePublicKey,
      secretKey: inputs.langfuseSecretKey,
    })) ?? undefined;
  const runnerEnv = { inputs, metadata };

  const results: ScriptResult[] = [];
  for (const script of scripts) {
    core.startGroup(`Running ${script.path}`);
    try {
      const rawResult: RawScriptResult = await script.run(runnerEnv);
      const normalizedResult = normalizeExperimentResult(rawResult.result);
      results.push({
        scriptPath: rawResult.scriptPath,
        scriptName: rawResult.scriptName,
        runtime: rawResult.runtime,
        error: rawResult.error,
        durationMs: rawResult.durationMs,
        normalizedResult,
        langfuseExperimentUrl: resolveLangfuseExperimentUrl({
          result: normalizedResult,
          baseUrl: inputs.langfuseBaseUrl,
          projectId: langfuseProjectId,
        }),
      });
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

  const regressions = results.filter((r) => r.error?.isRegression).length;
  const scriptErrors = results.filter((r) => r.error && !r.error.isRegression).length;
  const anyFailed = regressions + scriptErrors > 0;
  core.debug(
    `Any failures: ${anyFailed} (regressions=${regressions} scriptErrors=${scriptErrors})`,
  );

  setOutputs({
    results,
    actionMetadata: metadata,
  });

  if (inputs.shouldCommentOnPr) {
    await publishExperimentComment({ inputs, results, metadata });
  }

  const shouldFailJob =
    (regressions > 0 && inputs.shouldFailOnRegression) ||
    (scriptErrors > 0 && inputs.shouldFailOnScriptError);

  if (shouldFailJob) {
    core.setFailed(
      `Experiment run failed: ${regressions} regression(s), ${scriptErrors} script error(s). ` +
        `Set should_fail_on_regression and/or should_fail_on_script_error to false to treat these as warnings.`,
    );
  }
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`langfuse/experiment-action crashed: ${message}`);
});
