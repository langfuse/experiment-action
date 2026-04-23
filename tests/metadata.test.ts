import { describe, expect, it } from "vitest";

import { buildScriptBlobUrl, buildWorkflowRunUrl, resolveDefaultMetadata } from "@/metadata";

describe("resolveDefaultMetadata", () => {
  it("derives entries from GITHUB_* env vars and prefixes them with `langfuse.`", async () => {
    const metadata = await resolveDefaultMetadata({
      env: {
        GITHUB_REPOSITORY: "langfuse/experiment-action",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "abc123",
        GITHUB_REF_NAME: "feat/xyz",
        GITHUB_ACTOR: "alice",
        GITHUB_TRIGGERING_ACTOR: "alice",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/17/merge",
        GITHUB_WORKFLOW: "CI",
        GITHUB_JOB: "e2e-mixed-directory",
      },
    });

    expect(metadata).toEqual({
      "langfuse.git_sha": "abc123",
      "langfuse.branch": "feat/xyz",
      "langfuse.actor": "alice",
      "langfuse.event": "pull_request",
      "langfuse.github_workflow_name": "CI",
      "langfuse.github_job_name": "e2e-mixed-directory",
      "langfuse.github_job_attempt": "1",
      "langfuse.pr_url": "https://github.com/langfuse/experiment-action/pull/17",
    });
  });

  it("falls back from GITHUB_TRIGGERING_ACTOR to GITHUB_ACTOR when the former is unset", async () => {
    const metadata = await resolveDefaultMetadata({ env: { GITHUB_ACTOR: "alice" } });
    expect(metadata["langfuse.actor"]).toBe("alice");
  });

  it("prefers GITHUB_TRIGGERING_ACTOR when both are set (i.e. re-runs)", async () => {
    const metadata = await resolveDefaultMetadata({
      env: { GITHUB_ACTOR: "alice", GITHUB_TRIGGERING_ACTOR: "bob" },
    });
    expect(metadata["langfuse.actor"]).toBe("bob");
  });

  it("omits fields that are not set", async () => {
    expect(await resolveDefaultMetadata({ env: {} })).toEqual({});
  });

  it("omits pr_url when not a PR event", async () => {
    const metadata = await resolveDefaultMetadata({
      env: {
        GITHUB_REPOSITORY: "a/b",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "xyz",
      },
    });
    expect(metadata["langfuse.pr_url"]).toBeUndefined();
    expect(metadata["langfuse.git_sha"]).toBe("xyz");
  });

  it("does not emit the old key names we renamed/dropped", async () => {
    const metadata = await resolveDefaultMetadata({
      env: {
        GITHUB_REPOSITORY: "a/b",
        GITHUB_RUN_ID: "1",
        GITHUB_ACTOR: "alice",
        GITHUB_TRIGGERING_ACTOR: "alice",
        GITHUB_WORKFLOW: "CI",
        GITHUB_JOB: "test",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF: "a/b/.github/workflows/ci.yml@refs/heads/main",
        GITHUB_WORKFLOW_SHA: "deadbeef",
      },
    });
    expect(metadata["langfuse.triggering_actor"]).toBeUndefined();
    expect(metadata["langfuse.workflow_name"]).toBeUndefined();
    expect(metadata["langfuse.job_name"]).toBeUndefined();
    expect(metadata["langfuse.run_attempt"]).toBeUndefined();
    expect(metadata["langfuse.job_url"]).toBeUndefined();
    expect(metadata["langfuse.workflow_run_url"]).toBeUndefined();
    expect(metadata["langfuse.workflow_url"]).toBeUndefined();
  });

  it("layers custom metadata on top of env-derived defaults (custom wins collisions)", async () => {
    const metadata = await resolveDefaultMetadata({
      env: { GITHUB_SHA: "aaa" },
      custom: { team: "platform", "langfuse.git_sha": "bbb" },
    });
    expect(metadata).toEqual({
      "langfuse.git_sha": "bbb",
      team: "platform",
    });
  });

  it("skips the github_job_url lookup when no token is provided", async () => {
    const metadata = await resolveDefaultMetadata({ env: { GITHUB_SHA: "aaa" } });
    expect(metadata["langfuse.github_job_url"]).toBeUndefined();
  });
});

describe("buildWorkflowRunUrl", () => {
  it("returns the run page URL when both repo and run id are available", () => {
    expect(
      buildWorkflowRunUrl({
        GITHUB_REPOSITORY: "langfuse/experiment-action",
        GITHUB_RUN_ID: "42",
        GITHUB_SERVER_URL: "https://github.com",
      }),
    ).toBe("https://github.com/langfuse/experiment-action/actions/runs/42");
  });

  it("returns null when either piece is missing", () => {
    expect(buildWorkflowRunUrl({ GITHUB_REPOSITORY: "a/b" })).toBeNull();
    expect(buildWorkflowRunUrl({ GITHUB_RUN_ID: "42" })).toBeNull();
    expect(buildWorkflowRunUrl({})).toBeNull();
  });
});

describe("buildScriptBlobUrl", () => {
  it("builds a blob URL for scripts under GITHUB_WORKSPACE", () => {
    expect(
      buildScriptBlobUrl(
        "/home/runner/work/experiment-action/experiment-action/tests/fixtures/e2e/experiment.py",
        {
          GITHUB_REPOSITORY: "langfuse/experiment-action",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_SHA: "abc123def456",
          GITHUB_WORKSPACE: "/home/runner/work/experiment-action/experiment-action",
        },
      ),
    ).toBe(
      "https://github.com/langfuse/experiment-action/blob/abc123def456/tests/fixtures/e2e/experiment.py",
    );
  });

  it("returns null when the script path is outside the workspace", () => {
    expect(
      buildScriptBlobUrl("/tmp/experiment.py", {
        GITHUB_REPOSITORY: "langfuse/experiment-action",
        GITHUB_SHA: "abc123",
        GITHUB_WORKSPACE: "/home/runner/work/experiment-action/experiment-action",
      }),
    ).toBeNull();
  });
});
