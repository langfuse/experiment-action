import type { InferOutput } from "valibot";
import * as v from "valibot";

export const RESULT_JSON_SCHEMA_VERSION = "v1";

export const resultStatusSchema = v.picklist(["passed", "regression", "error"] as const);

export const actionMetadataSchema = v.objectWithRest({}, v.string());

export const outputErrorSchema = v.strictObject({
  name: v.string(),
  message: v.string(),
  is_regression: v.boolean(),
  details: v.optional(v.string()),
});

export const outputEvaluationSchema = v.strictObject({
  name: v.string(),
  value: v.union([v.number(), v.string(), v.boolean(), v.null()]),
  comment: v.optional(v.string()),
  metadata: v.optional(v.objectWithRest({}, v.unknown())),
  data_type: v.optional(v.string()),
  config_id: v.optional(v.string()),
});

export const outputExperimentItemResultSchema = v.strictObject({
  item: v.objectWithRest({}, v.unknown()),
  input: v.optional(v.unknown()),
  expected_output: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
  evaluations: v.array(outputEvaluationSchema),
  trace_id: v.optional(v.string()),
  dataset_run_id: v.optional(v.string()),
});

export const outputExperimentResultSchema = v.strictObject({
  experiment_id: v.optional(v.string()),
  run_name: v.optional(v.string()),
  dataset_run_id: v.optional(v.string()),
  item_results: v.array(outputExperimentItemResultSchema),
  run_evaluations: v.array(outputEvaluationSchema),
});

export const outputEntrySchema = v.strictObject({
  script_path: v.string(),
  script_name: v.string(),
  runtime: v.picklist(["python", "node"] as const),
  duration_ms: v.number(),
  status: resultStatusSchema,
  langfuse_experiment_url: v.nullable(v.pipe(v.string(), v.url())),
  error: v.nullable(outputErrorSchema),
  experiment_result: v.nullable(outputExperimentResultSchema),
});

export const outputEnvelopeSchema = v.strictObject({
  schema_version: v.literal(RESULT_JSON_SCHEMA_VERSION),
  action_metadata: actionMetadataSchema,
  results: v.array(outputEntrySchema),
});

export type OutputError = InferOutput<typeof outputErrorSchema>;
export type OutputEvaluation = InferOutput<typeof outputEvaluationSchema>;
export type OutputExperimentItemResult = InferOutput<typeof outputExperimentItemResultSchema>;
export type OutputExperimentResult = InferOutput<typeof outputExperimentResultSchema>;
export type OutputEntry = InferOutput<typeof outputEntrySchema>;
export type OutputEnvelope = InferOutput<typeof outputEnvelopeSchema>;
export type ResultStatus = InferOutput<typeof resultStatusSchema>;
