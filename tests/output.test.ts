import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  setOutput: vi.fn(),
}));

import { resolveLangfuseExperimentUrl } from "@/experiment-result";
import { setOutputs } from "@/output";
import { RESULT_JSON_SCHEMA_VERSION, type OutputEnvelope } from "@/schema/output";
import type { RawScriptResult } from "@/types";

import { scriptResultFromRaw } from "./helpers/script-results";

function getOutputValue(name: string): string {
  const match = vi.mocked(core.setOutput).mock.calls.find((call) => call[0] === name);
  if (!match) {
    throw new Error(`Expected output ${name} to be set`);
  }
  return String(match[1]);
}

describe("setOutputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a versioned envelope for a passing experiment result", () => {
    const rawResult: RawScriptResult = {
      scriptPath: "/tmp/experiment.py",
      scriptName: "experiment.py",
      runtime: "python",
      durationMs: 4500,
      error: null,
      result: {
        name: "Uppercase task",
        experiment_id: "exp_123",
        dataset_run_id: "run_1",
        run_evaluations: [{ name: "avg_accuracy", value: 1, data_type: "NUMERIC" }],
        item_results: [
          {
            item: {
              id: "dataset-item-42",
              input: "hello",
              expected_output: "HELLO",
              metadata: { source: "fixture" },
            },
            output: "HELLO",
            evaluations: [{ name: "exact_match", value: 1, config_id: "cfg_1" }],
            trace_id: "trace_1",
            dataset_run_id: "run_1",
          },
        ],
      },
    };
    const derivedResult = scriptResultFromRaw(rawResult);
    const results = [
      {
        ...derivedResult,
        langfuseExperimentUrl: resolveLangfuseExperimentUrl({
          result: derivedResult.normalizedResult,
          baseUrl: "http://localhost:3000",
          projectId: "project_123",
        }),
      },
    ];

    setOutputs({
      results,
      actionMetadata: { "langfuse.git_sha": "abc123" },
    });

    const payload = JSON.parse(getOutputValue("result_json")) as OutputEnvelope;

    expect(payload).toEqual({
      schema_version: RESULT_JSON_SCHEMA_VERSION,
      action_metadata: { "langfuse.git_sha": "abc123" },
      results: [
        {
          script_path: "/tmp/experiment.py",
          script_name: "experiment.py",
          runtime: "python",
          duration_ms: 4500,
          status: "passed",
          langfuse_experiment_url:
            "http://localhost:3000/project/project_123/experiments/results?baseline=exp_123",
          error: null,
          experiment_result: {
            experiment_id: "exp_123",
            dataset_run_id: "run_1",
            run_name: "Uppercase task",
            run_evaluations: [{ name: "avg_accuracy", value: 1, data_type: "NUMERIC" }],
            item_results: [
              {
                item: {
                  id: "dataset-item-42",
                  input: "hello",
                  expected_output: "HELLO",
                  metadata: { source: "fixture" },
                },
                input: "hello",
                expected_output: "HELLO",
                output: "HELLO",
                evaluations: [{ name: "exact_match", value: 1, config_id: "cfg_1" }],
                trace_id: "trace_1",
                dataset_run_id: "run_1",
              },
            ],
          },
        },
      ],
    });
    expect(getOutputValue("failed")).toBe("false");
  });

  it("builds the regression output envelope from the resolved experiment URL", () => {
    const rawResult: RawScriptResult = {
      scriptPath: "/tmp/experiment.ts",
      scriptName: "experiment.ts",
      runtime: "node",
      durationMs: 1200,
      error: {
        name: "RegressionError",
        message: "accuracy dropped below threshold",
        isRegression: true,
        details: "traceback",
      },
      result: {
        experimentId: "exp_456",
        datasetRunId: "run_456",
        runName: "Uppercase task - 2026-04-22T16:00:00.000Z",
        runEvaluations: [{ name: "avg_accuracy", value: 0.5 }],
        itemResults: [],
      },
    };
    const results = [
      scriptResultFromRaw(rawResult, {
        langfuseExperimentUrl:
          "http://localhost:3000/project/project_123/experiments/results?baseline=exp_456",
      }),
    ];

    setOutputs({
      results,
      actionMetadata: { "langfuse.event": "pull_request" },
    });

    const payload = JSON.parse(getOutputValue("result_json")) as OutputEnvelope;
    expect(payload.results[0]).toEqual({
      script_path: "/tmp/experiment.ts",
      script_name: "experiment.ts",
      runtime: "node",
      duration_ms: 1200,
      status: "regression",
      langfuse_experiment_url:
        "http://localhost:3000/project/project_123/experiments/results?baseline=exp_456",
      error: {
        name: "RegressionError",
        message: "accuracy dropped below threshold",
        is_regression: true,
        details: "traceback",
      },
      experiment_result: {
        experiment_id: "exp_456",
        dataset_run_id: "run_456",
        run_name: "Uppercase task - 2026-04-22T16:00:00.000Z",
        run_evaluations: [{ name: "avg_accuracy", value: 0.5 }],
        item_results: [],
      },
    });
    expect(getOutputValue("failed")).toBe("true");
  });
});
