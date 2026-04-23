import type { InferOutput } from "valibot";
import * as v from "valibot";

export const normalizedEvaluationValueSchema = v.union([
  v.number(),
  v.string(),
  v.boolean(),
  v.null(),
]);

export const metadataRecordSchema = v.objectWithRest({}, v.unknown());

export const normalizedEvaluationSchema = v.strictObject({
  name: v.string(),
  value: normalizedEvaluationValueSchema,
  comment: v.optional(v.string()),
  metadata: v.optional(metadataRecordSchema),
  dataType: v.optional(v.string()),
  configId: v.optional(v.string()),
});

export const normalizedExperimentItemResultSchema = v.strictObject({
  item: v.objectWithRest({}, v.unknown()),
  input: v.optional(v.unknown()),
  expectedOutput: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
  evaluations: v.array(normalizedEvaluationSchema),
  traceId: v.optional(v.string()),
  datasetRunId: v.optional(v.string()),
});

export const normalizedExperimentResultSchema = v.strictObject({
  experimentId: v.optional(v.string()),
  runName: v.optional(v.string()),
  datasetRunId: v.optional(v.string()),
  itemResults: v.array(normalizedExperimentItemResultSchema),
  runEvaluations: v.array(normalizedEvaluationSchema),
});

export type NormalizedEvaluation = InferOutput<typeof normalizedEvaluationSchema>;
export type NormalizedExperimentItemResult = InferOutput<
  typeof normalizedExperimentItemResultSchema
>;
export type NormalizedExperimentResult = InferOutput<typeof normalizedExperimentResultSchema>;
