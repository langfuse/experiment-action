import * as core from "@actions/core";
import * as github from "@actions/github";

import { makeOctokit } from "./octokit";

/**
 * Resolve the URL to the specific job this action is running in. Falls back
 * to `null` if the GitHub API can't be reached or the job can't be
 * disambiguated — callers should then substitute the workflow-run URL.
 *
 * Why this needs an API call: `GITHUB_JOB` is the YAML job *key*, not the
 * numeric job id the URL requires. We have to list jobs on the current run
 * attempt and pick ours. The heuristic, in order of preference:
 *
 *   1. `status === "in_progress"` — the usual case while we're executing
 *   2. any non-`completed` status if there's exactly one such job — that
 *      one must be us (covers GitHub briefly reporting `queued`/`waiting`)
 *   3. `jobs[].name === $GITHUB_JOB` — works when the YAML doesn't set a
 *      `name:` (the API echoes the key back as the display name)
 */
export async function resolveJobUrl(params: {
  token: string;
  runId: string;
  runAttempt: string;
  jobNameHint: string;
}): Promise<string | null> {
  const { token, runId, runAttempt, jobNameHint } = params;
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

    core.debug(
      `Jobs for run ${runId} / attempt ${attemptNum}: ` +
        data.jobs.map((j) => `${j.name}(${j.status})`).join(", "),
    );

    // 1. Our job is almost always the one currently marked "in_progress".
    const inProgress = data.jobs.find((j) => j.status === "in_progress");
    if (inProgress?.html_url) {
      core.debug(`Resolved job URL via in_progress match: ${inProgress.html_url}`);
      return inProgress.html_url;
    }

    // 2. If there's exactly one non-completed job, it must be us. Covers
    //    the brief window where GitHub reports our job as `queued`,
    //    `waiting`, or `pending` instead of `in_progress`.
    const active = data.jobs.filter((j) => j.status !== "completed");
    if (active.length === 1 && active[0].html_url) {
      core.debug(`Resolved job URL via sole-active match: ${active[0].html_url}`);
      return active[0].html_url;
    }

    // 3. Fall back to matching against the YAML key. Only works when the
    //    user didn't set a custom `name:` on the job.
    const byName = data.jobs.find((j) => j.name === jobNameHint);
    if (byName?.html_url) {
      core.debug(`Resolved job URL via name match (${jobNameHint}): ${byName.html_url}`);
      return byName.html_url;
    }

    core.debug(
      `Could not disambiguate the current job (name="${jobNameHint}", ` +
        `${data.jobs.length} jobs, ${active.length} active).`,
    );
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.debug(`resolveJobUrl failed: ${msg}`);
    return null;
  }
}
