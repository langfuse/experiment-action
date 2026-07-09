import * as path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  experimentDisplayName,
  type NormalizedExperimentItemResult,
  type NormalizedExperimentResult,
} from "@/experiment-result";
import { errorMessage, errorStatus } from "@/github/errors";
import { makeOctokit } from "@/github/octokit";
import { buildDatasetItemUrl } from "@/langfuse/project";

import { buildScriptBlobUrl, buildWorkflowRunUrl } from "./metadata";
import type { ResolvedInputs, ScriptError, ScriptResult } from "./types";

export interface RenderScriptSectionOptions {
  /** The script to render. */
  result: ScriptResult;
  /** Optional link to the CI run this section belongs to. */
  runUrl?: string;
  /** Optional link to this script at the exact tested Git SHA. */
  scriptUrl?: string;
  /**
   * Optional user-supplied `comment_key`. When set, it joins the script path
   * to form the section key so that several matrix legs running the *same*
   * script (with different parameters) get distinct sections instead of
   * overwriting one another.
   */
  commentKey?: string;
  /**
   * Auto-derived job discriminator (the numeric GitHub job id). Used as a
   * zero-config fallback for `commentKey` so parallel matrix legs are
   * distinguished automatically; never shown to humans.
   */
  jobKey?: string;
}

/**
 * Identifies one section inside the run comment. The script path is always
 * part of the key (so distinct scripts never collide within a single
 * invocation). At most one discriminator is added on top of it:
 *
 *   - `commentKey` — the explicit `comment_key` input. Human-readable, so it
 *     also disambiguates rows in the overview table.
 *   - `jobKey` — the numeric GitHub job id, derived automatically from the
 *     resolved job URL. Distinguishes matrix legs with no configuration, but
 *     is opaque so it is used for identity only, never displayed.
 *
 * `commentKey` wins when both could apply.
 */
export interface SectionKey {
  scriptPath: string;
  commentKey?: string;
  jobKey?: string;
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
 *
 * A discriminator is appended as a second attribute — ` key=…` (explicit
 * `comment_key`) or ` job=…` (auto job id) — so that matrix legs sharing a
 * script path get distinct sections. The `script=` attribute is preserved
 * verbatim, so comments written by older versions of the action (which had
 * neither) continue to match and upsert exactly as before.
 */
function sectionMarkers(key: SectionKey): { start: string; end: string } {
  const script = encodeURIComponent(key.scriptPath);
  const keyAttr = key.commentKey ? ` key=${encodeURIComponent(key.commentKey)}` : "";
  const jobAttr = key.jobKey ? ` job=${encodeURIComponent(key.jobKey)}` : "";
  return {
    start: `<!-- langfuse-experiment-action:start script=${script}${keyAttr}${jobAttr}`,
    end: `<!-- langfuse-experiment-action:end script=${script}${keyAttr}${jobAttr} -->`,
  };
}

/** Extract a named attribute (decoded) from a section start marker's trailing attributes. */
function parseSectionAttr(name: string, raw?: string): string | undefined {
  const match = (raw ?? "").match(new RegExp(`(?:^|\\s)${name}=([^\\s>]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Extract the numeric job id from a resolved job URL
 * (`…/actions/runs/<run>/job/<jobId>`). Returns `undefined` for a
 * workflow-run URL (the fallback when job resolution fails), which has no
 * `/job/` segment — so auto-keying is simply skipped in that case.
 */
export function jobKeyFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/job\/(\d+)/);
  return match ? match[1] : undefined;
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
  commentKey?: string;
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
  key: SectionKey,
  opts: { runUrl?: string; langfuseUrl?: string; localDataset?: boolean } = {},
): string {
  const { start } = sectionMarkers(key);
  const attrs = renderActionMetadata(opts.runUrl, opts.langfuseUrl, opts.localDataset);
  return `${start}${attrs ? ` ${attrs}` : ""} -->`;
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
  const duplicates = new Map<string, number>();
  for (const meta of metas) {
    duplicates.set(meta.displayName, (duplicates.get(meta.displayName) ?? 0) + 1);
  }

  const rows = metas.map((meta) => {
    // When several sections share a display name, disambiguate with the
    // human-readable `comment_key` if the caller supplied one (e.g. matrix
    // legs), otherwise fall back to the script label.
    const disambiguator = meta.commentKey ?? meta.scriptLabel;
    const experiment =
      (duplicates.get(meta.displayName) ?? 0) > 1
        ? `${cell(meta.displayName, 48)} (\`${cell(disambiguator, 32)}\`)`
        : cell(meta.displayName, 56);

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
  const regex = /<!-- langfuse-experiment-action:start script=([^ >]+)([^>]*)-->/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    const encodedScriptPath = match[1];
    if (!encodedScriptPath) continue;

    const scriptPath = decodeURIComponent(encodedScriptPath);
    const commentKey = parseSectionAttr("key", match[2]);
    const jobKey = parseSectionAttr("job", match[2]);
    const { end } = sectionMarkers({ scriptPath, commentKey, jobKey });
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
    const startAttrs = parseActionAttributes(match[2]?.trim());
    const legacyActionMeta = parseActionAttributes(
      sectionBody.match(/<!-- langfuse-experiment-action:actions ([^>]+) -->/)?.[1],
    );
    const runUrl = startAttrs.runUrl ?? legacyActionMeta.runUrl;
    const langfuseUrl = startAttrs.langfuseUrl ?? legacyActionMeta.langfuseUrl;
    const localDataset = startAttrs.localDataset ?? legacyActionMeta.localDataset;

    sections.push({
      scriptPath,
      commentKey,
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
  const { result: scriptResult, runUrl, scriptUrl, commentKey, jobKey } = opts;
  const sectionKey: SectionKey = { scriptPath: scriptResult.scriptPath, commentKey, jobKey };
  const { end } = sectionMarkers(sectionKey);
  const normalized = scriptResult.normalizedResult;
  const langfuseUrl = scriptResult.langfuseExperimentUrl ?? undefined;
  const localDataset = Boolean(normalized && !normalized.datasetRunId);
  const failed = scriptResult.error !== null;
  const displayName =
    (normalized ? experimentDisplayName(normalized) : undefined) ?? scriptResult.scriptName;
  const { icon } = statusSummary(scriptResult.error);
  const summary = renderSectionSummary({
    icon,
    displayName,
  });
  const lines: string[] = [
    renderSectionStartMarker(sectionKey, { runUrl, langfuseUrl, localDataset }),
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
 * Replace an existing section keyed on `key` in place, or append it to the
 * end of the body if none exists.
 */
export function upsertSection(existingBody: string, key: SectionKey, section: string): string {
  const { start, end } = sectionMarkers(key);
  const updated = replaceMarkedBlock(existingBody, start, end, section);
  if (updated !== existingBody) return updated;
  return `${existingBody.replace(/\s+$/, "")}\n\n${section}\n`;
}

/**
 * Fold sections that live in `source` but not yet in `target` into `target`.
 *
 * Used to reconcile the create-create race: if two parallel jobs both create
 * the run comment before either sees the other's, we end up with duplicate
 * comments carrying disjoint sections. Before deleting the duplicate we copy
 * its sections across so no leg's results are lost.
 */
export function foldForeignSections(target: string, source: string): string {
  const regex = /<!-- langfuse-experiment-action:start script=([^ >]+)([^>]*)-->/g;
  let match: RegExpExecArray | null;
  let out = target;

  while ((match = regex.exec(source)) !== null) {
    const encodedScriptPath = match[1];
    if (!encodedScriptPath) continue;

    const key: SectionKey = {
      scriptPath: decodeURIComponent(encodedScriptPath),
      commentKey: parseSectionAttr("key", match[2]),
      jobKey: parseSectionAttr("job", match[2]),
    };
    const { start, end } = sectionMarkers(key);

    // Already present in the target (we own it, or already folded it) — skip.
    if (out.includes(start)) continue;

    const startIdx = source.indexOf(start, match.index);
    const endIdx = source.indexOf(end, startIdx);
    if (startIdx === -1 || endIdx === -1) continue;

    const block = source.slice(startIdx, endIdx + end.length);
    out = upsertSection(out, key, block);
  }

  return out;
}

// ---------------------------------------------------------------------------
// PR comment upsert
// ---------------------------------------------------------------------------

export interface SectionInput {
  scriptPath: string;
  /** Explicit `comment_key` discriminator, if the caller supplied one. */
  commentKey?: string;
  /** Auto-derived job-id discriminator, if a job URL was resolved. */
  jobKey?: string;
  markdown: string;
}

export interface PostPrCommentOptions {
  /** One entry per script being reported. */
  sections: SectionInput[];
  token: string;
  runId: string;
  /** Used in the top-level title on the first invocation in a run. */
  shortSha?: string;
  runAttempt?: number;
  /**
   * Max read-modify-write attempts before giving up (default {@link DEFAULT_UPSERT_ATTEMPTS}).
   * Exposed for tests; production callers rely on the default.
   */
  maxAttempts?: number;
  /** Injectable sleep so tests can drive the retry loop without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default bound on the concurrency-safe upsert retry loop. */
export const DEFAULT_UPSERT_ATTEMPTS = 5;

function sectionKeyOf(section: SectionInput): SectionKey {
  return {
    scriptPath: section.scriptPath,
    commentKey: section.commentKey,
    jobKey: section.jobKey,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped, in milliseconds. Jitter spreads
 * out matrix legs that would otherwise retry in lockstep and re-collide.
 */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(200 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 200);
}

/**
 * Post (or upsert) the single PR comment for this workflow run.
 *
 *   - If no comment exists yet for `runId`, create one carrying the title
 *     and all provided sections.
 *   - If a comment exists, splice each section into the existing body
 *     (replace-in-place for section keys we've rendered before in this run,
 *     append otherwise), then update the comment in one API call.
 *
 * Different `runId`s always get fresh comments so users see evolution
 * across commits and re-pushes.
 *
 * ## Concurrency
 *
 * Parallel matrix legs all target this one comment, so the read-modify-write
 * races: two legs read, both splice their own section onto the same base, and
 * the second write clobbers the first. The GitHub issue-comments API has no
 * conditional/compare-and-swap write, so we can't make this truly atomic.
 * Instead we retry: after each write we re-list and check that our section(s)
 * survived and that no duplicate run comment exists; if not, we re-fetch the
 * latest body, re-splice, and write again (bounded, with jittered backoff).
 * This narrows the race window dramatically but does not close it — under
 * extreme contention a section can still be dropped, hence the final warning.
 */
export async function postPrComment(opts: PostPrCommentOptions): Promise<void> {
  const { sections, token, runId, shortSha, runAttempt } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_UPSERT_ATTEMPTS);
  const sleep = opts.sleep ?? defaultSleep;

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
  const titleOpts = { shortSha, runAttempt };
  const repo = { owner: ctx.repo.owner, repo: ctx.repo.repo };

  core.debug(`PR comment run marker: ${marker}`);
  core.debug(`Upserting ${sections.length} section(s) (max ${maxAttempts} attempt(s)).`);

  // Fetch every comment carrying our run marker, oldest first. The oldest is
  // canonical; any others are create-race duplicates to be folded in + removed.
  const listRunComments = async (): Promise<Array<{ id: number; body: string }>> => {
    const all = await octokit.paginate(octokit.rest.issues.listComments, {
      ...repo,
      issue_number: pr.number,
      per_page: 100,
    });
    return all
      .filter((c): c is typeof c & { body: string } =>
        typeof c.body === "string" ? c.body.includes(marker) : false,
      )
      .map((c) => ({ id: c.id, body: c.body }))
      .sort((a, b) => a.id - b.id);
  };

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const matches = await listRunComments();
      const canonical = matches[0];
      const duplicates = matches.slice(1);

      let body = canonical
        ? refreshCommentTitle(canonical.body || marker, titleOpts)
        : buildFreshCommentBody(runId, titleOpts, []);
      // Preserve any sections stranded on duplicate comments before we drop them.
      for (const dup of duplicates) body = foldForeignSections(body, dup.body);
      // Our own sections are authoritative for their keys — splice last.
      for (const section of sections) {
        body = upsertSection(body, sectionKeyOf(section), section.markdown);
      }
      body = refreshOverview(body);

      let targetId: number;
      if (canonical) {
        await octokit.rest.issues.updateComment({ ...repo, comment_id: canonical.id, body });
        targetId = canonical.id;
      } else {
        const created = await octokit.rest.issues.createComment({
          ...repo,
          issue_number: pr.number,
          body,
        });
        targetId = created.data.id;
      }

      // Best-effort cleanup of the folded-in duplicates.
      for (const dup of duplicates) {
        try {
          await octokit.rest.issues.deleteComment({ ...repo, comment_id: dup.id });
        } catch (err) {
          core.debug(`Could not delete duplicate run comment ${dup.id}: ${errorMessage(err)}`);
        }
      }

      // Verify: did our sections survive, and is there exactly one run comment?
      const after = await listRunComments();
      const target = after.find((c) => c.id === targetId);
      const others = after.filter((c) => c.id !== targetId);
      const ourSectionsPresent =
        !!target &&
        sections.every((s) => target.body.includes(sectionMarkers(sectionKeyOf(s)).start));

      if (ourSectionsPresent && others.length === 0) {
        core.info(
          canonical
            ? `Updated run ${runId} comment ${targetId} on PR #${pr.number}` +
                (attempt > 1 ? ` (after ${attempt} attempts).` : ".")
            : `Posted run ${runId} comment ${targetId} on PR #${pr.number}` +
                (attempt > 1 ? ` (after ${attempt} attempts).` : "."),
        );
        return;
      }

      if (attempt < maxAttempts) {
        core.debug(
          `PR comment upsert contended (attempt ${attempt}/${maxAttempts}); re-fetching and retrying.`,
        );
        await sleep(backoffDelayMs(attempt));
      } else {
        core.warning(
          `PR comment upsert still contended after ${maxAttempts} attempts on PR #${pr.number}. ` +
            "A section may be missing under heavy matrix concurrency; re-running the job usually resolves it.",
        );
      }
    }
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
  /** The final resolved metadata set — we read `langfuse.github_job_url` from it. */
  metadata: Record<string, string>;
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
  const { inputs, results, metadata } = opts;
  const env = opts.env ?? process.env;

  // Prefer the job URL (set by the metadata resolver when the API call
  // succeeded); fall back to the workflow-run URL so the comment still
  // carries a link even when job-id resolution fails.
  const jobUrl = metadata["langfuse.github_job_url"];
  const runUrl = jobUrl ?? buildWorkflowRunUrl(env) ?? undefined;

  // Section discriminator: an explicit `comment_key` wins; otherwise fall
  // back to the numeric job id (unique per matrix leg) so parallel legs get
  // distinct sections with no configuration. Neither → today's behavior
  // (keyed on the script path alone).
  // `inputs.commentKey` is already trimmed to a non-empty string or undefined.
  const commentKey = inputs.commentKey;
  const jobKey = commentKey ? undefined : jobKeyFromUrl(jobUrl);

  const sections = results.map((result) => ({
    scriptPath: result.scriptPath,
    commentKey,
    jobKey,
    markdown: renderScriptSection({
      result,
      runUrl,
      scriptUrl: buildScriptBlobUrl(result.scriptPath, env) ?? undefined,
      commentKey,
      jobKey,
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
