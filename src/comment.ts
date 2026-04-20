import * as path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { makeOctokit } from "@/github/octokit";
import { buildExperimentResultsUrl, resolveProjectId } from "@/langfuse/project";

import { buildWorkflowRunUrl } from "./tags";
import type { ResolvedInputs, ScriptError, ScriptResult } from "./types";

export interface RenderScriptSectionOptions {
  /** The script to render. */
  result: ScriptResult;
  /** Optional link to the CI run this section belongs to. */
  runUrl?: string;
  /**
   * Langfuse base URL + resolved project id. Both must be set for the
   * "View on Langfuse" link to appear in the subtitle; if either is
   * missing, we silently omit it.
   */
  langfuseBaseUrl?: string;
  langfuseProjectId?: string;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Top-level marker identifying the single PR comment for a workflow run.
 * All action invocations in the same run share the same comment — they
 * splice their own sections into its body.
 */
function runMarker(runId: string): string {
  return `<!-- langfuse-experiment-action run_id=${encodeURIComponent(runId)} -->`;
}

/**
 * Delimiters wrapping one script's section inside the run comment. We key
 * the marker on the script *path* (encoded) so two scripts whose SDK
 * experiment names happen to collide still get separate sections.
 */
function sectionMarkers(scriptPath: string): { start: string; end: string } {
  const key = encodeURIComponent(scriptPath);
  return {
    start: `<!-- langfuse-experiment-action:start script=${key} -->`,
    end: `<!-- langfuse-experiment-action:end script=${key} -->`,
  };
}

// ---------------------------------------------------------------------------
// Result normalization — the Python SDK serializes fields as snake_case
// (`run_evaluations`, `item_results`), the JS SDK uses camelCase. Everything
// below reads from either shape.
// ---------------------------------------------------------------------------

interface Evaluation {
  name: string;
  value: number | string | boolean | null;
  comment?: string | null;
}

interface ItemResult {
  /** Identifier of the dataset item, if the SDK exposed one. */
  itemId?: string | null;
  input?: unknown;
  expectedOutput?: unknown;
  output?: unknown;
  evaluations: Evaluation[];
}

interface NormalizedResult {
  name?: string;
  /** Langfuse-side experiment id — used to build the UI link. */
  experimentId?: string;
  runEvaluations: Evaluation[];
  itemResults: ItemResult[];
}

function pickField<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in record && record[k] !== undefined) return record[k] as T;
  }
  return undefined;
}

function asEvaluation(raw: unknown): Evaluation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : null;
  if (!name) return null;
  const value = r.value as Evaluation["value"];
  const comment = typeof r.comment === "string" ? r.comment : null;
  return { name, value: value ?? null, comment };
}

function asItemResult(raw: unknown): ItemResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const item = (r.item ?? {}) as Record<string, unknown>;

  const itemId =
    pickField<string>(item, "id") ??
    pickField<string>(r, "datasetItemId", "dataset_item_id") ??
    null;
  const expectedOutput = pickField(item, "expectedOutput", "expected_output");
  const input = item.input;
  const output = r.output;
  const evaluations = Array.isArray(r.evaluations)
    ? r.evaluations.map(asEvaluation).filter((e): e is Evaluation => e !== null)
    : [];

  return { itemId, input, expectedOutput, output, evaluations };
}

/**
 * The JS SDK's `ExperimentResult` doesn't expose a bare `name` field — only
 * `runName`, which is `"<user-provided name> - <ISO timestamp>"`. Recover
 * the user's original name by stripping the trailing timestamp. If the
 * format doesn't match, use `runName` verbatim.
 */
function stripTimestampSuffix(runName: string): string {
  return runName.replace(/ - \d{4}-\d{2}-\d{2}T[^ ]+$/, "") || runName;
}

/**
 * Human-readable label for a script file. Extensions are kept (distinguishes
 * `experiment.py` from `experiment.ts`) and the immediate parent directory
 * is prefixed when informative, so several experiments named `experiment.py`
 * in different folders don't collapse to the same display string.
 */
function scriptLabel(scriptPath: string, scriptName: string): string {
  const parent = path.basename(path.dirname(scriptPath));
  if (!parent || parent === "." || parent === "/") return scriptName;
  return `${parent}/${scriptName}`;
}

function normalizeResult(raw: unknown): NormalizedResult | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  let name = pickField<string>(record, "name");
  if (!name) {
    const runName = pickField<string>(record, "runName", "run_name");
    if (runName) name = stripTimestampSuffix(runName);
  }
  const experimentId = pickField<string>(record, "experimentId", "experiment_id");
  const runEvalsRaw = pickField<unknown[]>(record, "runEvaluations", "run_evaluations") ?? [];
  const itemResultsRaw = pickField<unknown[]>(record, "itemResults", "item_results") ?? [];
  return {
    name,
    experimentId,
    runEvaluations: runEvalsRaw.map(asEvaluation).filter((e): e is Evaluation => e !== null),
    itemResults: itemResultsRaw.map(asItemResult).filter((r): r is ItemResult => r !== null),
  };
}

// ---------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------

const CELL_MAX = 80;

/**
 * Maximum rows shown in the per-item `<details>` table. GitHub caps
 * comments at 64 KB and a realistic item row is ~80 chars; 50 rows keeps
 * us comfortably under the cap even for multi-script directories, and
 * bigger lists are hard to scan by eye anyway. The full set is always one
 * click away via the "View on Langfuse" link in the subtitle.
 */
const MAX_ITEMS_SHOWN = 50;

function stringifyCell(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Escape + truncate a value to fit inside a markdown table cell. */
function cell(v: unknown, maxLen = CELL_MAX): string {
  let s = stringifyCell(v);
  s = s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s || "—";
}

function formatScore(v: Evaluation["value"]): string {
  if (typeof v === "number") return v.toFixed(3);
  if (v == null) return "—";
  return cell(v, 32);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderScoresTable(evaluations: Evaluation[]): string {
  if (evaluations.length === 0) return "";
  const rows = evaluations.map((e) => `| \`${e.name}\` | ${formatScore(e.value)} |`);
  return ["| Score | Value |", "| --- | --- |", ...rows].join("\n");
}

function renderItemsTable(itemResults: ItemResult[]): string {
  if (itemResults.length === 0) return "";
  const evaluatorNames = Array.from(
    new Set(itemResults.flatMap((r) => r.evaluations.map((e) => e.name))),
  );

  const header = ["Item", "Input", "Output", ...evaluatorNames];
  const rows = itemResults.map((r, idx) => {
    const label = r.itemId ?? String(idx + 1);
    const scoreByName = new Map(r.evaluations.map((e) => [e.name, e.value]));
    const cells = [
      cell(label, 24),
      cell(r.input),
      cell(r.output),
      ...evaluatorNames.map((n) =>
        scoreByName.has(n) ? formatScore(scoreByName.get(n) as Evaluation["value"]) : "—",
      ),
    ];
    return `| ${cells.join(" | ")} |`;
  });

  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows].join(
    "\n",
  );
}

/**
 * GitHub alert callouts — `[!WARNING]` for regressions (the user's own gate
 * fired → expected failure), `[!CAUTION]` for unrelated crashes
 * (unexpected). See
 * https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts
 */
function renderErrorCallout(err: ScriptError): string {
  if (err.isRegression) {
    return `> [!WARNING]\n> **${err.name}:** ${err.message}`;
  }
  return `> [!CAUTION]\n> **Run failed — ${err.name}:** ${err.message}`;
}

/**
 * Render one `ScriptResult` as a complete PR-comment section, wrapped in
 * start/end markers keyed on the script path.
 *
 * Heading comes from `ExperimentResult.name` when the SDK produced one; on
 * a crash (no result) we fall back to the script filename so the section
 * still shows something recognisable.
 */
export function renderScriptSection(opts: RenderScriptSectionOptions): string {
  const { result: scriptResult, runUrl, langfuseBaseUrl, langfuseProjectId } = opts;
  const { start, end } = sectionMarkers(scriptResult.scriptPath);

  const normalized = normalizeResult(scriptResult.result);
  // Prefer the SDK-provided experiment name; fall back to the script file
  // name so a crash with no result still has something recognisable.
  const displayName = normalized?.name ?? scriptResult.scriptName;

  const failed = scriptResult.error !== null;
  const icon = failed ? "❌" : "✅";

  const links: string[] = [];
  if (runUrl) links.push(`[View run](${runUrl})`);
  if (langfuseBaseUrl && langfuseProjectId && normalized?.experimentId) {
    const langfuseUrl = buildExperimentResultsUrl({
      baseUrl: langfuseBaseUrl,
      projectId: langfuseProjectId,
      experimentId: normalized.experimentId,
    });
    links.push(`[View on Langfuse](${langfuseUrl})`);
  }

  // Icon carries the pass/fail signal — no separate "Passed"/"Failed"
  // word. The script path is always shown in parens so the heading
  // disambiguates between scripts whose SDK names happen to collide and
  // tells you *where* the experiment came from.
  const lines: string[] = [
    start,
    "",
    `## ${icon} ${displayName} (\`${scriptLabel(scriptResult.scriptPath, scriptResult.scriptName)}\`)`,
    "",
  ];
  if (links.length > 0) {
    lines.push(links.join(" · "));
    lines.push("");
  }

  if (scriptResult.error) {
    lines.push(renderErrorCallout(scriptResult.error));
    lines.push("");
  }

  if (normalized && normalized.runEvaluations.length > 0) {
    lines.push(renderScoresTable(normalized.runEvaluations));
    lines.push("");
  }

  if (normalized && normalized.itemResults.length > 0) {
    const total = normalized.itemResults.length;
    const visible = normalized.itemResults.slice(0, MAX_ITEMS_SHOWN);
    const hiddenCount = total - visible.length;

    const summary = total === 1 ? "1 item" : `${total} items`;
    lines.push(`<details><summary>${summary}</summary>`);
    lines.push("");
    lines.push(renderItemsTable(visible));
    if (hiddenCount > 0) {
      lines.push("");
      lines.push(`_Showing first ${visible.length} of ${total} — view the full set in Langfuse._`);
    }
    lines.push("");
    lines.push("</details>");
  }

  if (
    !scriptResult.error &&
    !normalized?.runEvaluations.length &&
    !normalized?.itemResults.length
  ) {
    lines.push("_No evaluations or items were returned._");
  }

  if (lines[lines.length - 1] !== "") lines.push("");
  lines.push(end);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Comment body assembly
// ---------------------------------------------------------------------------

// Brand icon from https://langfuse.com/brand. Inline in the H1 gives the
// comment a recognizable signature without dominating the layout.
const LANGFUSE_ICON = "https://langfuse.com/brand-assets/icon/color/langfuse-icon.png";

export interface CommentTitleOptions {
  /** Short git SHA of the commit being tested (e.g. "abc1234"). */
  shortSha?: string;
  /** `$GITHUB_RUN_ATTEMPT`. Only surfaces when > 1. */
  runAttempt?: number;
}

/**
 * The top-level `# …` title of the comment. Shown once per run, preserved
 * across upserts.
 */
export function renderCommentTitle(opts: CommentTitleOptions = {}): string {
  // `align="center"` is what actually works on GitHub comments; their
  // markdown sanitizer drops inline `style`/CSS, but keeps the legacy
  // `align` attribute. See
  // https://github.com/orgs/community/discussions/183876
  const icon = `<img src="${LANGFUSE_ICON}" height="32" alt="" align="center" />`;
  const parts: string[] = [];
  if (opts.shortSha) parts.push(`\`${opts.shortSha}\``);
  if (opts.runAttempt && opts.runAttempt > 1) parts.push(`(#${opts.runAttempt})`);
  const suffix = parts.length > 0 ? `: ${parts.join(" ")}` : "";
  return `# ${icon} Langfuse Experiment Results${suffix}`;
}

export function buildFreshCommentBody(
  runId: string,
  titleOpts: CommentTitleOptions,
  sections: string[],
): string {
  const body = [runMarker(runId), renderCommentTitle(titleOpts), ...sections].join("\n\n");
  return `${body.trimEnd()}\n`;
}

/**
 * Replace an existing section keyed on `scriptPath` in place, or append it
 * to the end of the body if none exists.
 */
export function upsertSection(existingBody: string, scriptPath: string, section: string): string {
  const { start, end } = sectionMarkers(scriptPath);
  const startIdx = existingBody.indexOf(start);
  const endIdx = existingBody.indexOf(end, startIdx >= 0 ? startIdx : 0);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingBody.slice(0, startIdx).replace(/\s+$/, "");
    const after = existingBody.slice(endIdx + end.length).replace(/^\s+/, "");
    return `${before}\n\n${section}\n\n${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  return `${existingBody.replace(/\s+$/, "")}\n\n${section}\n`;
}

// ---------------------------------------------------------------------------
// PR comment upsert
// ---------------------------------------------------------------------------

export interface PostPrCommentOptions {
  /** One entry per script being reported. */
  sections: Array<{ scriptPath: string; markdown: string }>;
  token: string;
  runId: string;
  /** Used in the top-level title on the first invocation in a run. */
  shortSha?: string;
  runAttempt?: number;
}

/**
 * Post (or upsert) the single PR comment for this workflow run.
 *
 *   - If no comment exists yet for `runId`, create one carrying the title
 *     and all provided sections.
 *   - If a comment exists, splice each section into the existing body
 *     (replace-in-place for scripts whose paths we've rendered before in
 *     this run, append otherwise), then update the comment in one API
 *     call.
 *
 * Different `runId`s always get fresh comments so users see evolution
 * across commits and re-pushes.
 */
export async function postPrComment(opts: PostPrCommentOptions): Promise<void> {
  const { sections, token, runId, shortSha, runAttempt } = opts;

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

  core.debug(`PR comment run marker: ${marker}`);
  core.debug(`Upserting ${sections.length} section(s).`);

  try {
    const existing = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const match = existing.find((c) => typeof c.body === "string" && c.body.includes(marker));

    let body: string;
    if (match) {
      body = match.body ?? marker;
    } else {
      body = buildFreshCommentBody(runId, { shortSha, runAttempt }, []);
    }
    for (const { scriptPath, markdown } of sections) {
      body = upsertSection(body, scriptPath, markdown);
    }

    if (match) {
      await octokit.rest.issues.updateComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        comment_id: match.id,
        body,
      });
      core.info(`Updated run ${runId} comment ${match.id} on PR #${pr.number}.`);
    } else {
      await octokit.rest.issues.createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        issue_number: pr.number,
        body,
      });
      core.info(`Posted run ${runId} comment on PR #${pr.number}.`);
    }
  } catch (err) {
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : undefined;
    const msg = err instanceof Error ? err.message : String(err);

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
  /** The final resolved tag set — we read `langfuse.github_job_url` from it. */
  tags: Record<string, string>;
  /** Override `process.env` in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Render + upsert the PR comment for the current action invocation.
 *
 * Resolves the Langfuse project id (for "View on Langfuse" links), picks
 * the best CI-run URL available (job URL → workflow-run URL), builds one
 * section per `ScriptResult`, and hands the batch to `postPrComment`.
 */
export async function publishExperimentComment(
  opts: PublishExperimentCommentOptions,
): Promise<void> {
  const { inputs, results, tags } = opts;
  const env = opts.env ?? process.env;

  // Prefer the job URL (set by the tag resolver when the API call
  // succeeded); fall back to the workflow-run URL so the comment still
  // carries a link even when job-id resolution fails.
  const jobUrl = tags["langfuse.github_job_url"];
  const runUrl = jobUrl ?? buildWorkflowRunUrl(env) ?? undefined;

  // One API call resolves the Langfuse project id; `null` means we skip
  // the Langfuse link but everything else still renders.
  const langfuseProjectId =
    (await resolveProjectId({
      baseUrl: inputs.langfuseBaseUrl,
      publicKey: inputs.langfusePublicKey,
      secretKey: inputs.langfuseSecretKey,
    })) ?? undefined;

  const sections = results.map((result) => ({
    scriptPath: result.scriptPath,
    markdown: renderScriptSection({
      result,
      runUrl,
      langfuseBaseUrl: inputs.langfuseBaseUrl,
      langfuseProjectId,
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
