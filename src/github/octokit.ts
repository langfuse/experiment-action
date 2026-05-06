import * as core from "@actions/core";
import * as github from "@actions/github";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

/**
 * Build an Octokit client with sensible defaults for a GitHub Action:
 *
 * - `@octokit/plugin-retry` automatically retries transient network/5xx
 *   failures.
 * - `@octokit/plugin-throttling` honours primary + secondary rate limits,
 *   respects GitHub's `retry-after` hint, and logs exactly which endpoint
 *   tripped the limit.
 *
 * Neither plugin ships in `@actions/github`'s default client — that's the
 * whole reason this wrapper exists. Everything else in the action should
 * reach for `makeOctokit()` rather than calling `github.getOctokit()`
 * directly so the same policy applies everywhere.
 */
export function makeOctokit(token: string): ReturnType<typeof github.getOctokit> {
  return github.getOctokit(
    token,
    {
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: { method: string; url: string },
          _octokit: unknown,
          retryCount: number,
        ) => {
          core.warning(
            `Primary rate limit hit on ${options.method} ${options.url}; ` +
              `waiting ${retryAfter}s before retry ${retryCount + 1}/3.`,
          );
          return retryCount < 3;
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: { method: string; url: string },
          _octokit: unknown,
          retryCount: number,
        ) => {
          core.warning(
            `Secondary rate limit hit on ${options.method} ${options.url}; ` +
              `waiting ${retryAfter}s before retry ${retryCount + 1}/3.`,
          );
          return retryCount < 3;
        },
      },
    },
    retry,
    throttling,
  );
}

/** Convenience alias for the concrete Octokit instance type. */
export type Octokit = ReturnType<typeof makeOctokit>;
