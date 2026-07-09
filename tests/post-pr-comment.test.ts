import { beforeEach, describe, expect, it, vi } from "vitest";

const { core, ghContext, octokitRef } = vi.hoisted(() => ({
  core: { info: vi.fn(), warning: vi.fn(), debug: vi.fn() },
  ghContext: {
    repo: { owner: "o", repo: "r" },
    payload: { pull_request: { number: 7 } as { number: number } | undefined },
  },
  // Mutable holder so each test installs its own fake Octokit before importing.
  octokitRef: { current: null as unknown },
}));

vi.mock("@actions/core", () => core);
vi.mock("@actions/github", () => ({ context: ghContext }));
vi.mock("@/github/octokit", () => ({ makeOctokit: () => octokitRef.current }));

import { postPrComment, renderScriptSection, type SectionInput } from "@/comment";

import { scriptResultFromRaw } from "./helpers/script-results";

const RUN_ID = "run-42";
const RUN_MARKER = `<!-- langfuse-experiment-action run_id=${RUN_ID} -->`;

const result = scriptResultFromRaw({
  scriptPath: "/tmp/exp.py",
  scriptName: "exp.py",
  runtime: "python",
  result: {
    name: "Prompt eval",
    run_evaluations: [{ name: "accuracy", value: 1 }],
    item_results: [],
  },
  error: null,
  durationMs: 1,
});

/** A section input whose markdown carries the correct start/end markers. */
function section(commentKey?: string, jobKey?: string): SectionInput {
  return {
    scriptPath: result.scriptPath,
    commentKey,
    jobKey,
    markdown: renderScriptSection({ result, commentKey, jobKey }),
  };
}

/**
 * An in-memory GitHub issue-comments backend. `paginate` returns snapshots;
 * `updateComment`/`createComment`/`deleteComment` mutate the store. Hooks let
 * a test simulate a concurrent writer clobbering the comment.
 */
function fakeGitHub(initial: Array<{ id: number; body: string }> = []) {
  const comments = initial.map((c) => ({ ...c }));
  let nextId = 5000;
  let afterUpdate: ((c: { id: number; body: string }) => void) | undefined;

  const octokit = {
    paginate: vi.fn(async () => comments.map((c) => ({ ...c }))),
    rest: {
      issues: {
        listComments: {},
        updateComment: vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
          const c = comments.find((x) => x.id === comment_id);
          if (c) c.body = body;
          if (c) afterUpdate?.(c);
          return { data: c };
        }),
        createComment: vi.fn(async ({ body }: { body: string }) => {
          const c = { id: nextId++, body };
          comments.push(c);
          return { data: c };
        }),
        deleteComment: vi.fn(async ({ comment_id }: { comment_id: number }) => {
          const i = comments.findIndex((x) => x.id === comment_id);
          if (i >= 0) comments.splice(i, 1);
          return {};
        }),
      },
    },
  };

  return {
    comments,
    octokit,
    /** Register a one-shot mutation applied right after the next updateComment. */
    onNextUpdate(fn: (c: { id: number; body: string }) => void) {
      afterUpdate = (c) => {
        afterUpdate = undefined;
        fn(c);
      };
    },
  };
}

const base = { token: "t", runId: RUN_ID, sleep: async () => {} };

beforeEach(() => {
  ghContext.payload.pull_request = { number: 7 };
});

describe("postPrComment", () => {
  it("creates a fresh comment when none exists for the run", async () => {
    const gh = fakeGitHub();
    octokitRef.current = gh.octokit;

    await postPrComment({ ...base, sections: [section("A")] });

    expect(gh.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain(RUN_MARKER);
    expect(gh.comments[0].body).toContain("key=A");
  });

  it("updates the existing run comment in place, preserving a sibling leg's section", async () => {
    const gh = fakeGitHub([
      { id: 1, body: `${RUN_MARKER}\n\n${renderScriptSection({ result, commentKey: "A" })}` },
    ]);
    octokitRef.current = gh.octokit;

    await postPrComment({ ...base, sections: [section("B")] });

    expect(gh.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(gh.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain("key=A");
    expect(gh.comments[0].body).toContain("key=B");
  });

  it("keeps same-script legs in separate sections across sequential invocations", async () => {
    const gh = fakeGitHub();
    octokitRef.current = gh.octokit;

    await postPrComment({ ...base, sections: [section("A")] });
    await postPrComment({ ...base, sections: [section("B")] });

    expect(gh.comments).toHaveLength(1);
    const body = gh.comments[0].body;
    expect(body.match(/:start script=%2Ftmp%2Fexp\.py key=A/g)).toHaveLength(1);
    expect(body.match(/:start script=%2Ftmp%2Fexp\.py key=B/g)).toHaveLength(1);
  });

  it("retries when a concurrent writer clobbers our section, then succeeds", async () => {
    const gh = fakeGitHub([{ id: 1, body: RUN_MARKER }]);
    octokitRef.current = gh.octokit;

    // Simulate another matrix leg overwriting the comment right after our
    // first update, dropping our section — the verify step must catch it.
    gh.onNextUpdate((c) => {
      c.body = `${RUN_MARKER}\n\n${renderScriptSection({ result, commentKey: "other" })}`;
    });

    const sleep = vi.fn(async () => {});
    await postPrComment({ ...base, sleep, sections: [section("A")] });

    expect(gh.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Final state has both the concurrent leg's section and ours.
    expect(gh.comments[0].body).toContain("key=other");
    expect(gh.comments[0].body).toContain("key=A");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("reconciles a create-create duplicate: folds the stray section in and deletes the extra", async () => {
    // Two comments carry the run marker — a create race left a duplicate (id 2)
    // holding another leg's section that isn't in the canonical comment (id 1).
    const gh = fakeGitHub([
      { id: 1, body: `${RUN_MARKER}\n\n${renderScriptSection({ result, commentKey: "A" })}` },
      { id: 2, body: `${RUN_MARKER}\n\n${renderScriptSection({ result, commentKey: "B" })}` },
    ]);
    octokitRef.current = gh.octokit;

    await postPrComment({ ...base, sections: [section("C")] });

    // Duplicate deleted; a single canonical comment carries all three sections.
    expect(gh.octokit.rest.issues.deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 2 }),
    );
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].id).toBe(1);
    for (const key of ["key=A", "key=B", "key=C"]) {
      expect(gh.comments[0].body).toContain(key);
    }
  });

  it("keeps the pre-comment_key marker format when no discriminator is provided", async () => {
    const gh = fakeGitHub();
    octokitRef.current = gh.octokit;

    await postPrComment({
      ...base,
      sections: [{ scriptPath: result.scriptPath, markdown: renderScriptSection({ result }) }],
    });

    const body = gh.comments[0].body;
    expect(body).toContain(":start script=%2Ftmp%2Fexp.py");
    expect(body).not.toContain(" key=");
    expect(body).not.toContain(" job=");
  });

  it("skips entirely when the event is not a pull request", async () => {
    const gh = fakeGitHub();
    octokitRef.current = gh.octokit;
    ghContext.payload.pull_request = undefined;

    await postPrComment({ ...base, sections: [section("A")] });

    expect(gh.octokit.paginate).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith("Skipping PR comment: not a pull_request event.");
  });

  it("warns and gives up after exhausting attempts under sustained contention", async () => {
    const gh = fakeGitHub([{ id: 1, body: RUN_MARKER }]);
    octokitRef.current = gh.octokit;

    // Every update is immediately clobbered → our section never survives verify.
    gh.octokit.rest.issues.updateComment.mockImplementation(async ({ comment_id }) => {
      const c = gh.comments.find((x) => x.id === comment_id);
      if (c) c.body = RUN_MARKER; // strip everything we just wrote
      return { data: c };
    });

    await postPrComment({ ...base, sections: [section("A")], maxAttempts: 3 });

    expect(gh.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(3);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("still contended after 3 attempts"),
    );
  });
});
