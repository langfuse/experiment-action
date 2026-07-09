import * as core from "@actions/core";
import * as github from "@actions/github";

import { errorMessage, errorStatus } from "./errors";
import { makeOctokit } from "./octokit";

export interface JobInfo {
  /** Deep link to this job's log page; `null` when the API omitted it. */
  htmlUrl: string | null;
  /**
   * The job's *display* name — includes matrix values (e.g. `eval (gpt-4)`),
   * unlike `$GITHUB_JOB` which is only the YAML job key. Unique within a
   * run and stable across run attempts.
   */
  name: string;
}

/**
 * Resolve the job this action is running in. Returns `null` when the API
 * can't be reached or the job can't be pinned down — callers should then
 * fall back to the workflow-run URL / `$GITHUB_JOB`.
 *
 * Why an API call is unavoidable: `GITHUB_JOB` is the YAML job *key*, not
 * the numeric job id that appears in the URL nor the matrix-aware display
 * name, and GitHub doesn't expose either anywhere in the runner
 * environment. We list jobs on the current run attempt and pick ours by
 * `runner_name` (a runner only executes one job at a time on a given
 * attempt, so this is deterministic). If the env var is unexpectedly empty
 * we fall through to a "single in-progress job" match before giving up.
 *
 * Requires `actions: read` on the workflow token. On 403 we surface a
 * single warning so callers can self-diagnose.
 */
export async function resolveJobInfo(params: {
  token: string;
  runId: string;
  runAttempt: string;
  runnerName?: string;
}): Promise<JobInfo | null> {
  const { token, runId, runAttempt, runnerName } = params;
  if (!token || !runId) return null;

  const runIdNum = Number(runId);
  const attemptNum = Math.max(1, Number(runAttempt) || 1);
  if (!Number.isFinite(runIdNum)) return null;

  const octokit = makeOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    // Paginate: the default page size is 30 and matrices routinely exceed
    // that, which would silently hide our own job from the listing.
    const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRunAttempt, {
      owner,
      repo,
      run_id: runIdNum,
      attempt_number: attemptNum,
      per_page: 100,
    });

    if (runnerName) {
      const candidates = jobs.filter((j) => j.runner_name === runnerName);
      if (candidates.length === 1) {
        return { htmlUrl: candidates[0].html_url, name: candidates[0].name };
      }
      if (candidates.length > 1) {
        // Runner names repeat when self-hosted runners share a name or a
        // runner already served earlier jobs of this attempt. Only one job
        // runs on a runner at a time, so a single in-progress candidate is
        // unambiguously us. Anything else: give up rather than guess — a
        // wrong pick could hand two matrix legs the same display name and
        // silently collapse their comment sections onto one key.
        const running = candidates.filter((j) => j.status === "in_progress");
        if (running.length === 1) {
          return { htmlUrl: running[0].html_url, name: running[0].name };
        }
        core.warning(
          `Could not disambiguate ${candidates.length} jobs on runner "${runnerName}" ` +
            `(${running.length} in progress). Falling back to the workflow-run URL.`,
        );
        return null;
      }
      // No candidate for our runner name (listing lag) — fall through to
      // the single-in-progress heuristic below.
    }

    // Fallback for the rare case where RUNNER_NAME is empty (some
    // self-hosted setups): a single in-progress job is unambiguously us.
    const inProgress = jobs.filter((j) => j.status === "in_progress");
    if (inProgress.length === 1) {
      return { htmlUrl: inProgress[0].html_url, name: inProgress[0].name };
    }

    core.warning(
      `Could not identify the current job (runner="${runnerName ?? ""}", ` +
        `${jobs.length} jobs, ${inProgress.length} in progress). ` +
        "Falling back to the workflow-run URL.",
    );
    return null;
  } catch (err) {
    const status = errorStatus(err);
    const msg = errorMessage(err);

    if (status === 403) {
      core.warning(
        "Job lookup was denied (HTTP 403). Grant `actions: read` to the " +
          "workflow (or the specific job) so the PR comment can link directly " +
          "to the job run and tell parallel matrix legs apart. " +
          "Falling back to the workflow-run URL.",
      );
    } else {
      core.warning(
        `Job lookup failed (${status ?? "no status"}): ${msg}. ` +
          "Falling back to the workflow-run URL.",
      );
    }
    return null;
  }
}
