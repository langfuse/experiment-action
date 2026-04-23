import { describe, expect, it } from "vitest";

import {
  experimentDisplayName,
  normalizeExperimentResult,
  resolveLangfuseExperimentUrl,
} from "@/experiment-result";

describe("normalizeExperimentResult", () => {
  it("normalizes python snake_case payloads to the canonical experiment_result shape", () => {
    const normalized = normalizeExperimentResult({
      name: "Uppercase task",
      experiment_id: "exp_123",
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
    });

    expect(normalized).toEqual({
      experimentId: "exp_123",
      runName: "Uppercase task",
      runEvaluations: [{ name: "avg_accuracy", value: 1, dataType: "NUMERIC" }],
      itemResults: [
        {
          item: {
            id: "dataset-item-42",
            input: "hello",
            expectedOutput: "HELLO",
            metadata: { source: "fixture" },
          },
          input: "hello",
          expectedOutput: "HELLO",
          output: "HELLO",
          evaluations: [{ name: "exact_match", value: 1, configId: "cfg_1" }],
          traceId: "trace_1",
          datasetRunId: "run_1",
        },
      ],
    });
  });

  it("returns null for non-object payloads", () => {
    expect(normalizeExperimentResult(null)).toBeNull();
    expect(normalizeExperimentResult("bad payload")).toBeNull();
  });
});

describe("experimentDisplayName", () => {
  it("strips the JS SDK timestamp suffix from runName", () => {
    expect(
      experimentDisplayName({
        experimentId: "exp_456",
        runName: "Uppercase task - 2026-04-22T16:00:00.000Z",
        itemResults: [],
        runEvaluations: [],
      }),
    ).toBe("Uppercase task");
  });
});

describe("resolveLangfuseExperimentUrl", () => {
  it("returns null without enough information to build an experiment URL", () => {
    expect(
      resolveLangfuseExperimentUrl({
        result: {
          experimentId: "exp_456",
          runName: "Uppercase task - 2026-04-22T16:00:00.000Z",
          itemResults: [],
          runEvaluations: [],
        },
      }),
    ).toBeNull();
  });

  it("does not build a Langfuse URL for local-data experiments", () => {
    expect(
      resolveLangfuseExperimentUrl({
        result: {
          experimentId: "exp_123",
          runName: "Uppercase task",
          itemResults: [],
          runEvaluations: [],
        },
        baseUrl: "http://localhost:3000",
        projectId: "project_123",
      }),
    ).toBeNull();
  });

  it("builds the experiment results URL for dataset-backed experiments", () => {
    expect(
      resolveLangfuseExperimentUrl({
        result: {
          experimentId: "exp_123",
          datasetRunId: "run_123",
          runName: "Uppercase task",
          itemResults: [],
          runEvaluations: [],
        },
        baseUrl: "http://localhost:3000",
        projectId: "project_123",
      }),
    ).toBe("http://localhost:3000/project/project_123/experiments/results?baseline=exp_123");
  });
});
