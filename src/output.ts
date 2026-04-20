import * as core from "@actions/core";

import type { ScriptResult } from "./types";

export function setOutputs(results: ScriptResult[]): void {
  const anyFailed = results.some((r) => r.error !== null);

  const payload = results.map((r) => ({
    script: r.scriptPath,
    runtime: r.runtime,
    duration_ms: r.durationMs,
    result: r.result,
    error: r.error,
  }));

  const json = JSON.stringify(payload);
  core.debug(`Outputs: failed=${anyFailed} result_json=${json.length} bytes`);
  core.setOutput("result_json", json);
  core.setOutput("failed", anyFailed ? "true" : "false");
}
