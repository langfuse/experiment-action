import { sectionMarkers, type SectionKey } from "@/comment";

/**
 * Minimal comment section in the *current* marker format, built from the
 * production `sectionMarkers` so fixtures can never drift from the real
 * format. The start marker carries no attributes, matching what
 * `renderSectionStartMarker` emits for attr-less sections.
 */
export function makeSection(key: SectionKey, content: string): string {
  const { start, end } = sectionMarkers(key);
  return [`${start}-->`, content, end].join("\n");
}

/**
 * Section as written by released pre-job-key action versions (no `/2`, no
 * `job=`). Hardcoded on purpose: this format is frozen — it must keep
 * matching what old versions actually wrote, not what the code does today.
 */
export function makeLegacySection(scriptPath: string, content: string): string {
  const script = encodeURIComponent(scriptPath);
  return [
    `<!-- langfuse-experiment-action:start script=${script} -->`,
    content,
    `<!-- langfuse-experiment-action:end script=${script} -->`,
  ].join("\n");
}
