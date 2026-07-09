/**
 * Namespace prepended to every default metadata key. Makes action-generated
 * metadata unambiguous alongside whatever the user adds via
 * `experiment_metadata` (which is passed through verbatim).
 */
const METADATA_PREFIX = "langfuse.";

export interface ResolveMetadataOptions {
  /** Job URL resolved via the GitHub API (see `resolveJobInfo`). Omit to skip the entry. */
  jobUrl?: string | null;
  /** User-supplied metadata, merged on top of the defaults. */
  custom?: Record<string, string>;
  /** Override `process.env` in tests. */
  env?: NodeJS.ProcessEnv;
}

type MetadataResolver = (
  env: NodeJS.ProcessEnv,
  opts: { jobUrl?: string | null },
) => string | null | Promise<string | null>;

/**
 * The complete set of default metadata entries the action emits, in one
 * place. Each resolver returns the string value (with `langfuse.` prefix
 * added automatically) or `null` to skip the entry entirely. Read
 * top-to-bottom to see the full default metadata vocabulary.
 */
const DEFAULT_METADATA: Record<string, MetadataResolver> = {
  git_sha: (env) => env.GITHUB_SHA ?? null,
  branch: (env) => env.GITHUB_REF_NAME ?? null,
  event: (env) => env.GITHUB_EVENT_NAME ?? null,
  github_workflow_name: (env) => env.GITHUB_WORKFLOW ?? null,
  github_job_name: (env) => env.GITHUB_JOB ?? null,
  github_job_attempt: (env) => env.GITHUB_RUN_ATTEMPT ?? null,
  // `actor` is the person who started *this* attempt — identical to the PR
  // opener on first runs, different when someone re-ran jobs. Covers both
  // cases in one entry.
  actor: (env) => env.GITHUB_TRIGGERING_ACTOR ?? env.GITHUB_ACTOR ?? null,
  pr_url: resolvePrUrl,
  github_job_url: (_env, opts) => opts.jobUrl ?? null,
};

/**
 * The full default metadata bag for the current action invocation:
 * env-derived entries + any async-resolved ones (e.g. `langfuse.github_job_url`)
 * + user-supplied `custom` metadata layered on top.
 *
 * Custom entries win on key collisions so authors can override anything the
 * action would emit automatically.
 */
export async function resolveDefaultMetadata(
  options: ResolveMetadataOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const opts = { jobUrl: options.jobUrl };

  const resolved = await Promise.all(
    Object.entries(DEFAULT_METADATA).map(
      async ([name, resolve]) => [name, await resolve(env, opts)] as const,
    ),
  );

  const metadata: Record<string, string> = {};
  for (const [name, value] of resolved) {
    if (typeof value === "string" && value) {
      metadata[`${METADATA_PREFIX}${name}`] = value;
    }
  }

  return { ...metadata, ...(options.custom ?? {}) };
}

/**
 * Not part of the default metadata set — kept as a helper so the PR comment
 * can fall back to the workflow-run URL if the job URL lookup fails (the run
 * page still has all the logs; it's just one click deeper).
 */
export function buildWorkflowRunUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  if (!repo || !runId) return null;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${repo}/actions/runs/${runId}`;
}

/**
 * Build a GitHub blob URL for a script at the exact commit under test.
 * Returns `null` when we can't safely map the script path into the checked-out
 * workspace.
 */
export function buildScriptBlobUrl(
  scriptPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const sha = env.GITHUB_SHA ?? "";
  const workspace = env.GITHUB_WORKSPACE ?? "";
  if (!repo || !sha || !workspace) return null;

  const relativePath = scriptPath.startsWith("/")
    ? normalizeRepoPath(scriptPath, workspace)
    : scriptPath.replace(/\\/g, "/");
  if (!relativePath) return null;

  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const encodedPath = relativePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${server}/${repo}/blob/${sha}/${encodedPath}`;
}

// ---------------------------------------------------------------------------
// Resolver helpers — kept below the DEFAULT_METADATA table so the table
// itself stays scannable.
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

function normalizeRepoPath(scriptPath: string, workspace: string): string | null {
  const normalizedScript = scriptPath.replace(/\\/g, "/");
  const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedWorkspace) return null;
  if (normalizedScript === normalizedWorkspace) return null;
  if (!normalizedScript.startsWith(`${normalizedWorkspace}/`)) return null;
  return normalizedScript.slice(normalizedWorkspace.length + 1);
}
