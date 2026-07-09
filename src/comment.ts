import * as path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  experimentDisplayName,
  type NormalizedExperimentItemResult,
  type NormalizedExperimentResult,
} from "@/experiment-result";
import { errorMessage, errorStatus } from "@/github/errors";
import type { JobInfo } from "@/github/job-url";
import { makeOctokit, type Octokit } from "@/github/octokit";
import { buildDatasetItemUrl } from "@/langfuse/project";

import { buildScriptBlobUrl, buildWorkflowRunUrl } from "./metadata";
import type { ResolvedInputs, ScriptError, ScriptResult } from "./types";

export interface RenderScriptSectionOptions {
  /** The script to render. */
  result: ScriptResult;
  /**
   * Per-job identity mixed into the section markers so parallel matrix legs
   * running the same script get distinct sections. Defaults to `""`.
   */
  jobKey?: string;
  /**
   * Human-readable job name appended to the section summary. Only set for
   * matrix legs / renamed jobs, where the experiment name alone can't tell
   * sections apart.
   */
  jobLabel?: string;
  /** Optional link to the CI run this section belongs to. */
  runUrl?: string;
  /** Optional link to this script at the exact tested Git SHA. */
  scriptUrl?: string;
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
 * Delimiters wrapping one invocation's section inside the run comment. We
 * key the marker on the script *path* (so two scripts whose SDK experiment
 * names collide still get separate sections) *and* the job key (so parallel
 * matrix legs running the same script don't overwrite each other — the job
 * display name is the only per-leg identity GitHub gives us).
 *
 * The trailing space on `start` is load-bearing: markers are matched by
 * `indexOf` prefix, and the space terminates the job key so `job=a` can
 * never match `job=ab` (`encodeURIComponent` never emits a space).
 */
function sectionMarkers(scriptPath: string, jobKey: string): { start: string; end: string } {
  const script = encodeURIComponent(scriptPath);
  const job = encodeURIComponent(jobKey);
  return {
    start: `<!-- langfuse-experiment-action:start script=${script} job=${job} `,
    end: `<!-- langfuse-experiment-action:end script=${script} job=${job} -->`,
  };
}

function overviewMarkers(): { start: string; end: string } {
  return {
    start: "<!-- langfuse-experiment-action:overview:start -->",
    end: "<!-- langfuse-experiment-action:overview:end -->",
  };
}

function detailsMarkers(): { start: string; end: string } {
  return {
    start: "<!-- langfuse-experiment-action:details:start -->",
    end: "<!-- langfuse-experiment-action:details:end -->",
  };
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
  let s = stringifyCell(v).replace(/[\r\n]+/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  s = s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return s || "—";
}

function formatScore(v: NormalizedExperimentResult["runEvaluations"][number]["value"]): string {
  if (typeof v === "number") return v.toFixed(3);
  if (v == null) return "—";
  return cell(v, 32);
}

function statusSummary(err: ScriptError | null): { icon: string; status: string } {
  if (!err) return { icon: "✅", status: "✅ Pass" };
  if (err.isRegression) return { icon: "❌", status: "❌ Regression" };
  return { icon: "❌", status: "❌ Error" };
}

interface ParsedSectionOverview {
  scriptPath: string;
  /** Decoded job key; `undefined` for sections written by pre-job-key versions. */
  jobKey?: string;
  displayName: string;
  scriptLabel: string;
  status: string;
  runUrl?: string;
  langfuseUrl?: string;
  localDataset?: boolean;
}

function renderActionLinks(
  runUrl?: string,
  langfuseUrl?: string,
  localDataset?: boolean,
): string[] {
  const actions: string[] = [];
  if (runUrl) actions.push(`[View GitHub Action Run](${runUrl})`);
  if (langfuseUrl) actions.push(`[View in Langfuse](${langfuseUrl})`);
  if (localDataset) actions.push("Local dataset");
  return actions;
}

function renderActionMetadata(
  runUrl?: string,
  langfuseUrl?: string,
  localDataset?: boolean,
): string | null {
  const attrs: string[] = [];
  if (runUrl) attrs.push(`run=${encodeURIComponent(runUrl)}`);
  if (langfuseUrl) attrs.push(`langfuse=${encodeURIComponent(langfuseUrl)}`);
  if (localDataset) attrs.push("local_dataset=true");
  return attrs.length > 0 ? attrs.join(" ") : null;
}

function renderSectionStartMarker(
  scriptPath: string,
  jobKey: string,
  opts: { runUrl?: string; langfuseUrl?: string; localDataset?: boolean } = {},
): string {
  const { start } = sectionMarkers(scriptPath, jobKey);
  const attrs = renderActionMetadata(opts.runUrl, opts.langfuseUrl, opts.localDataset);
  return `${start}${attrs ? `${attrs} ` : ""}-->`;
}

function parseActionAttributes(raw?: string): {
  runUrl?: string;
  langfuseUrl?: string;
  localDataset?: boolean;
} {
  const attrs = new Map(
    (raw ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        const [key, ...valueParts] = part.split("=");
        return [key ?? "", valueParts.join("=")];
      }),
  );
  const runUrl = attrs.get("run") ? decodeURIComponent(attrs.get("run") ?? "") : undefined;
  const langfuseUrl = attrs.get("langfuse")
    ? decodeURIComponent(attrs.get("langfuse") ?? "")
    : undefined;
  return {
    runUrl,
    langfuseUrl,
    localDataset: attrs.get("local_dataset") === "true",
  };
}

function renderOverviewTable(metas: ParsedSectionOverview[]): string {
  const byDisplayName = new Map<string, ParsedSectionOverview[]>();
  for (const meta of metas) {
    const group = byDisplayName.get(meta.displayName) ?? [];
    group.push(meta);
    byDisplayName.set(meta.displayName, group);
  }

  const rows = metas.map((meta) => {
    const group = byDisplayName.get(meta.displayName) ?? [];
    let experiment = cell(meta.displayName, 56);
    if (group.length > 1) {
      // Colliding display names usually mean matrix legs sharing a script —
      // the job name is what tells them apart. Fall back to the script label
      // when job keys don't disambiguate (distinct scripts, same name).
      const jobKeys = new Set(group.map((m) => m.jobKey ?? ""));
      const disambiguator =
        meta.jobKey && jobKeys.size === group.length ? meta.jobKey : meta.scriptLabel;
      experiment = `${cell(meta.displayName, 48)} (\`${cell(disambiguator, 32)}\`)`;
    }

    return [
      experiment,
      cell(meta.status, 20),
      renderActionLinks(meta.runUrl, meta.langfuseUrl, meta.localDataset).join(" · ") || "—",
    ];
  });

  return [
    "| Experiment | Status | Actions |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function replaceMarkedBlock(body: string, start: string, end: string, replacement: string): string {
  const startIdx = body.indexOf(start);
  const endIdx = body.indexOf(end, startIdx >= 0 ? startIdx : 0);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return body;

  const before = body.slice(0, startIdx).replace(/\s+$/, "");
  const after = body.slice(endIdx + end.length).replace(/^\s+/, "");
  return `${before}\n\n${replacement}\n\n${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function parseSectionOverview(body: string): ParsedSectionOverview[] {
  const sections: ParsedSectionOverview[] = [];
  // `job=` is optional so sections written by pre-job-key action versions
  // (possible when one run mixes action versions across jobs) still parse.
  const regex =
    /<!-- langfuse-experiment-action:start script=([^ >]+)(?: job=([^ >]*))?([^>]*)-->/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    const encodedScriptPath = match[1];
    if (!encodedScriptPath) continue;

    const scriptPath = decodeURIComponent(encodedScriptPath);
    const encodedJobKey = match[2];
    // Reconstruct the end marker in the same format the section was written
    // in — from the *encoded* captures, so we match byte-for-byte.
    const end =
      encodedJobKey === undefined
        ? `<!-- langfuse-experiment-action:end script=${encodedScriptPath} -->`
        : `<!-- langfuse-experiment-action:end script=${encodedScriptPath} job=${encodedJobKey} -->`;
    const sectionStart = match.index;
    const sectionEnd = body.indexOf(end, sectionStart);
    if (sectionEnd === -1) continue;

    const sectionBody = body.slice(sectionStart, sectionEnd + end.length);
    const summaryText = sectionBody.match(/<details(?: open)?><summary>(.*?)<\/summary>/s)?.[1];
    if (!summaryText) continue;

    const firstSpace = summaryText.indexOf(" ");
    if (firstSpace === -1) continue;

    const displayName = summaryText
      .slice(firstSpace + 1)
      .replace(/ \(&lt;a href="[^"]+"&gt;Source&lt;\/a&gt;\)$/, "")
      .replace(/ \(<a href="[^"]+">Source<\/a>\)$/, "");
    const scriptLabelText = scriptLabel(scriptPath, path.basename(scriptPath));
    const status = sectionBody.includes("> **Run failed —")
      ? "❌ Error"
      : sectionBody.match(/^> \*\*.+:\*\*/m)
        ? "❌ Regression"
        : "✅ Pass";
    const startAttrs = parseActionAttributes(match[3]?.trim());
    const legacyActionMeta = parseActionAttributes(
      sectionBody.match(/<!-- langfuse-experiment-action:actions ([^>]+) -->/)?.[1],
    );
    const runUrl = startAttrs.runUrl ?? legacyActionMeta.runUrl;
    const langfuseUrl = startAttrs.langfuseUrl ?? legacyActionMeta.langfuseUrl;
    const localDataset = startAttrs.localDataset ?? legacyActionMeta.localDataset;

    sections.push({
      scriptPath,
      jobKey: encodedJobKey === undefined ? undefined : decodeURIComponent(encodedJobKey),
      displayName,
      scriptLabel: scriptLabelText,
      status,
      runUrl,
      langfuseUrl,
      localDataset,
    });
  }

  return sections;
}

function refreshOverview(body: string): string {
  const { start: overviewStart, end: overviewEnd } = overviewMarkers();
  const { start: detailsStart, end: detailsEnd } = detailsMarkers();
  const withoutOverview = replaceMarkedBlock(body, overviewStart, overviewEnd, "");
  const withoutLayout = replaceMarkedBlock(withoutOverview, detailsStart, detailsEnd, "");
  const metas = parseSectionOverview(withoutLayout);
  if (metas.length === 0) return withoutLayout;

  const firstSectionIdx = withoutLayout.indexOf("<!-- langfuse-experiment-action:start script=");
  if (firstSectionIdx === -1) return withoutLayout;

  const overviewBlock = [overviewStart, renderOverviewTable(metas), overviewEnd].join("\n");
  const detailsBlock = [detailsStart, "**Details**", detailsEnd].join("\n");
  const before = withoutLayout.slice(0, firstSectionIdx).replace(/\s+$/, "");
  const after = withoutLayout.slice(firstSectionIdx).replace(/^\s+/, "");
  return `${before}\n\n${overviewBlock}\n\n${detailsBlock}\n\n${after}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

function renderSectionSummary(params: { icon: string; displayName: string }): string {
  return `${params.icon} ${params.displayName}`;
}

function renderSummarySourceLink(scriptUrl?: string): string {
  if (!scriptUrl) return "";
  return ` (<a href="${scriptUrl}">Source</a>)`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderScoresTable(evaluations: NormalizedExperimentResult["runEvaluations"]): string {
  if (evaluations.length === 0) return "";
  const rows = evaluations.map((e) => `| \`${e.name}\` | ${formatScore(e.value)} |`);
  return ["| Score | Value |", "| --- | --- |", ...rows].join("\n");
}

function extractLangfuseProjectRef(
  langfuseUrl?: string,
): { baseUrl: string; projectId: string } | null {
  if (!langfuseUrl) return null;

  try {
    const url = new URL(langfuseUrl);
    const projectIdx = url.pathname.indexOf("/project/");
    if (projectIdx === -1) return null;

    const basePath = url.pathname.slice(0, projectIdx);
    const projectPath = url.pathname.slice(projectIdx + "/project/".length);
    const [projectId] = projectPath.split("/", 1);
    if (!projectId) return null;

    return {
      baseUrl: `${url.origin}${basePath}`,
      projectId: decodeURIComponent(projectId),
    };
  } catch {
    return null;
  }
}

function itemLinkUrl(
  itemResult: NormalizedExperimentItemResult,
  langfuseUrl?: string,
): string | undefined {
  const itemId = typeof itemResult.item.id === "string" ? itemResult.item.id : undefined;
  const datasetId =
    typeof itemResult.item.dataset_id === "string"
      ? itemResult.item.dataset_id
      : typeof itemResult.item.datasetId === "string"
        ? itemResult.item.datasetId
        : undefined;
  if (!itemId || !datasetId) return undefined;

  const projectRef = extractLangfuseProjectRef(langfuseUrl);
  if (!projectRef) return undefined;

  return buildDatasetItemUrl({
    baseUrl: projectRef.baseUrl,
    projectId: projectRef.projectId,
    datasetId,
    itemId,
  });
}

function renderItemsTable(
  itemResults: NormalizedExperimentItemResult[],
  opts: { langfuseUrl?: string } = {},
): string {
  if (itemResults.length === 0) return "";
  const evaluatorNames = Array.from(
    new Set(itemResults.flatMap((r) => r.evaluations.map((e) => e.name))),
  );

  const header = ["Item", "Input", "Expected", "Output", ...evaluatorNames];
  const rows = itemResults.map((r, idx) => {
    const label = String(idx + 1);
    const itemUrl = itemLinkUrl(r, opts.langfuseUrl);
    const scoreByName = new Map(r.evaluations.map((e) => [e.name, e.value]));
    const cells = [
      itemUrl ? `[${label}](${itemUrl})` : label,
      cell(r.input),
      cell(r.expectedOutput),
      cell(r.output),
      ...evaluatorNames.map((n) =>
        scoreByName.has(n)
          ? formatScore(
              scoreByName.get(n) as NormalizedExperimentResult["runEvaluations"][number]["value"],
            )
          : "—",
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
    return `> **${err.name}:** ${err.message}`;
  }
  return `> **Run failed — ${err.name}:** ${err.message}`;
}

/**
 * Render one `ScriptResult` as a complete PR-comment section, wrapped in
 * start/end markers keyed on the script path.
 *
 * Heading comes from the normalized SDK-style `runName`; on a crash (no
 * result) we fall back to the script filename so the section still shows
 * something recognisable.
 */
export function renderScriptSection(opts: RenderScriptSectionOptions): string {
  const { result: scriptResult, jobKey = "", jobLabel, runUrl, scriptUrl } = opts;
  const { end } = sectionMarkers(scriptResult.scriptPath, jobKey);
  const normalized = scriptResult.normalizedResult;
  const langfuseUrl = scriptResult.langfuseExperimentUrl ?? undefined;
  const localDataset = Boolean(normalized && !normalized.datasetRunId);
  const failed = scriptResult.error !== null;
  const displayName =
    (normalized ? experimentDisplayName(normalized) : undefined) ?? scriptResult.scriptName;
  const { icon } = statusSummary(scriptResult.error);
  const summary = renderSectionSummary({
    icon,
    displayName: jobLabel ? `${displayName} — ${jobLabel}` : displayName,
  });
  const lines: string[] = [
    renderSectionStartMarker(scriptResult.scriptPath, jobKey, {
      runUrl,
      langfuseUrl,
      localDataset,
    }),
    failed
      ? `<details open><summary>${summary}${renderSummarySourceLink(scriptUrl)}</summary>`
      : `<details><summary>${summary}${renderSummarySourceLink(scriptUrl)}</summary>`,
    "",
  ];

  if (scriptResult.error) {
    lines.push(renderErrorCallout(scriptResult.error));
    lines.push("");
  }

  if (normalized && normalized.runEvaluations.length > 0) {
    lines.push("<br>");
    lines.push("");
    lines.push(renderScoresTable(normalized.runEvaluations));
    lines.push("");
  }

  if (normalized && normalized.itemResults.length > 0) {
    const total = normalized.itemResults.length;
    const visible = normalized.itemResults.slice(0, MAX_ITEMS_SHOWN);
    const hiddenCount = total - visible.length;

    lines.push(`<details><summary>Item results (${total})</summary>`);
    lines.push("");
    lines.push(renderItemsTable(visible, { langfuseUrl }));
    if (hiddenCount > 0) {
      lines.push("");
      if (langfuseUrl) {
        lines.push(
          `_Showing first ${visible.length} of ${total} — [View in Langfuse](${langfuseUrl}) for the full set._`,
        );
      } else {
        lines.push(`_Showing first ${visible.length} of ${total}._`);
      }
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (
    !scriptResult.error &&
    !normalized?.runEvaluations.length &&
    !normalized?.itemResults.length
  ) {
    lines.push("_No evaluations or items were returned._");
    lines.push("");
  }

  lines.push("</details>");
  lines.push(end);
  return `${lines.join("\n").trimEnd()}\n`;
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
  return `### ${icon} Experiment Results${suffix}`;
}

export function buildFreshCommentBody(
  runId: string,
  titleOpts: CommentTitleOptions,
  sections: string[],
): string {
  const body = [runMarker(runId), renderCommentTitle(titleOpts), ...sections].join("\n\n");
  return refreshOverview(`${body.trimEnd()}\n`);
}

export function refreshCommentTitle(body: string, titleOpts: CommentTitleOptions): string {
  const title = renderCommentTitle(titleOpts);
  const lines = body.split("\n");
  const titleIdx = lines.findIndex((line) => line.startsWith(`### <img src="${LANGFUSE_ICON}"`));
  if (titleIdx !== -1) {
    lines[titleIdx] = title;
    return lines.join("\n");
  }

  const markerIdx = lines.findIndex((line) =>
    line.startsWith("<!-- langfuse-experiment-action run_id="),
  );
  if (markerIdx !== -1) {
    lines.splice(markerIdx + 1, 0, "", title);
    return lines.join("\n");
  }

  return `${title}\n\n${body.replace(/^\s+/, "")}`;
}

/**
 * Replace an existing section keyed on `(scriptPath, jobKey)` in place, or
 * append it to the end of the body if none exists.
 */
export function upsertSection(
  existingBody: string,
  scriptPath: string,
  jobKey: string,
  section: string,
): string {
  const { start, end } = sectionMarkers(scriptPath, jobKey);
  const updated = replaceMarkedBlock(existingBody, start, end, section);
  if (updated !== existingBody) return updated;
  return `${existingBody.replace(/\s+$/, "")}\n\n${section}\n`;
}

// ---------------------------------------------------------------------------
// PR comment upsert
// ---------------------------------------------------------------------------

export interface PostPrCommentOptions {
  /** One entry per script being reported, all from the same job. */
  sections: Array<{ scriptPath: string; jobKey: string; markdown: string }>;
  token: string;
  runId: string;
  /** Used in the top-level title on the first invocation in a run. */
  shortSha?: string;
  runAttempt?: number;
  /** Override in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Override in tests for deterministic jitter. Returns [0, 1). */
  jitter?: () => number;
}

/**
 * Bound on the merge-verify-retry loop below. Each retry only fires when a
 * concurrent job clobbered our write, so in practice one or two attempts
 * suffice even for large matrices.
 */
const MAX_UPSERT_ATTEMPTS = 5;

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
 * A job that loses a creation race deletes its duplicate after merging.
 * Residual risk: a job killed mid-retry can still leave its sections
 * missing — hence the warning on exhaustion.
 */
export async function postPrComment(opts: PostPrCommentOptions): Promise<void> {
  const { sections, token, runId, shortSha, runAttempt } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const jitter = opts.jitter ?? Math.random;

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
      const canonical = await findCanonicalComment(octokit, repo, pr.number, marker);

      const titleOpts = { shortSha, runAttempt };
      let body = canonical
        ? refreshCommentTitle(canonical.body, titleOpts)
        : buildFreshCommentBody(runId, titleOpts, []);
      for (const { scriptPath, jobKey, markdown } of sections) {
        body = upsertSection(body, scriptPath, jobKey, markdown);
      }
      body = refreshOverview(body);

      if (canonical) {
        await octokit.rest.issues.updateComment({ ...repo, comment_id: canonical.id, body });
        if (ourCreatedId !== null && ourCreatedId !== canonical.id) {
          // We lost an earlier creation race. Our sections are now merged
          // into the canonical comment, so our duplicate is safe to drop.
          try {
            await octokit.rest.issues.deleteComment({ ...repo, comment_id: ourCreatedId });
            ourCreatedId = null;
          } catch (deleteErr) {
            // Keep the id on failure (except 404 = already gone) so the
            // verify below fails and the next attempt retries the delete
            // instead of declaring convergence over an orphan duplicate.
            if (errorStatus(deleteErr) === 404) ourCreatedId = null;
            else core.debug(`Failed to delete duplicate comment: ${errorMessage(deleteErr)}`);
          }
        }
      } else {
        const created = await octokit.rest.issues.createComment({
          ...repo,
          issue_number: pr.number,
          body,
        });
        ourCreatedId = created.data.id;
      }

      await sleep(300 + jitter() * 600);
      const verified = await findCanonicalComment(octokit, repo, pr.number, marker);
      // Compare full section content, not just the markers: a stale
      // concurrent write can carry an *older* version of our section (same
      // markers, outdated body), e.g. when re-running a leg. Sections land
      // in the body verbatim modulo trailing-whitespace collapsing, so a
      // substring check on the trimmed markdown is exact.
      const verifiedBody = normalizeLineEndings(verified?.body ?? "");
      const converged =
        verified !== null &&
        (ourCreatedId === null || ourCreatedId === verified.id) &&
        sections.every(({ markdown }) =>
          verifiedBody.includes(normalizeLineEndings(markdown).trimEnd()),
        );
      if (converged) {
        core.info(`Upserted run ${runId} comment ${verified.id} on PR #${pr.number}.`);
        return;
      }
      core.debug(`PR comment write was clobbered by a concurrent job (attempt ${attempt}).`);
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
  // Surface the job name in section summaries only when it adds signal
  // (matrix legs / renamed jobs); plain jobs keep today's rendering.
  const jobLabel = jobInfo?.name && jobInfo.name !== env.GITHUB_JOB ? jobInfo.name : undefined;

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
