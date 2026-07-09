import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveJobInfo } from "@/github/job-info";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "o", repo: "r" } },
}));

const paginate = vi.fn();

vi.mock("@/github/octokit", () => ({
  makeOctokit: () => ({
    paginate,
    rest: { actions: { listJobsForWorkflowRunAttempt: "listJobsForWorkflowRunAttempt" } },
  }),
}));

interface FakeJob {
  name: string;
  runner_name: string | null;
  status: string;
  html_url: string | null;
}

function job(name: string, runnerName: string | null, status = "in_progress"): FakeJob {
  return {
    name,
    runner_name: runnerName,
    status,
    html_url: `https://github.com/o/r/actions/runs/9/job/${name}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveJobInfo", () => {
  it("resolves the current matrix leg by runner name, beyond the first API page", async () => {
    // More jobs than one 30-item API page — pagination must surface ours.
    const jobs = Array.from({ length: 59 }, (_, i) => job(`e2e (leg-${i})`, `runner-${i}`));
    jobs.push(job("e2e (leg-59)", "our-runner"));
    paginate.mockResolvedValue(jobs);

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "our-runner",
    });

    expect(info).toEqual({
      htmlUrl: "https://github.com/o/r/actions/runs/9/job/e2e (leg-59)",
      name: "e2e (leg-59)",
    });
    expect(paginate).toHaveBeenCalledWith(
      "listJobsForWorkflowRunAttempt",
      expect.objectContaining({ per_page: 100, run_id: 9, attempt_number: 1 }),
    );
  });

  it("prefers the in-progress job when a runner name appears on finished jobs too", async () => {
    paginate.mockResolvedValue([
      { ...job("old", "our-runner", "completed") },
      { ...job("current", "our-runner", "in_progress") },
    ]);

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "our-runner",
    });

    expect(info?.name).toBe("current");
  });

  it("uses a sole runner-name match even when its status isn't in_progress yet", async () => {
    // Listing lag right after job start can report us as queued — a single
    // match is still unambiguous.
    paginate.mockResolvedValue([job("other", "r1"), job("ours", "our-runner", "queued")]);

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "our-runner",
    });

    expect(info?.name).toBe("ours");
  });

  it("returns null instead of guessing when several same-runner jobs are in progress", async () => {
    // Two self-hosted runners registered under the same name, both busy: a
    // wrong guess could hand two matrix legs the same section key.
    paginate.mockResolvedValue([
      job("leg-a", "shared-runner", "in_progress"),
      job("leg-b", "shared-runner", "in_progress"),
    ]);

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "shared-runner",
    });

    expect(info).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Could not disambiguate"));
  });

  it("returns null instead of a completed job when no same-runner candidate is running", async () => {
    paginate.mockResolvedValue([
      job("old-a", "shared-runner", "completed"),
      job("old-b", "shared-runner", "completed"),
    ]);

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "shared-runner",
    });

    expect(info).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Could not disambiguate"));
  });

  it("falls back to a single in-progress job when the runner name is unavailable", async () => {
    paginate.mockResolvedValue([job("done", "r1", "completed"), job("running", null)]);

    const info = await resolveJobInfo({ token: "tok", runId: "9", runAttempt: "1" });

    expect(info?.name).toBe("running");
  });

  it("returns null with a warning when the current job is ambiguous", async () => {
    paginate.mockResolvedValue([job("a", "r1"), job("b", "r2")]);

    const info = await resolveJobInfo({ token: "tok", runId: "9", runAttempt: "1" });

    expect(info).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not identify the current job"),
    );
  });

  it("returns null with an `actions: read` hint on 403", async () => {
    paginate.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );

    const info = await resolveJobInfo({
      token: "tok",
      runId: "9",
      runAttempt: "1",
      runnerName: "our-runner",
    });

    expect(info).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("actions: read"));
  });

  it("skips the lookup entirely without a token or run id", async () => {
    expect(await resolveJobInfo({ token: "", runId: "9", runAttempt: "1" })).toBeNull();
    expect(await resolveJobInfo({ token: "tok", runId: "", runAttempt: "1" })).toBeNull();
    expect(paginate).not.toHaveBeenCalled();
  });
});
