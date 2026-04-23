import * as core from "@actions/core";
import * as github from "@actions/github";

import { errorMessage, errorStatus } from "./errors";
import { makeOctokit } from "./octokit";

/**
 * Resolve the URL to the specific job this action is running in. Returns
 * `null` when the API can't be reached or the job can't be pinned down —
 * callers should then fall back to the workflow-run URL.
 *
 * Why an API call is unavoidable: `GITHUB_JOB` is the YAML job *key*, not
 * the numeric job id that appears in the URL, and GitHub doesn't expose
 * that id anywhere in the runner environment. We list jobs on the current
 * run attempt and pick ours by `runner_name` (a runner only executes one
 * job at a time on a given attempt, so this is deterministic). If the env
 * var is unexpectedly empty we fall through to a "single in-progress job"
 * match before giving up.
 *
 * Requires `actions: read` on the workflow token. On 403 we surface a
 * single warning so callers can self-diagnose.
 */
export async function resolveJobUrl(params: {
  token: string;
  runId: string;
  runAttempt: string;
  runnerName?: string;
}): Promise<string | null> {
  const { token, runId, runAttempt, runnerName } = params;
  if (!token || !runId) return null;

  const runIdNum = Number(runId);
  const attemptNum = Math.max(1, Number(runAttempt) || 1);
  if (!Number.isFinite(runIdNum)) return null;

  const octokit = makeOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRunAttempt({
      owner,
      repo,
      run_id: runIdNum,
      attempt_number: attemptNum,
    });

    if (runnerName) {
      const match = data.jobs.find((j) => j.runner_name === runnerName);
      if (match?.html_url) return match.html_url;
    }

    // Fallback for the rare case where RUNNER_NAME is empty (some
    // self-hosted setups): a single in-progress job is unambiguously us.
    const inProgress = data.jobs.filter((j) => j.status === "in_progress");
    if (inProgress.length === 1 && inProgress[0].html_url) {
      return inProgress[0].html_url;
    }

    core.warning(
      `Could not identify the current job (runner="${runnerName ?? ""}", ` +
        `${data.jobs.length} jobs, ${inProgress.length} in progress). ` +
        "Falling back to the workflow-run URL.",
    );
    return null;
  } catch (err) {
    const status = errorStatus(err);
    const msg = errorMessage(err);

    if (status === 403) {
      core.warning(
        "Job-URL lookup was denied (HTTP 403). Grant `actions: read` to the " +
          "workflow (or the specific job) so the PR comment can link directly " +
          "to the job run. Falling back to the workflow-run URL.",
      );
    } else {
      core.warning(
        `Job-URL lookup failed (${status ?? "no status"}): ${msg}. ` +
          "Falling back to the workflow-run URL.",
      );
    }
    return null;
  }
}
