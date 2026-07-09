// The pure text layer of the PR comment: markers, section parsing/merging,
// and markdown rendering. Everything here is a function from strings to
// strings — the GitHub API orchestration lives in `./post`.

import * as path from "node:path";

import {
  experimentDisplayName,
  type NormalizedExperimentItemResult,
  type NormalizedExperimentResult,
} from "@/experiment-result";
import { buildDatasetItemUrl } from "@/langfuse/project";

import type { ScriptError, ScriptResult } from "../types";

/**
 * Identity of one comment section. Sections are keyed on the script *path*
 * (two scripts with colliding SDK experiment names still get separate
 * sections) *and* the job key (parallel matrix legs running the same script
 * don't overwrite each other).
 */
export interface SectionKey {
  /** Script path relative to the repo root. */
  scriptPath: string;
  /** Job display name (or `$GITHUB_JOB` fallback) separating parallel legs. */
  jobKey: string;
}

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
   * matrix legs, where the experiment name alone can't tell sections apart.
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
export function runMarker(runId: string): string {
  return `<!-- langfuse-experiment-action run_id=${encodeURIComponent(runId)} -->`;
}

/**
 * Delimiters wrapping one invocation's section inside the run comment,
 * keyed on the full `SectionKey` — the job display name is the only
 * per-leg identity GitHub gives us for matrix jobs.
 *
 * The trailing space on `start` is load-bearing: markers are matched by
 * `indexOf` prefix, and the space terminates the job key so `job=a` can
 * never match `job=ab` (`encodeURIComponent` never emits a space).
 *
 * The `/2` versions the format. Released (pre-job-key) action versions
 * match sections by the literal prefix `…:start script=<encoded>` and pair
 * it with the first legacy end marker for the same script — without `/2`,
 * an old-version job re-running in a mixed-version run could anchor on a
 * new section's start marker and splice out everything up to a legacy end
 * marker, deleting other jobs' sections. `/2` makes new markers invisible
 * to the old matcher, so old jobs append alongside instead.
 */
export function sectionMarkers(key: SectionKey): { start: string; end: string } {
  const script = encodeURIComponent(key.scriptPath);
  const job = encodeURIComponent(key.jobKey);
  return {
    start: `<!-- langfuse-experiment-action:start/2 script=${script} job=${job} `,
    end: `<!-- langfuse-experiment-action:end/2 script=${script} job=${job} -->`,
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
  key: SectionKey,
  opts: { runUrl?: string; langfuseUrl?: string; localDataset?: boolean } = {},
): string {
  const { start } = sectionMarkers(key);
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
      // the job name is what tells them apart. Decided per row: fall back to
      // the script label only when another collider shares *this* row's job
      // key (distinct scripts, same job), so one ambiguous row doesn't strip
      // the job key from every other row in the group.
      const jobKeyShared = group.some(
        (other) => other !== meta && (other.jobKey ?? "") === (meta.jobKey ?? ""),
      );
      const disambiguator = meta.jobKey && !jobKeyShared ? meta.jobKey : meta.scriptLabel;
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
  // The `/2` and `job=` are optional so sections written by pre-job-key
  // action versions (possible when one run mixes action versions across
  // jobs) still parse.
  const regex =
    /<!-- langfuse-experiment-action:start(\/2)? script=([^ >]+)(?: job=([^ >]*))?([^>]*)-->/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    const version = match[1] ?? "";
    const encodedScriptPath = match[2];
    if (!encodedScriptPath) continue;

    const scriptPath = decodeURIComponent(encodedScriptPath);
    const encodedJobKey = match[3];
    // Reconstruct the end marker in the same format the section was written
    // in — from the *encoded* captures, so we match byte-for-byte.
    const end =
      encodedJobKey === undefined
        ? `<!-- langfuse-experiment-action:end${version} script=${encodedScriptPath} -->`
        : `<!-- langfuse-experiment-action:end${version} script=${encodedScriptPath} job=${encodedJobKey} -->`;
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
    const startAttrs = parseActionAttributes(match[4]?.trim());
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

export function refreshOverview(body: string): string {
  const { start: overviewStart, end: overviewEnd } = overviewMarkers();
  const { start: detailsStart, end: detailsEnd } = detailsMarkers();
  const withoutOverview = replaceMarkedBlock(body, overviewStart, overviewEnd, "");
  const withoutLayout = replaceMarkedBlock(withoutOverview, detailsStart, detailsEnd, "");
  const metas = parseSectionOverview(withoutLayout);
  if (metas.length === 0) return withoutLayout;

  // Matches both current (`/2`) and legacy section starts so the overview
  // lands above the first section regardless of which action version wrote it.
  const firstSectionIdx = withoutLayout.search(
    /<!-- langfuse-experiment-action:start(?:\/2)? script=/,
  );
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

/**
 * Job display names come from workflow YAML — including dynamically built
 * matrices (`fromJSON(...)` over changed files, external config) — so they
 * can contain arbitrary text. Unescaped, a crafted name could break out of
 * the `<summary>` element or forge a `<!-- langfuse-experiment-action`
 * marker inside the body (escaping `<` neutralizes both).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const key: SectionKey = { scriptPath: scriptResult.scriptPath, jobKey };
  const { end } = sectionMarkers(key);
  const normalized = scriptResult.normalizedResult;
  const langfuseUrl = scriptResult.langfuseExperimentUrl ?? undefined;
  const localDataset = Boolean(normalized && !normalized.datasetRunId);
  const failed = scriptResult.error !== null;
  const displayName =
    (normalized ? experimentDisplayName(normalized) : undefined) ?? scriptResult.scriptName;
  const { icon } = statusSummary(scriptResult.error);
  const summary = renderSectionSummary({
    icon,
    displayName: jobLabel ? `${displayName} — ${escapeHtml(jobLabel)}` : displayName,
  });
  const lines: string[] = [
    renderSectionStartMarker(key, {
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
 * Replace an existing section with the same `SectionKey` in place, or
 * append it to the end of the body if none exists.
 */
export function upsertSection(existingBody: string, key: SectionKey, section: string): string {
  const { start, end } = sectionMarkers(key);
  const updated = replaceMarkedBlock(existingBody, start, end, section);
  if (updated !== existingBody) return updated;
  return `${existingBody.replace(/\s+$/, "")}\n\n${section}\n`;
}
