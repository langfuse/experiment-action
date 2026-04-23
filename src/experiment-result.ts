import type { Evaluation as LangfuseEvaluation } from "@langfuse/client";

import { buildExperimentResultsUrl } from "@/langfuse/project";
import type {
  NormalizedEvaluation,
  NormalizedExperimentItemResult,
  NormalizedExperimentResult,
} from "@/schema/experiment-result";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function pickField<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  const record = asRecord(obj);
  if (!record) return undefined;

  for (const key of keys) {
    if (key in record && record[key] !== undefined) return record[key] as T;
  }
  return undefined;
}

function pickCanonicalField<T = unknown>(
  obj: unknown,
  canonicalKey: string,
  ...extraAliases: string[]
): T | undefined {
  return pickField<T>(obj, canonicalKey, toSnakeCase(canonicalKey), ...extraAliases);
}

function asEvaluation(raw: unknown): NormalizedEvaluation | null {
  const record = asRecord(raw);
  if (!record) return null;

  const name = typeof record.name === "string" ? record.name : null;
  if (!name) return null;

  const evaluation: NormalizedEvaluation = {
    name,
    value: (record.value ?? null) as NormalizedEvaluation["value"],
  };

  const comment = typeof record.comment === "string" ? record.comment : undefined;
  if (comment !== undefined) evaluation.comment = comment;

  const metadata = asRecord(record.metadata);
  if (metadata) evaluation.metadata = metadata;

  const dataType = pickCanonicalField(record, "dataType") as
    | LangfuseEvaluation["dataType"]
    | undefined;
  if (dataType) evaluation.dataType = dataType;

  const configId = pickCanonicalField<string>(record, "configId");
  if (configId) evaluation.configId = configId;

  return evaluation;
}

function asItemResult(raw: unknown): NormalizedExperimentItemResult | null {
  const record = asRecord(raw);
  if (!record) return null;

  const rawItem = asRecord(record.item) ?? {};
  const expectedOutput = pickCanonicalField(rawItem, "expectedOutput");
  const { expected_output: _expectedOutputSnake, ...restItem } = rawItem;
  const item: Record<string, unknown> = {
    ...restItem,
    ...(expectedOutput !== undefined ? { expectedOutput } : {}),
  };
  const itemId =
    pickField<string>(item, "id") ?? pickCanonicalField<string>(record, "datasetItemId");
  if (itemId && item.id === undefined) item.id = itemId;

  const evaluations = Array.isArray(record.evaluations)
    ? record.evaluations
        .map(asEvaluation)
        .filter((value): value is NormalizedEvaluation => value !== null)
    : [];

  const normalized: NormalizedExperimentItemResult = {
    item,
    input: pickField(record, "input") ?? item.input,
    expectedOutput: pickCanonicalField(record, "expectedOutput") ?? item.expectedOutput,
    output: record.output,
    evaluations,
  };

  const traceId = pickCanonicalField<string>(record, "traceId");
  if (traceId) normalized.traceId = traceId;

  const datasetRunId = pickCanonicalField<string>(record, "datasetRunId");
  if (datasetRunId) normalized.datasetRunId = datasetRunId;

  return normalized;
}

export function normalizeExperimentResult(raw: unknown): NormalizedExperimentResult | null {
  const record = asRecord(raw);
  if (!record) return null;

  const runEvaluationsRaw = pickCanonicalField<unknown[]>(record, "runEvaluations") ?? [];
  const itemResultsRaw = pickCanonicalField<unknown[]>(record, "itemResults") ?? [];

  const normalized: NormalizedExperimentResult = {
    runName: pickCanonicalField<string>(record, "runName") ?? pickField<string>(record, "name"),
    itemResults: itemResultsRaw
      .map(asItemResult)
      .filter((value): value is NormalizedExperimentItemResult => value !== null),
    runEvaluations: runEvaluationsRaw
      .map(asEvaluation)
      .filter((value): value is NormalizedEvaluation => value !== null),
  };

  const experimentId = pickCanonicalField<string>(record, "experimentId");
  if (experimentId) normalized.experimentId = experimentId;

  const datasetRunId = pickCanonicalField<string>(record, "datasetRunId");
  if (datasetRunId) normalized.datasetRunId = datasetRunId;

  return normalized;
}

/**
 * The JS SDK's `runName` usually appends an ISO timestamp; strip it when we
 * want the user-provided experiment name for display.
 */
export function experimentDisplayName(result: NormalizedExperimentResult): string | undefined {
  if (!result.runName) return undefined;
  return result.runName.replace(/ - \d{4}-\d{2}-\d{2}T[^ ]+$/, "") || result.runName;
}

export function resolveLangfuseExperimentUrl(params: {
  result: NormalizedExperimentResult | null;
  baseUrl?: string;
  projectId?: string;
}): string | null {
  const { result, baseUrl, projectId } = params;
  if (!result) return null;
  if (!result.datasetRunId) return null;

  if (baseUrl && projectId && typeof result.experimentId === "string" && result.experimentId) {
    return buildExperimentResultsUrl({
      baseUrl,
      projectId,
      experimentId: result.experimentId,
    });
  }

  return null;
}

export type {
  NormalizedEvaluation,
  NormalizedExperimentItemResult,
  NormalizedExperimentResult,
} from "./schema/experiment-result";
