import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { postPrComment } from "@/comment";

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

function sectionMarkdown(scriptPath: string, jobKey: string, label: string): string {
  const script = encodeURIComponent(scriptPath);
  const job = encodeURIComponent(jobKey);
  return [
    `<!-- langfuse-experiment-action:start script=${script} job=${job} -->`,
    `body ${label}`,
    `<!-- langfuse-experiment-action:end script=${script} job=${job} -->`,
  ].join("\n");
}

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
    jitter: () => 0,
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
