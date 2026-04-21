import { resolveJobUrl } from "@/github/job-url";

/**
 * Namespace prepended to every default tag. Makes action-generated metadata
 * unambiguous alongside whatever tags the user adds via
 * `custom_experiment_tags` (which are passed through verbatim).
 */
const TAG_PREFIX = "langfuse.";

export interface ResolveTagsOptions {
  /** GitHub token used to resolve the job URL. Omit to skip that lookup. */
  token?: string;
  /** User-supplied tags, merged on top of the defaults. */
  custom?: Record<string, string>;
  /** Override `process.env` in tests. */
  env?: NodeJS.ProcessEnv;
}

type TagResolver = (
  env: NodeJS.ProcessEnv,
  opts: { token?: string },
) => string | null | Promise<string | null>;

/**
 * The complete set of default tags the action emits, in one place. Each
 * resolver returns the string value (with `langfuse.` prefix added
 * automatically) or `null` to skip the tag entirely. Read top-to-bottom to
 * see the full default tag vocabulary.
 */
const DEFAULT_TAGS: Record<string, TagResolver> = {
  git_sha: (env) => env.GITHUB_SHA ?? null,
  branch: (env) => env.GITHUB_REF_NAME ?? null,
  event: (env) => env.GITHUB_EVENT_NAME ?? null,
  github_workflow_name: (env) => env.GITHUB_WORKFLOW ?? null,
  github_job_name: (env) => env.GITHUB_JOB ?? null,
  github_job_attempt: (env) => env.GITHUB_RUN_ATTEMPT ?? null,
  // `actor` is the person who started *this* attempt — identical to the PR
  // opener on first runs, different when someone re-ran jobs. Covers both
  // cases in one tag.
  actor: (env) => env.GITHUB_TRIGGERING_ACTOR ?? env.GITHUB_ACTOR ?? null,
  pr_url: resolvePrUrl,
  github_job_url: resolveJobUrlTag,
};

/**
 * The full default tag bag for the current action invocation: env-derived
 * tags + any async-resolved tags (e.g. `langfuse.job_url`) + user-supplied
 * `custom` tags layered on top.
 *
 * Custom tags win on key collisions so authors can override anything the
 * action would emit automatically. Omit `token` to skip the job-URL lookup
 * (useful in tests).
 */
export async function resolveDefaultTags(
  options: ResolveTagsOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const opts = { token: options.token };

  const resolved = await Promise.all(
    Object.entries(DEFAULT_TAGS).map(
      async ([name, resolve]) => [name, await resolve(env, opts)] as const,
    ),
  );

  const tags: Record<string, string> = {};
  for (const [name, value] of resolved) {
    if (typeof value === "string" && value) {
      tags[`${TAG_PREFIX}${name}`] = value;
    }
  }

  return { ...tags, ...(options.custom ?? {}) };
}

/**
 * Not part of the default tag set — kept as a helper so the PR comment can
 * fall back to the workflow-run URL if the job URL lookup fails (the run
 * page still has all the logs; it's just one click deeper).
 */
export function buildWorkflowRunUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  if (!repo || !runId) return null;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${repo}/actions/runs/${runId}`;
}

// ---------------------------------------------------------------------------
// Resolver helpers — kept below the DEFAULT_TAGS table so the table itself
// stays scannable.
// ---------------------------------------------------------------------------

function resolvePrUrl(env: NodeJS.ProcessEnv): string | null {
  const ref = env.GITHUB_REF ?? "";
  const prMatch = ref.match(/^refs\/pull\/(\d+)\//);
  if (!prMatch) return null;
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!repo) return null;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${repo}/pull/${prMatch[1]}`;
}

async function resolveJobUrlTag(
  env: NodeJS.ProcessEnv,
  opts: { token?: string },
): Promise<string | null> {
  if (!opts.token) return null;
  return resolveJobUrl({
    token: opts.token,
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? "1",
    runnerName: env.RUNNER_NAME,
  });
}
