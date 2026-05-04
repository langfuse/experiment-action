/**
 * E2E fixture: deterministic dataset-backed experiment against Langfuse.
 *
 * Mirrors `experiment.py`. Pure string-transform task (no LLM), per-item and
 * run-level evaluators.
 */
import type {
  EvaluatorParams,
  ExperimentTaskParams,
  RunEvaluatorParams,
  RunnerContext,
} from "@langfuse/client";

type Input = string;
type ExpectedOutput = string;

const uppercaseTask = async (item: ExperimentTaskParams<Input, ExpectedOutput>) =>
  String(item.input).toUpperCase();

const exactMatch = async ({ output, expectedOutput }: EvaluatorParams<Input, ExpectedOutput>) => {
  const ok = output === expectedOutput;
  return {
    name: "exact_match",
    value: ok ? 1.0 : 0.0,
    comment: ok
      ? "match"
      : `expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(output)}`,
  };
};

const avgAccuracy = async ({ itemResults }: RunEvaluatorParams<Input, ExpectedOutput>) => {
  const scores = itemResults
    .flatMap((r) => r.evaluations)
    .filter((e) => e.name === "exact_match")
    .map((e) => (typeof e.value === "number" ? e.value : 0));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    name: "avg_accuracy",
    value: avg,
    comment: `${scores.length} items, avg=${avg.toFixed(3)}`,
  };
};

export async function experiment(context: RunnerContext<Input, ExpectedOutput>) {
  return await context.runExperiment({
    name: "Uppercase (ts)",
    description: "Deterministic string-transform task; no LLM involved.",
    task: uppercaseTask,
    evaluators: [exactMatch],
    runEvaluators: [avgAccuracy],
  });
}
