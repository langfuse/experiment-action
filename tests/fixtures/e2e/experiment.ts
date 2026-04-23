/**
 * E2E fixture: deterministic experiment against a live Langfuse instance.
 *
 * Mirrors `experiment.py`. Inline dataset, pure string-transform task (no
 * LLM), per-item and run-level evaluators. OpenTelemetry is initialized so
 * experiment traces land in Langfuse alongside the returned result.
 */
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

interface ItemInput {
  input: string;
  expectedOutput: string;
}

const LOCAL_DATA: ItemInput[] = [
  { input: "hello", expectedOutput: "HELLO" },
  { input: "world", expectedOutput: "WORLD" },
  { input: "langfuse", expectedOutput: "LANGFUSE" },
];

const uppercaseTask = async (item: { input?: unknown }) => String(item.input).toUpperCase();

const exactMatch = async ({
  output,
  expectedOutput,
}: {
  output: string;
  expectedOutput: string;
}) => {
  const ok = output === expectedOutput;
  return {
    name: "exact_match",
    value: ok ? 1.0 : 0.0,
    comment: ok
      ? "match"
      : `expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(output)}`,
  };
};

const avgAccuracy = async ({
  itemResults,
}: {
  itemResults: Array<{ evaluations: Array<{ name: string; value: number | null }> }>;
}) => {
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

export async function experiment() {
  const otelSdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  otelSdk.start();
  try {
    const langfuse = new LangfuseClient();
    const datasetName = process.env.LANGFUSE_DATASET_NAME;
    if (datasetName) {
      const dataset = await langfuse.dataset.get(datasetName);
      return await dataset.runExperiment({
        name: "Uppercase (ts)",
        description: "Deterministic string-transform task; no LLM involved.",
        task: uppercaseTask,
        evaluators: [exactMatch],
        runEvaluators: [avgAccuracy],
      });
    }

    return await langfuse.experiment.run({
      name: "Uppercase (ts)",
      description: "Deterministic string-transform task; no LLM involved.",
      data: LOCAL_DATA,
      task: uppercaseTask,
      evaluators: [exactMatch],
      runEvaluators: [avgAccuracy],
    });
  } finally {
    await otelSdk.shutdown();
  }
}
