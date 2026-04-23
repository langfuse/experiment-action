import { normalizeExperimentResult } from "@/experiment-result";
import type { RawScriptResult, ScriptResult } from "@/types";

export function scriptResultFromRaw(
  result: RawScriptResult,
  overrides: Partial<ScriptResult> = {},
): ScriptResult {
  return {
    scriptPath: result.scriptPath,
    scriptName: result.scriptName,
    runtime: result.runtime,
    error: result.error,
    durationMs: result.durationMs,
    normalizedResult: normalizeExperimentResult(result.result),
    langfuseExperimentUrl: null,
    ...overrides,
  };
}
