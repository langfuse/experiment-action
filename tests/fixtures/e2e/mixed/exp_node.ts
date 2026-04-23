/** Mixed-runtime e2e fixture (Node side): runs a real experiment. */
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const task = async ({ input }: { input: string }) => String(input).toUpperCase();

const exactMatch = async ({
  output,
  expectedOutput,
}: {
  output: string;
  expectedOutput: string;
}) => ({
  name: "exact_match",
  value: output === expectedOutput ? 1.0 : 0.0,
});

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
  return { name: "avg_accuracy", value: avg };
};

export async function experiment() {
  const otelSdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  otelSdk.start();
  try {
    const langfuse = new LangfuseClient();
    return await langfuse.experiment.run({
      name: "Mixed dir (node)",
      data: [
        { input: "node", expectedOutput: "NODE" },
        { input: "typescript", expectedOutput: "TYPESCRIPT" },
      ],
      task,
      evaluators: [exactMatch],
      runEvaluators: [avgAccuracy],
    });
  } finally {
    await otelSdk.shutdown();
  }
}
