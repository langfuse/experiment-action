/** Mixed-runtime E2E fixture (Node side): dataset-backed experiment. */
import type {
  EvaluatorParams,
  ExperimentTaskParams,
  RunEvaluatorParams,
  RunnerContext,
} from "@langfuse/client";

type Input = string;
type ExpectedOutput = string;

const task = async (item: ExperimentTaskParams<Input, ExpectedOutput>) =>
  String(item.input).toUpperCase();

const exactMatch = async ({ output, expectedOutput }: EvaluatorParams<Input, ExpectedOutput>) => ({
  name: "exact_match",
  value: output === expectedOutput ? 1.0 : 0.0,
});

const avgAccuracy = async ({ itemResults }: RunEvaluatorParams<Input, ExpectedOutput>) => {
  const scores = itemResults
    .flatMap((r) => r.evaluations)
    .filter((e) => e.name === "exact_match")
    .map((e) => (typeof e.value === "number" ? e.value : 0));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return { name: "avg_accuracy", value: avg };
};

export async function experiment(context: RunnerContext<Input, ExpectedOutput>) {
  return await context.runExperiment({
    name: "Mixed dir (node)",
    task,
    evaluators: [exactMatch],
    runEvaluators: [avgAccuracy],
  });
}
