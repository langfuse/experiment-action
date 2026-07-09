import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { postPrComment, publishExperimentComment } from "@/comment";
import type { ResolvedInputs } from "@/types";

import { makeSection } from "./helpers/comment-sections";
import { scriptResultFromRaw } from "./helpers/script-results";

/**
 * Concurrency tests for the convergent comment upsert. The fake octokit is
 * backed by an in-memory comment store; race interleavings are simulated by
 * one-shot mock implementations that mutate the store the way a concurrent
 * matrix leg would.
 */

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "o", repo: "r" },
    payload: { pull_request: { number: 7 } },
  },
}));

interface StoredComment {
  id: number;
  body: string;
}

let store: StoredComment[] = [];
let nextId = 1;

const paginate = vi.fn();
const createComment = vi.fn();
const updateComment = vi.fn();
const deleteComment = vi.fn();

vi.mock("@/github/octokit", () => ({
  makeOctokit: () => ({
    paginate,
    rest: { issues: { listComments: "listComments", createComment, updateComment, deleteComment } },
  }),
}));

const defaultCreate = async ({ body }: { body: string }) => {
  const comment = { id: nextId++, body };
  store.push(comment);
  return { data: comment };
};

const defaultUpdate = async ({ comment_id, body }: { comment_id: number; body: string }) => {
  const comment = store.find((c) => c.id === comment_id);
  if (!comment) throw Object.assign(new Error("Not Found"), { status: 404 });
  comment.body = body;
  return { data: comment };
};

const defaultDelete = async ({ comment_id }: { comment_id: number }) => {
  store = store.filter((c) => c.id !== comment_id);
  return {};
};

beforeEach(() => {
  store = [];
  nextId = 1;
  vi.clearAllMocks();
  paginate.mockImplementation(async () => store.map((c) => ({ ...c })));
  createComment.mockImplementation(defaultCreate);
  updateComment.mockImplementation(defaultUpdate);
  deleteComment.mockImplementation(defaultDelete);
});

const RUN_ID = "42";
const MARKER = `<!-- langfuse-experiment-action run_id=${RUN_ID} -->`;

const sectionMarkdown = (scriptPath: string, jobKey: string, label: string): string =>
  makeSection({ scriptPath, jobKey }, `body ${label}`);

const alphaSection = {
  scriptPath: "/tmp/experiment.py",
  jobKey: "e2e (alpha)",
  markdown: sectionMarkdown("/tmp/experiment.py", "e2e (alpha)", "alpha"),
};
const betaBody = `${MARKER}\n\n${sectionMarkdown("/tmp/experiment.py", "e2e (beta)", "beta")}\n`;

async function post(): Promise<void> {
  await postPrComment({
    sections: [alphaSection],
    token: "tok",
    runId: RUN_ID,
    sleep: async () => {},
  });
}

describe("postPrComment convergence", () => {
  it("creates a fresh comment when none exists and verifies in one attempt", async () => {
    await post();

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain(MARKER);
    expect(store[0].body).toContain("body alpha");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("merges its section into an existing comment, preserving other legs' sections", async () => {
    store.push({ id: 1, body: betaBody });

    await post();

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).toContain("body beta");
  });

  it("deletes its duplicate and merges into the older comment after losing a creation race", async () => {
    // Between our (empty) list and our create, a concurrent leg creates the
    // run comment first — it ends up with the lower id.
    createComment.mockImplementationOnce(async ({ body }: { body: string }) => {
      store.push({ id: nextId++, body: betaBody });
      const ours = { id: nextId++, body };
      store.push(ours);
      return { data: ours };
    });

    await post();

    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }));
    expect(store).toHaveLength(1);
    expect(store[0].id).toBe(1);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).toContain("body beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("re-merges when a concurrent write clobbers its section", async () => {
    store.push({ id: 1, body: betaBody });
    // Our first update lands, but a concurrent leg that read the pre-update
    // body writes right after us — last-writer-wins drops our section.
    updateComment.mockImplementationOnce(async ({ comment_id }: { comment_id: number }) => {
      const comment = store.find((c) => c.id === comment_id);
      if (!comment) throw new Error("missing");
      comment.body = betaBody;
      return { data: comment };
    });

    await post();

    expect(updateComment).toHaveBeenCalledTimes(2);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).toContain("body beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("re-merges when a stale write reverts its section content but keeps the markers", async () => {
    // The canonical comment already carries an *older* version of our
    // section (same script + job key) — the re-run scenario.
    const staleAlpha = sectionMarkdown("/tmp/experiment.py", "e2e (alpha)", "alpha-stale");
    store.push({ id: 1, body: `${MARKER}\n\n${staleAlpha}\n` });
    // Our update lands, then a concurrent leg writes a body derived from a
    // pre-update read: our markers are present, but with the stale content.
    updateComment.mockImplementationOnce(async ({ comment_id }: { comment_id: number }) => {
      const comment = store.find((c) => c.id === comment_id);
      if (!comment) throw new Error("missing");
      comment.body = `${MARKER}\n\n${staleAlpha}\n`;
      return { data: comment };
    });

    await post();

    expect(updateComment).toHaveBeenCalledTimes(2);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).not.toContain("body alpha-stale");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("defers duplicate deletion until its sections are verified in the canonical comment", async () => {
    // Lost creation race AND the first merge into the canonical comment is
    // clobbered by a concurrent writer. Deleting the duplicate at that point
    // would destroy the only surviving copy of our section if this job died.
    createComment.mockImplementationOnce(async ({ body }: { body: string }) => {
      store.push({ id: nextId++, body: betaBody });
      const ours = { id: nextId++, body };
      store.push(ours);
      return { data: ours };
    });
    updateComment.mockImplementationOnce(async ({ comment_id }: { comment_id: number }) => {
      const comment = store.find((c) => c.id === comment_id);
      if (!comment) throw new Error("missing");
      comment.body = betaBody;
      return { data: comment };
    });

    await post();

    // Exactly one delete, and only after the second (successful) merge.
    expect(deleteComment).toHaveBeenCalledTimes(1);
    expect(deleteComment.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateComment.mock.invocationCallOrder[1],
    );
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).toContain("body beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("does not create a second comment when the listing lags behind its own create", async () => {
    // Both the initial list and the verify read miss our fresh comment.
    paginate.mockImplementationOnce(async () => []).mockImplementationOnce(async () => []);

    await post();

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain("body alpha");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("rides out a transient API error and retries on the next attempt", async () => {
    store.push({ id: 1, body: betaBody });
    updateComment.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Bad gateway"), { status: 502 });
    });

    await post();

    expect(updateComment).toHaveBeenCalledTimes(2);
    expect(store[0].body).toContain("body alpha");
    expect(store[0].body).toContain("body beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("retries a failed duplicate deletion instead of leaving an orphan comment", async () => {
    createComment.mockImplementationOnce(async ({ body }: { body: string }) => {
      store.push({ id: nextId++, body: betaBody });
      const ours = { id: nextId++, body };
      store.push(ours);
      return { data: ours };
    });
    deleteComment.mockImplementationOnce(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });

    await post();

    expect(deleteComment).toHaveBeenCalledTimes(2);
    expect(store).toHaveLength(1);
    expect(store[0].id).toBe(1);
    expect(store[0].body).toContain("body alpha");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("gives up with a warning after bounded attempts when writes keep getting clobbered", async () => {
    store.push({ id: 1, body: betaBody });
    updateComment.mockImplementation(async ({ comment_id }: { comment_id: number }) => {
      const comment = store.find((c) => c.id === comment_id);
      if (!comment) throw new Error("missing");
      comment.body = betaBody;
      return { data: comment };
    });

    await post();

    expect(updateComment).toHaveBeenCalledTimes(5);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("may be incomplete"));
  });

  it("keeps the permissions hint when the comment write is denied", async () => {
    createComment.mockImplementation(async () => {
      throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    });

    await post();

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("pull-requests: write"));
  });
});

describe("publishExperimentComment job labels", () => {
  const results = [
    scriptResultFromRaw({
      scriptPath: "/tmp/experiment.py",
      scriptName: "experiment.py",
      runtime: "python",
      result: { name: "Uppercase task", run_evaluations: [], item_results: [] },
      error: null,
      durationMs: 100,
    }),
  ];
  const inputs = { githubToken: "tok" } as ResolvedInputs;
  const baseEnv = { GITHUB_RUN_ID: RUN_ID, GITHUB_JOB: "e2e" };

  // `publishExperimentComment` uses the real (jittered) sleep — run it under
  // fake timers so these glue tests don't wait out the verify delay.
  async function publish(jobName: string | null): Promise<void> {
    vi.useFakeTimers();
    try {
      const promise = publishExperimentComment({
        inputs,
        results,
        jobInfo: jobName ? { htmlUrl: null, name: jobName } : null,
        env: baseEnv as NodeJS.ProcessEnv,
      });
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  }

  it("labels sections with the job name for matrix legs", async () => {
    await publish("e2e (alpha)");

    expect(store[0].body).toContain("✅ Uppercase task — e2e (alpha)</summary>");
    expect(store[0].body).toContain("job=e2e%20(alpha)");
  });

  it("keys on the display name but keeps today's rendering for renamed non-matrix jobs", async () => {
    await publish("Run nightly evals");

    // Renamed (non-matrix) job: section identity uses the display name, but
    // the summary stays unchanged so upgrades don't alter existing comments.
    expect(store[0].body).toContain("✅ Uppercase task</summary>");
    expect(store[0].body).not.toContain("— Run nightly evals");
    expect(store[0].body).toContain("job=Run%20nightly%20evals");
  });

  it("falls back to the YAML job key without job info", async () => {
    await publish(null);

    expect(store[0].body).toContain("✅ Uppercase task</summary>");
    expect(store[0].body).toContain("job=e2e ");
  });
});
