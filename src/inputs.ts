import * as core from "@actions/core";
import * as v from "valibot";

import type { ResolvedInputs } from "./types";

const TRUE_VALUES = new Set(["true", "yes", "1", "y"]);
const FALSE_VALUES = new Set(["false", "no", "0", "n"]);

/**
 * Parses "true|yes|1|y" / "false|no|0|n" into a boolean, with a default when
 * the input is omitted or doesn't match. `core.getInput` only ever returns a
 * string, so there's no `undefined` case to worry about — `""` means "not
 * set" (→ use default).
 */
function booleanFromString(defaultValue: boolean) {
  return v.pipe(
    v.string(),
    v.transform((raw): boolean => {
      const normalised = raw.trim().toLowerCase();
      if (normalised === "") return defaultValue;
      if (TRUE_VALUES.has(normalised)) return true;
      if (FALSE_VALUES.has(normalised)) return false;
      core.warning(`Could not parse boolean value "${raw}", falling back to ${defaultValue}.`);
      return defaultValue;
    }),
  );
}

/** Trim and fall back to a default string when empty. */
function stringWithDefault(defaultValue: string) {
  return v.pipe(
    v.string(),
    v.transform((raw) => raw.trim() || defaultValue),
  );
}

/** Trim to non-empty string, or `undefined`. */
const OptionalTrimmedString = v.pipe(
  v.string(),
  v.transform((raw): string | undefined => raw.trim() || undefined),
);

/**
 * Exported so tests can cover the multiline parsing behaviour in isolation.
 * Lines are trimmed; blank lines and `#` comments are skipped; malformed
 * entries log a warning and are ignored.
 */
export function parseMetadata(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      core.warning(`Ignoring metadata entry "${trimmed}" — expected key=value.`);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) {
      core.warning(`Ignoring metadata entry with empty key: "${trimmed}".`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Schema for the raw strings the GitHub Actions runtime hands us via
 * `INPUT_*` env vars. Each field is parsed from a string; validation +
 * defaulting + coercion live together here instead of being scattered.
 */
const InputsSchema = v.object({
  experimentPath: v.pipe(v.string(), v.trim(), v.minLength(1, "experiment_path is required")),
  langfusePublicKey: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "langfuse_public_key is required"),
  ),
  langfuseSecretKey: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "langfuse_secret_key is required"),
  ),
  langfuseBaseUrl: stringWithDefault("https://cloud.langfuse.com"),
  datasetName: OptionalTrimmedString,
  datasetVersion: OptionalTrimmedString,
  customMetadata: v.pipe(v.string(), v.transform(parseMetadata)),
  shouldFailOnRegression: booleanFromString(true),
  shouldFailOnScriptError: booleanFromString(true),
  shouldCommentOnPr: booleanFromString(true),
  pythonSdkVersion: stringWithDefault("latest"),
  jsSdkVersion: stringWithDefault("latest"),
  shouldSkipSdkInstallation: booleanFromString(false),
  // action.yml can't default `github_token` to `${{ github.token }}` — that
  // expression is invalid inside an action manifest. Callers that want PR
  // comments must pass `github_token: ${{ github.token }}` (or a PAT) in
  // the step's `with:` block. Blank → no PR comment (with a warning later).
  githubToken: v.pipe(
    v.string(),
    v.transform((raw) => raw.trim()),
  ),
}) satisfies v.BaseSchema<unknown, ResolvedInputs, v.BaseIssue<unknown>>;

export function resolveInputs(): ResolvedInputs {
  const raw = {
    experimentPath: core.getInput("experiment_path"),
    langfusePublicKey: core.getInput("langfuse_public_key"),
    langfuseSecretKey: core.getInput("langfuse_secret_key"),
    langfuseBaseUrl: core.getInput("langfuse_base_url"),
    datasetName: core.getInput("dataset_name"),
    datasetVersion: core.getInput("dataset_version"),
    customMetadata: core.getInput("experiment_metadata"),
    shouldFailOnRegression: core.getInput("should_fail_on_regression"),
    shouldFailOnScriptError: core.getInput("should_fail_on_script_error"),
    shouldCommentOnPr: core.getInput("should_comment_on_pr"),
    pythonSdkVersion: core.getInput("python_sdk_version"),
    jsSdkVersion: core.getInput("js_sdk_version"),
    shouldSkipSdkInstallation: core.getInput("should_skip_sdk_installation"),
    githubToken: core.getInput("github_token"),
  };

  const result = v.safeParse(InputsSchema, raw);
  if (!result.success) {
    const messages = result.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid action inputs: ${messages}`);
  }

  const inputs = result.output;
  core.debug(`Parsed ${Object.keys(inputs.customMetadata).length} custom metadata entry(ies).`);

  // Mask secrets so they don't appear in logs even if we happen to log them.
  if (inputs.langfuseSecretKey) core.setSecret(inputs.langfuseSecretKey);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);

  return inputs;
}
