export type Runtime = "python" | "node";

export interface ResolvedInputs {
  langfusePublicKey: string;
  langfuseSecretKey: string;
  langfuseBaseUrl: string;

  experimentPath: string;
  datasetName?: string;
  datasetVersion?: string;

  customTags: Record<string, string>;

  shouldFailOnError: boolean;
  shouldCommentOnPr: boolean;

  pythonSdkVersion: string;
  jsSdkVersion: string;
  shouldSkipSdkInstallation: boolean;
  githubToken: string;
}

export interface ScriptError {
  /** Error class name, e.g. "RegressionError", "ValueError". */
  name: string;
  message: string;
  /** True if the error name matches `RegressionError`. */
  isRegression: boolean;
  /** Raw stderr / traceback — trimmed to a reasonable length for rendering. */
  details?: string;
}

export interface ScriptResult {
  scriptPath: string;
  scriptName: string;
  runtime: Runtime;
  /** Parsed JSON produced by the user's `experiment()` function, when available. */
  result: unknown | null;
  /** Non-null if the script exited with an error (including RegressionError). */
  error: ScriptError | null;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}
