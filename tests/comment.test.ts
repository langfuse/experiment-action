import { describe, expect, it } from "vitest";

import {
  buildFreshCommentBody,
  renderCommentTitle,
  renderScriptSection,
  upsertSection,
} from "@/comment";
import { normalizeExperimentResult, resolveLangfuseExperimentUrl } from "@/experiment-result";
import type { ScriptResult } from "@/types";

import { scriptResultFromRaw } from "./helpers/script-results";

/**
 * Rendering tests compare the full comment markdown against files under
 * `tests/snapshots/`. Open any of those files in an editor / viewer to see
 * exactly what a PR comment looks like for that scenario.
 *
 * Regenerate after an intentional rendering change:
 *   pnpm vitest run tests/comment.test.ts -u
 */

const SNAPSHOT_DIR = "./snapshots";
const snap = (file: string) => `${SNAPSHOT_DIR}/${file}`;
const SNAPSHOT_RUN_ID = "12345";
const SNAPSHOT_TITLE = { shortSha: "abc1234", runAttempt: 1 } as const;

function renderFullCommentSnapshot(
  result: ScriptResult,
  opts: {
    runUrl?: string;
    scriptUrl?: string;
  } = {},
): string {
  const section = renderScriptSection({
    result,
    runUrl: opts.runUrl,
    scriptUrl: opts.scriptUrl,
  });
  return buildFreshCommentBody(SNAPSHOT_RUN_ID, SNAPSHOT_TITLE, [section]);
}

const pyPassingResult: ScriptResult = scriptResultFromRaw({
  scriptPath: "/tmp/experiment.py",
  scriptName: "experiment.py",
  runtime: "python",
  result: {
    name: "Uppercase task",
    experiment_id: "0f212f9182320769",
    run_evaluations: [{ name: "avg_accuracy", value: 1 }],
    item_results: [
      {
        item: { input: "hello", expected_output: "HELLO" },
        output: "HELLO",
        evaluations: [{ name: "exact_match", value: 1 }],
      },
      {
        item: { id: "dataset-item-42", input: "world", expected_output: "WORLD" },
        output: "WORLD",
        evaluations: [{ name: "exact_match", value: 1 }],
      },
    ],
  },
  error: null,
  durationMs: 4500,
});

const pyDatasetPassingResult: ScriptResult = scriptResultFromRaw({
  scriptPath: "/tmp/experiment.py",
  scriptName: "experiment.py",
  runtime: "python",
  result: {
    name: "Uppercase task",
    experiment_id: "0f212f9182320769",
    dataset_run_id: "run_123",
    run_evaluations: [{ name: "avg_accuracy", value: 1 }],
    item_results: [
      {
        item: {
          id: "a895fde1-36b2-43cd-8ab5-841541a81460",
          dataset_name: "test-dataset-versioning-950dc53a",
          input: "hello",
          expected_output: "HELLO",
        },
        output: "HELLO",
        evaluations: [{ name: "exact_match", value: 1 }],
      },
    ],
  },
  error: null,
  durationMs: 4500,
});

// NOTE: mirrors what the JS SDK actually returns — no top-level `name`
// field; just `runName` which is `"<name> - <ISO timestamp>"`. The
// renderer has to recover the user-provided name from that.
const tsPassingResult: ScriptResult = scriptResultFromRaw({
  scriptPath: "/tmp/mixed/exp_node.ts",
  scriptName: "exp_node.ts",
  runtime: "node",
  result: {
    experimentId: "663423cc937e2227",
    runName: "Mixed dir (node) - 2026-04-20T13:31:24.904Z",
    runEvaluations: [{ name: "avg_accuracy", value: 0.83 }],
    itemResults: [
      {
        item: { input: "node", expectedOutput: "NODE" },
        output: "NODE",
        evaluations: [{ name: "exact_match", value: 1 }],
      },
    ],
  },
  error: null,
  durationMs: 1200,
});

const regressionWithResult: ScriptResult = scriptResultFromRaw({
  scriptPath: "/tmp/reg.py",
  scriptName: "reg.py",
  runtime: "python",
  result: {
    name: "Regression fixture",
    run_evaluations: [{ name: "avg_accuracy", value: 0.5 }],
    item_results: [
      {
        item: { input: "x", expected_output: "X" },
        output: "X",
        evaluations: [{ name: "exact_match", value: 1 }],
      },
    ],
  },
  error: {
    name: "RegressionError",
    message: "accuracy dropped to 0.5",
    isRegression: true,
  },
  durationMs: 3400,
});

const unrelatedError: ScriptResult = scriptResultFromRaw({
  scriptPath: "/tmp/broken.py",
  scriptName: "broken.py",
  runtime: "python",
  result: null,
  error: {
    name: "ValueError",
    message: "bad input on line 17",
    isRegression: false,
  },
  durationMs: 500,
});

describe("renderScriptSection snapshots", () => {
  it("passing experiment (includes Langfuse link for dataset-backed runs)", async () => {
    const body = renderFullCommentSnapshot(
      {
        ...pyDatasetPassingResult,
        langfuseExperimentUrl: resolveLangfuseExperimentUrl({
          result: pyDatasetPassingResult.normalizedResult,
          baseUrl: "http://localhost:3000",
          projectId: "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a",
        }),
      },
      {
        runUrl: "https://github.com/owner/repo/actions/runs/7/job/42",
        scriptUrl: "https://github.com/owner/repo/blob/abc1234/tmp/experiment.py",
      },
    );
    expect(body).toContain(
      "[View in Langfuse](http://localhost:3000/project/7a88fb47-b4e2-43b8-a06c-a5ce950dc53a" +
        "/experiments/results?baseline=0f212f9182320769)",
    );
    expect(body).toContain("| Experiment | Status | Actions |");
    await expect(body).toMatchFileSnapshot(snap("passing.md"));
  });

  it("omits the Langfuse link and labels local dataset usage for local-data runs", () => {
    const body = renderFullCommentSnapshot(pyPassingResult, {
      runUrl: "https://github.com/owner/repo/actions/runs/7/job/42",
      scriptUrl: "https://github.com/owner/repo/blob/abc1234/tmp/experiment.py",
    });
    expect(body).not.toContain("[View in Langfuse](");
    expect(body).toContain("Local dataset");
  });

  it("regression with a captured result (scores + items still rendered)", async () => {
    const body = renderFullCommentSnapshot(regressionWithResult, {
      runUrl: "https://github.com/o/r/actions/runs/7/job/42",
      scriptUrl: "https://github.com/o/r/blob/abc1234/tmp/reg.py",
    });
    await expect(body).toMatchFileSnapshot(snap("regression.md"));
  });

  it("unrelated error: minimal CAUTION alert, no tables", async () => {
    const body = renderFullCommentSnapshot(unrelatedError, {
      runUrl: "https://github.com/o/r/actions/runs/7/job/42",
      scriptUrl: "https://github.com/o/r/blob/abc1234/tmp/broken.py",
    });
    await expect(body).toMatchFileSnapshot(snap("unrelated-error.md"));
  });

  it("falls back to the script filename in the summary when no SDK name", async () => {
    const section = renderScriptSection({
      result: { ...unrelatedError, normalizedResult: null },
    });
    expect(section).toMatch(/^<!-- langfuse-experiment-action:start script=/);
    // No SDK name → summary uses the script filename as the display name.
    expect(section).toContain("<details open><summary>❌ broken.py</summary>");
  });

  it("shows only the display name in the summary by default", () => {
    const section = renderScriptSection({ result: pyPassingResult });
    expect(section).toContain("<details><summary>✅ Uppercase task</summary>");
  });

  it("links the source in the summary when a blob URL is provided", () => {
    const section = renderScriptSection({
      result: pyPassingResult,
      scriptUrl: "https://github.com/owner/repo/blob/abc1234/tmp/experiment.py",
    });
    expect(section).toContain(
      '<details><summary>✅ Uppercase task (<a href="https://github.com/owner/repo/blob/abc1234/tmp/experiment.py">Source</a>)</summary>',
    );
  });

  it("recovers the user-provided name from `runName` when the SDK only exposes that (JS SDK)", () => {
    const section = renderScriptSection({ result: tsPassingResult });
    // Timestamp suffix stripped → user's original `name` back in the summary.
    expect(section).toContain("✅ Mixed dir (node)</summary>");
    expect(section).not.toContain("2026-04-20T");
  });

  it("caps the per-item table and adds a truncation note when there are many items", () => {
    // 60 synthetic items → over the 50-row cap.
    const manyItems = Array.from({ length: 60 }, (_, i) => ({
      item: { input: `input-${i}`, expected_output: `expected-${i}` },
      output: `expected-${i}`,
      evaluations: [{ name: "exact_match", value: 1 }],
    }));
    const section = renderScriptSection({
      result: {
        ...pyPassingResult,
        normalizedResult: normalizeExperimentResult({
          name: "Uppercase task",
          experiment_id: "0f212f9182320769",
          run_evaluations: [{ name: "avg_accuracy", value: 1 }],
          item_results: manyItems,
        }),
      },
    });

    // Summary reflects the *full* count.
    expect(section).toContain("<details><summary>Item results (60)</summary>");
    // Only the first 50 data rows land in the table.
    expect(section).toContain("| 1 | input-0 | expected-0 | expected-0 | 1.000 |");
    expect(section).toContain("| 50 | input-49 | expected-49 | expected-49 | 1.000 |");
    expect(section).not.toContain("| 51 | input-50 |");
    // Truncation note tells the reader where to get the rest.
    expect(section).toContain("_Showing first 50 of 60._");
  });
});

describe("renderCommentTitle", () => {
  it("includes the short SHA when provided, omits attempt on first run", () => {
    expect(renderCommentTitle({ shortSha: "abc1234", runAttempt: 1 })).toBe(
      '### <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234`',
    );
  });

  it("appends (#N) when the attempt is > 1", () => {
    expect(renderCommentTitle({ shortSha: "abc1234", runAttempt: 3 })).toBe(
      '### <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234` (#3)',
    );
  });

  it("drops the suffix entirely when neither SHA nor attempt > 1 is available", () => {
    expect(renderCommentTitle({})).toBe(
      '### <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results',
    );
  });
});

describe("buildFreshCommentBody snapshot", () => {
  it("wraps one rendered section in the top-level title + run marker", async () => {
    const section = renderScriptSection({ result: pyPassingResult });
    const body = buildFreshCommentBody("12345", { shortSha: "abc1234", runAttempt: 1 }, [section]);
    await expect(body).toMatchFileSnapshot(snap("fresh-comment-body.md"));
  });

  it("includes multiple sections in order", async () => {
    const s1 = renderScriptSection({ result: pyPassingResult });
    const s2 = renderScriptSection({ result: tsPassingResult });
    const body = buildFreshCommentBody("12345", { shortSha: "abc1234", runAttempt: 2 }, [s1, s2]);
    await expect(body).toMatchFileSnapshot(snap("fresh-comment-multi.md"));
  });
});

describe("upsertSection", () => {
  const mkSection = (scriptPath: string, label: string) =>
    [
      `<!-- langfuse-experiment-action:start script=${encodeURIComponent(scriptPath)} -->`,
      `section body for ${label}`,
      `<!-- langfuse-experiment-action:end script=${encodeURIComponent(scriptPath)} -->`,
    ].join("\n");

  it("appends when no prior section exists for that script path", () => {
    const existing = `<!-- langfuse-experiment-action run_id=1 -->\n\n${mkSection("/tmp/a.py", "v1")}\n`;
    const updated = upsertSection(existing, "/tmp/b.py", mkSection("/tmp/b.py", "v1"));
    expect(updated).toContain(encodeURIComponent("/tmp/a.py"));
    expect(updated).toContain(encodeURIComponent("/tmp/b.py"));
    expect(updated.indexOf(encodeURIComponent("/tmp/a.py"))).toBeLessThan(
      updated.indexOf(encodeURIComponent("/tmp/b.py")),
    );
  });

  it("replaces an existing section in place when the script path matches", () => {
    const existing = [
      "<!-- langfuse-experiment-action run_id=1 -->",
      "",
      mkSection("/tmp/a.py", "old"),
      "",
      mkSection("/tmp/b.py", "keep"),
    ].join("\n");
    const updated = upsertSection(existing, "/tmp/a.py", mkSection("/tmp/a.py", "new"));
    expect(updated).toContain("section body for new");
    expect(updated).not.toContain("section body for old");
    expect(updated).toContain("section body for keep");
    // Still exactly one start marker per script key.
    const aEncoded = encodeURIComponent("/tmp/a.py");
    const bEncoded = encodeURIComponent("/tmp/b.py");
    expect(updated.match(new RegExp(`:start script=${aEncoded}`, "g"))).toHaveLength(1);
    expect(updated.match(new RegExp(`:start script=${bEncoded}`, "g"))).toHaveLength(1);
  });
});
