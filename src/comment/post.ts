// The GitHub API layer of the PR comment: resolving the canonical comment
// for a run, the convergent merge-verify-retry upsert, and the high-level
// entry point used by `main.ts`. All text assembly lives in `./body`.

import * as core from "@actions/core";
import * as github from "@actions/github";

import { errorMessage, errorStatus } from "@/github/errors";
import type { JobInfo } from "@/github/job-info";
import { makeOctokit, type Octokit } from "@/github/octokit";

import { buildScriptBlobUrl, buildWorkflowRunUrl } from "../metadata";
import type { ResolvedInputs, ScriptResult } from "../types";

import {
  buildFreshCommentBody,
  refreshCommentTitle,
  refreshOverview,
  renderScriptSection,
  runMarker,
  type SectionKey,
  upsertSection,
} from "./body";

// ---------------------------------------------------------------------------
// PR comment upsert
// ---------------------------------------------------------------------------

export interface PostPrCommentOptions {
  /** One entry per script being reported, all from the same job. */
  sections: Array<SectionKey & { markdown: string }>;
  token: string;
  runId: string;
  /** Used in the top-level title on the first invocation in a run. */
  shortSha?: string;
  runAttempt?: number;
  /** Override in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bound on the merge-verify-retry loop below. Each retry only fires when a
 * concurrent job clobbered our write, so in practice one or two attempts
 * suffice even for large matrices.
 */
const MAX_UPSERT_ATTEMPTS = 5;

/**
 * Delay before the verify read. Long enough that a racing writer's update
 * (a read-modify-write round trip against the GitHub API is typically a
 * few hundred ms) usually lands before we re-read; jittered so retrying
 * jobs desynchronize instead of clobbering each other in lockstep.
 */
const VERIFY_DELAY_BASE_MS = 300;
const VERIFY_DELAY_JITTER_MS = 600;

/** GitHub may serve comment bodies with CRLF; we always write LF. */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * The comment all racing jobs converge on: the *oldest* (lowest-id) comment
 * carrying the run marker. Lowest-id is a deterministic tiebreak every job
 * agrees on when a creation race produced duplicates.
 */
async function findCanonicalComment(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  issueNumber: number,
  marker: string,
): Promise<{ id: number; body: string } | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const candidates = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
  if (candidates.length === 0) return null;
  const oldest = candidates.reduce((a, b) => (a.id <= b.id ? a : b));
  return { id: oldest.id, body: oldest.body ?? "" };
}

/**
 * Post (or upsert) the single PR comment for this workflow run.
 *
 *   - If no comment exists yet for `runId`, create one carrying the title
 *     and all provided sections.
 *   - If a comment exists, splice each section into the existing body
 *     (replace-in-place for `(script, job)` keys we've rendered before in
 *     this run, append otherwise), then update the comment in one API
 *     call.
 *
 * Different `runId`s always get fresh comments so users see evolution
 * across commits and re-pushes.
 *
 * Parallel jobs (e.g. matrix legs) race on this shared comment and GitHub
 * offers no compare-and-swap for comments, so the upsert is *convergent*
 * instead of atomic: every writer merges into the canonical comment
 * (preserving other jobs' sections), then verifies its own sections
 * survived and retries the merge if a concurrent writer clobbered them.
 * A job that loses a creation race deletes its duplicate — but only after
 * its sections are verified inside the canonical comment, so a job killed
 * mid-loop leaves at worst a duplicate comment, never missing data.
 * Residual risk: a job killed mid-retry can still leave its sections
 * missing — hence the warning on exhaustion.
 */
export async function postPrComment(opts: PostPrCommentOptions): Promise<void> {
  const { sections, token, runId, shortSha, runAttempt } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.info("Skipping PR comment: not a pull_request event.");
    return;
  }
  if (!token) {
    core.warning(
      "Skipping PR comment: no `github_token` input provided. " +
        "Pass `github_token: ${{ github.token }}` to the action step and grant " +
        "`permissions: pull-requests: write` to the workflow.",
    );
    return;
  }
  if (sections.length === 0) {
    core.debug("No sections to post; skipping PR comment.");
    return;
  }

  const octokit = makeOctokit(token);
  const marker = runMarker(runId);
  const repo = { owner: ctx.repo.owner, repo: ctx.repo.repo };

  core.debug(`PR comment run marker: ${marker}`);
  core.debug(`Upserting ${sections.length} section(s).`);

  try {
    let ourCreatedId: number | null = null;

    for (let attempt = 1; attempt <= MAX_UPSERT_ATTEMPTS; attempt++) {
      try {
        const canonical = await findCanonicalComment(octokit, repo, pr.number, marker);

        const titleOpts = { shortSha, runAttempt };
        if (canonical) {
          let body = refreshCommentTitle(canonical.body, titleOpts);
          for (const section of sections) {
            body = upsertSection(body, section, section.markdown);
          }
          body = refreshOverview(body);
          await octokit.rest.issues.updateComment({ ...repo, comment_id: canonical.id, body });
        } else if (ourCreatedId === null) {
          let body = buildFreshCommentBody(runId, titleOpts, []);
          for (const section of sections) {
            body = upsertSection(body, section, section.markdown);
          }
          body = refreshOverview(body);
          const created = await octokit.rest.issues.createComment({
            ...repo,
            issue_number: pr.number,
            body,
          });
          ourCreatedId = created.data.id;
        }
        // Else: we already created a comment but the listing doesn't show
        // it yet (read lag). Creating again would just spawn another
        // duplicate — wait for the verify read below instead.

        await sleep(VERIFY_DELAY_BASE_MS + Math.random() * VERIFY_DELAY_JITTER_MS);
        const verified = await findCanonicalComment(octokit, repo, pr.number, marker);
        // Compare full section content, not just the markers: a stale
        // concurrent write can carry an *older* version of our section (same
        // markers, outdated body), e.g. when re-running a leg. Sections land
        // in the body verbatim modulo trailing-whitespace collapsing, so a
        // substring check on the trimmed markdown is exact.
        const verifiedBody = normalizeLineEndings(verified?.body ?? "");
        const contentOk =
          verified !== null &&
          sections.every(({ markdown }) =>
            verifiedBody.includes(normalizeLineEndings(markdown).trimEnd()),
          );
        if (!contentOk) {
          core.debug(`PR comment write was clobbered by a concurrent job (attempt ${attempt}).`);
          continue;
        }

        if (ourCreatedId !== null && verified.id !== ourCreatedId) {
          // We lost a creation race, and our sections are now *verified*
          // inside the canonical comment — only now is our duplicate safe
          // to drop. Deleting before the verify could lose data: had the
          // merge been clobbered and this job killed, the duplicate would
          // have been the only surviving copy of our sections.
          try {
            await octokit.rest.issues.deleteComment({ ...repo, comment_id: ourCreatedId });
            ourCreatedId = null;
          } catch (deleteErr) {
            if (errorStatus(deleteErr) === 404) {
              ourCreatedId = null;
            } else {
              // Retry the delete on the next attempt rather than leaving
              // an orphan duplicate behind.
              core.debug(`Failed to delete duplicate comment: ${errorMessage(deleteErr)}`);
              continue;
            }
          }
        }

        core.info(`Upserted run ${runId} comment ${verified.id} on PR #${pr.number}.`);
        return;
      } catch (attemptErr) {
        // A transient API failure (5xx, timeout) shouldn't abort the
        // remaining attempts — riding out flaky moments is the point of
        // the loop. Permission errors can't heal on retry; rethrow so the
        // outer handler prints the actionable hint.
        if (errorStatus(attemptErr) === 403) throw attemptErr;
        core.debug(`PR comment attempt ${attempt} failed (${errorMessage(attemptErr)}); retrying.`);
      }
    }

    core.warning(
      `PR comment for run ${runId} may be incomplete: concurrent jobs kept racing on the ` +
        `shared comment for ${MAX_UPSERT_ATTEMPTS} attempts. Re-run this job to refresh it.`,
    );
  } catch (err) {
    const status = errorStatus(err);
    const msg = errorMessage(err);

    const looksLikeRateLimit = /rate limit/i.test(msg);
    const hint =
      status === 403 && !looksLikeRateLimit
        ? " — check that the workflow grants `pull-requests: write`."
        : "";
    core.warning(`Failed to post PR comment: ${msg}${hint}`);
  }
}

// ---------------------------------------------------------------------------
// High-level entry point used by `main.ts` — keeps the orchestration
// (project-id lookup, run-URL fallback, section assembly, env plumbing) in
// one place so `main.ts` stays declarative.
// ---------------------------------------------------------------------------

export interface PublishExperimentCommentOptions {
  inputs: ResolvedInputs;
  results: ScriptResult[];
  /** Resolved once in `main.ts`; `null` when the lookup failed or was skipped. */
  jobInfo?: JobInfo | null;
  /** Override `process.env` in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Render + upsert the PR comment for the current action invocation.
 *
 * Picks the best CI-run URL available (job URL → workflow-run URL), builds
 * one section per `ScriptResult`, and hands the batch to `postPrComment`.
 */
export async function publishExperimentComment(
  opts: PublishExperimentCommentOptions,
): Promise<void> {
  const { inputs, results, jobInfo } = opts;
  const env = opts.env ?? process.env;

  // Fall back to the workflow-run URL so the comment still carries a link
  // even when job resolution failed (e.g. no `actions: read`).
  const runUrl = jobInfo?.htmlUrl ?? buildWorkflowRunUrl(env) ?? undefined;

  // The job display name is the only per-leg identity for matrix jobs.
  // Without it (no `actions: read`) fall back to the YAML job key, which
  // still separates different jobs — just not legs of the same matrix.
  const jobKey = jobInfo?.name ?? env.GITHUB_JOB ?? "";
  // Surface the job name in section summaries only for matrix legs, whose
  // display name is "<job key> (<matrix values>)" — the one shape where the
  // experiment name alone can't tell sections apart. Renamed non-matrix
  // jobs keep today's rendering (their name adds no signal, and changing it
  // would alter existing consumers' comments on upgrade).
  const jobLabel =
    jobInfo?.name && env.GITHUB_JOB && jobInfo.name.startsWith(`${env.GITHUB_JOB} (`)
      ? jobInfo.name
      : undefined;

  const sections = results.map((result) => ({
    scriptPath: result.scriptPath,
    jobKey,
    markdown: renderScriptSection({
      result,
      jobKey,
      jobLabel,
      runUrl,
      scriptUrl: buildScriptBlobUrl(result.scriptPath, env) ?? undefined,
    }),
  }));

  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT ?? "1");
  const shortSha = (env.GITHUB_SHA ?? "").slice(0, 7) || undefined;

  await postPrComment({
    sections,
    token: inputs.githubToken,
    runId: env.GITHUB_RUN_ID ?? "",
    shortSha,
    runAttempt: Number.isFinite(runAttempt) ? runAttempt : 1,
  });
}
