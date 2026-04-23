import * as core from "@actions/core";

import type { NormalizedExperimentResult } from "./experiment-result";
import {
  RESULT_JSON_SCHEMA_VERSION,
  type OutputEnvelope,
  type OutputError,
  type OutputExperimentResult,
  type ResultStatus,
} from "./schema/output";
import type { ScriptError, ScriptResult } from "./types";

export interface SetOutputsOptions {
  results: ScriptResult[];
  actionMetadata: Record<string, string>;
}

function outputError(error: ScriptError | null): OutputError | null {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    is_regression: error.isRegression,
    details: error.details,
  };
}

function resultStatus(result: ScriptResult): ResultStatus {
  if (!result.error) return "passed";
  return result.error.isRegression ? "regression" : "error";
}

function toOutputExperimentResult(
  result: NormalizedExperimentResult | null,
): OutputExperimentResult | null {
  if (!result) return null;
  return {
    experiment_id: result.experimentId,
    run_name: result.runName,
    dataset_run_id: result.datasetRunId,
    item_results: result.itemResults.map((itemResult) => {
      const { expectedOutput, ...restItem } = itemResult.item;
      return {
        item: {
          ...restItem,
          ...(expectedOutput !== undefined ? { expected_output: expectedOutput } : {}),
        },
        input: itemResult.input,
        expected_output: itemResult.expectedOutput,
        output: itemResult.output,
        evaluations: itemResult.evaluations.map((evaluation) => ({
          name: evaluation.name,
          value: evaluation.value,
          comment: evaluation.comment,
          metadata: evaluation.metadata,
          data_type: evaluation.dataType,
          config_id: evaluation.configId,
        })),
        trace_id: itemResult.traceId,
        dataset_run_id: itemResult.datasetRunId,
      };
    }),
    run_evaluations: result.runEvaluations.map((evaluation) => ({
      name: evaluation.name,
      value: evaluation.value,
      comment: evaluation.comment,
      metadata: evaluation.metadata,
      data_type: evaluation.dataType,
      config_id: evaluation.configId,
    })),
  };
}

export function buildOutputEnvelope(opts: SetOutputsOptions): OutputEnvelope {
  const { results, actionMetadata } = opts;
  return {
    schema_version: RESULT_JSON_SCHEMA_VERSION,
    action_metadata: actionMetadata,
    results: results.map((result) => ({
      script_path: result.scriptPath,
      script_name: result.scriptName,
      runtime: result.runtime,
      duration_ms: result.durationMs,
      status: resultStatus(result),
      langfuse_experiment_url: result.langfuseExperimentUrl,
      error: outputError(result.error),
      experiment_result: toOutputExperimentResult(result.normalizedResult),
    })),
  };
}

export function setOutputs(opts: SetOutputsOptions): void {
  const anyFailed = opts.results.some((result) => result.error !== null);
  const payload = buildOutputEnvelope(opts);

  const json = JSON.stringify(payload);
  core.debug(`Outputs: failed=${anyFailed} result_json=${json.length} bytes`);
  core.setOutput("result_json", json);
  core.setOutput("failed", anyFailed ? "true" : "false");
}
