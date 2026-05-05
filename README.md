![GitHub Banner](https://github.com/langfuse/langfuse-js/assets/2834609/d1613347-445f-4e91-9e84-428fda9c3659)

# langfuse/experiment-action

[![MIT License](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![CI test status](https://img.shields.io/github/actions/workflow/status/langfuse/experiment-action/ci.yml?style=flat-square&label=All%20tests)](https://github.com/langfuse/experiment-action/actions/workflows/ci.yml?query=branch%3Amain)
[![GitHub Repo stars](https://img.shields.io/github/stars/langfuse/langfuse?style=flat-square&logo=GitHub&label=langfuse%2Flangfuse)](https://github.com/langfuse/langfuse)
[![Discord](https://img.shields.io/discord/1111061815649124414?style=flat-square&logo=Discord&logoColor=white&label=Discord&color=%23434EE4)](https://discord.gg/7NXusRtqYU)
[![YC W23](https://img.shields.io/badge/Y%20Combinator-W23-orange?style=flat-square)](https://www.ycombinator.com/companies/langfuse)

Run a [Langfuse](https://langfuse.com) experiment in your CI pipeline. The
action loads your experiment script, runs it against a Langfuse dataset,
comments the result on the PR, and optionally fails the job when a regression
is detected.

## Contents

- [Quickstart](#quickstart)
- [Usage](#usage)
  - [Inputs](#inputs)
  - [Outputs](#outputs)
  - [Script contract](#script-contract)
  - [Consuming the result in later steps](#consuming-the-result-in-later-steps)
  - [Experiment metadata](#experiment-metadata)
- [FAQ](#faq)
  - [Can I run Python and TypeScript experiments in the same step?](#can-i-run-python-and-typescript-experiments-in-the-same-step)
  - [How do I manage the Langfuse SDK installation myself?](#how-do-i-manage-the-langfuse-sdk-installation-myself)
  - [How do I pass extra secrets (OpenAI keys, etc.) to my experiment?](#how-do-i-pass-extra-secrets-openai-keys-etc-to-my-experiment)
  - [Can I pin a specific Langfuse SDK version?](#can-i-pin-a-specific-langfuse-sdk-version)
  - [Why does the action need a `github_token`?](#why-does-the-action-need-a-github_token)
  - [Does PR commenting work on forked-PR runs?](#does-pr-commenting-work-on-forked-pr-runs)
  - [Why can't I see my experiment in Langfuse?](#why-cant-i-see-my-experiment-in-langfuse)
- [Contributing](#contributing)
- [License](#license)

## Quickstart

```yaml
name: Langfuse experiment
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # required for posting the experiment comment
  actions: read # lets "View run" link to the specific job (falls back to the workflow-run URL otherwise)

jobs:
  experiment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      # For experiments written in Python (`.py` scripts).
      - uses: actions/setup-python@v6
        with:
          python-version: "3.14"

      # For experiments written in TypeScript / JavaScript
      # (`.ts` / `.js` / `.mjs` / `.cjs` scripts). Safe to include both
      # setups if your `experiment_path` is a directory with a mix of
      # runtimes.
      - uses: actions/setup-node@v6
        with:
          node-version: "24"

      # Pin to a release SHA (Zizmor-friendly, protects you from
      # tag-moved attacks). The `# v<version>` comment is what humans
      # read; the SHA is what GitHub resolves. This line is auto-bumped
      # by `.github/workflows/release-bump-readme.yml` on every release.
      - uses: langfuse/experiment-action@44c51696585150a64a5f606f75bc61bbe24902b1 # v1.0.0
        with:
          langfuse_public_key: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
          langfuse_secret_key: ${{ secrets.LANGFUSE_SECRET_KEY }}
          experiment_path: experiments/qa_experiment.py
          dataset_name: qa-set
          github_token: ${{ github.token }}
```

Only include the setup steps you actually need — Python-only projects can
drop `actions/setup-node`, TS-only projects can drop `actions/setup-python`.

## Usage

### Inputs

| Input                          | Required | Default                      | Description                                                                                                                                                     |
| ------------------------------ | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `langfuse_public_key`          | yes      |                              | Langfuse public API key.                                                                                                                                        |
| `langfuse_secret_key`          | yes      |                              | Langfuse secret API key.                                                                                                                                        |
| `langfuse_base_url`            | no       | `https://cloud.langfuse.com` | Langfuse base URL.                                                                                                                                              |
| `experiment_path`              | yes      |                              | File, directory, or glob pattern pointing at experiment scripts.                                                                                                |
| `dataset_name`                 | no       |                              | Dataset to run against. If omitted, the user script is expected to select its own dataset.                                                                      |
| `dataset_version`              | no       |                              | Pin the experiment to a specific dataset version.                                                                                                               |
| `experiment_metadata`          | no       |                              | Additional metadata as a multiline `key=value` string. Shown under the Metadata column in the Langfuse UI.                                                      |
| `should_fail_on_regression`    | no       | `true`                       | Fail CI when an experiment raises `RegressionError`.                                                                                                            |
| `should_fail_on_script_error`  | no       | `true`                       | Fail CI when an experiment script crashes or raises a non-regression error.                                                                                     |
| `should_comment_on_pr`         | no       | `true`                       | Post the result as a PR comment.                                                                                                                                |
| `python_sdk_version`           | no       | `4.6.0`                      | Python SDK version to install via `pip` (for `.py` experiments).                                                                                                |
| `js_sdk_version`               | no       | `5.3.0`                      | JS SDK version (`@langfuse/client`) to install via `npm` (for `.ts`/`.js`/`.mjs`/`.cjs` experiments).                                                           |
| `should_skip_sdk_installation` | no       | `false`                      | Skip automatic SDK installation and use the ambient Python/Node environment.                                                                                    |
| `github_token`                 | no       |                              | Token used to post the PR comment. Pass `${{ github.token }}` and grant `pull-requests: write` (and optionally `actions: read` for job-level "View run" links). |

### Outputs

| Output        | Description                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `result_json` | JSON output with action metadata and experiment results. See [`schemas/result-json.v1.schema.json`](schemas/result-json.v1.schema.json). |
| `failed`      | `"true"` if any experiment errored or raised a regression, else `"false"`.                                                               |

For the full `result_json` structure, see [`schemas/result-json.v1.schema.json`](schemas/result-json.v1.schema.json).

### Script contract

Your experiment script must define a function named `experiment`. The action
creates a Langfuse SDK `RunnerContext` and passes it as the first argument so
scripts can use action-injected defaults for dataset, dataset version, and
metadata. Use the access patterns from the [Langfuse experiments
docs][docs-experiments] — iterate `run_evaluations` / `runEvaluations` to find
the score you want to gate on.

[docs-experiments]: https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk#basic-usage

#### Python

```python
from langfuse import RegressionError, RunnerContext


def experiment(context: RunnerContext):
    result = context.run_experiment(
        name="My experiment",
        task=my_task,
        evaluators=[my_evaluator],
        run_evaluators=[avg_accuracy],
    )

    avg_accuracy = next(
        evaluation.value
        for evaluation in result.run_evaluations
        if evaluation.name == "avg_accuracy"
    )
    if avg_accuracy < 0.9:
        raise RegressionError(result=result)

    return result
```

#### TypeScript / JavaScript

```ts
import { RegressionError, type RunnerContext } from "@langfuse/client";

export async function experiment(context: RunnerContext) {
  const result = await context.runExperiment({
    name: "My experiment",
    task: myTask,
    evaluators: [myEvaluator],
    runEvaluators: [avgAccuracy],
  });

  const avgAccuracy =
    (result.runEvaluations.find((e) => e.name === "avg_accuracy")?.value as number | undefined) ??
    0;
  if (avgAccuracy < 0.9) {
    throw new RegressionError({ result });
  }

  return result;
}
```

The action serializes the returned value to JSON and exposes it through the
`result_json` output. If the function raises, the error is captured and the
CI job fails depending on `should_fail_on_regression` /
`should_fail_on_script_error`.

### Consuming the result in later steps

```yaml
- uses: langfuse/experiment-action@44c51696585150a64a5f606f75bc61bbe24902b1 # v1.0.0
  id: experiment
  with: # ...

- name: Upload result as artifact
  run: echo '${{ steps.experiment.outputs.result_json }}' > experiment.json

- uses: actions/upload-artifact@v7
  with:
    name: experiment-result
    path: experiment.json
```

### Experiment metadata

Every experiment run carries the following metadata, in addition to anything
you pass via `experiment_metadata`. Action-generated keys are namespaced
under `langfuse.*` so they're easy to distinguish from your own.

| Key                             | Source                                            | Notes                                                                                                                       |
| ------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `langfuse.git_sha`              | `$GITHUB_SHA`                                     | The commit being tested.                                                                                                    |
| `langfuse.branch`               | `$GITHUB_REF_NAME`                                |                                                                                                                             |
| `langfuse.event`                | `$GITHUB_EVENT_NAME`                              | E.g. `pull_request`, `push`.                                                                                                |
| `langfuse.actor`                | `$GITHUB_TRIGGERING_ACTOR` → `$GITHUB_ACTOR`      | The user who kicked off the current attempt.                                                                                |
| `langfuse.pr_url`               | derived from `$GITHUB_REF`                        | Only on `pull_request` events.                                                                                              |
| `langfuse.github_workflow_name` | `$GITHUB_WORKFLOW`                                | E.g. `CI`.                                                                                                                  |
| `langfuse.github_job_name`      | `$GITHUB_JOB`                                     | The workflow job running the experiment.                                                                                    |
| `langfuse.github_job_attempt`   | `$GITHUB_RUN_ATTEMPT`                             | `"1"` on the initial run, `"2"`+ on re-runs.                                                                                |
| `langfuse.github_job_url`       | resolved via the GitHub API from `$GITHUB_RUN_ID` | Direct link to this job's logs. Requires `github_token` with `actions: read`; falls back to the workflow-run URL otherwise. |
| _custom_                        | `experiment_metadata`                             | Forwarded verbatim — pick whatever namespace your org prefers.                                                              |

## FAQ

### Can I run Python and TypeScript experiments in the same step?

Yes. Point `experiment_path` at a directory (or a glob) that contains a mix
of `.py` and `.ts` / `.js` / `.mjs` / `.cjs` files. The action detects the
runtime per-script, installs each SDK once per step, and runs everything
sequentially. Make sure your workflow has `actions/setup-python` **and**
`actions/setup-node` before the action step.

```yaml
experiment_path: experiments/ # contains both python and ts scripts
```

Files starting with `.` or `_` are skipped so helper modules (e.g.
`__init__.py`, `_utils.ts`) don't get executed as experiments.

### How do I manage the Langfuse SDK installation myself?

Set `should_skip_sdk_installation: "true"` and install the SDK yourself
before the action runs. Useful when your project has pinned lockfiles
you'd rather honour than reinstall against the action's default SDK versions.

#### Python — install from your own `requirements.txt`

```yaml
- uses: actions/setup-python@v6
  with:
    python-version: "3.14"
    cache: pip

- run: pip install -r requirements.txt # must include `langfuse`

- uses: langfuse/experiment-action@44c51696585150a64a5f606f75bc61bbe24902b1 # v1.0.0
  with:
    experiment_path: experiments/
    should_skip_sdk_installation: "true"
    langfuse_public_key: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
    langfuse_secret_key: ${{ secrets.LANGFUSE_SECRET_KEY }}
```

Works with any Python installer — swap `pip install -r requirements.txt`
for `poetry install`, `uv sync`, `pdm install`, etc.

#### Node — install from your own lockfile

The action needs `@langfuse/client`, `@langfuse/tracing`, `@langfuse/otel`,
`@opentelemetry/sdk-node`, and `tsx` reachable from the working directory's
`node_modules/`.

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: "24"
    cache: npm # or pnpm / yarn

- run: npm ci # or `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`

- uses: langfuse/experiment-action@44c51696585150a64a5f606f75bc61bbe24902b1 # v1.0.0
  with:
    experiment_path: experiments/
    should_skip_sdk_installation: "true"
    langfuse_public_key: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
    langfuse_secret_key: ${{ secrets.LANGFUSE_SECRET_KEY }}
```

Make sure `@langfuse/client`, `@langfuse/tracing`, `@langfuse/otel`,
`@opentelemetry/sdk-node`, and `tsx` are listed in `package.json` (either
`dependencies` or `devDependencies` — `npm ci` installs both).

### How do I pass extra secrets (OpenAI keys, etc.) to my experiment?

Set them as env vars on the action step — the experiment subprocess
inherits the parent process's environment.

```yaml
- uses: langfuse/experiment-action@44c51696585150a64a5f606f75bc61bbe24902b1 # v1.0.0
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    experiment_path: experiments/
    # ... usual inputs
```

Your `experiment()` function can read them with `os.environ[...]` (Python)
or `process.env.[...]` (TS / JS).

### Can I pin a specific Langfuse SDK version?

Yes, for each runtime independently:

```yaml
python_sdk_version: "4.1.2"
js_sdk_version: "5.0.0-rc.3"
```

If a version is already installed and matches, the action skips the install.

### Why does the action need a `github_token`?

For two things, both optional:

1. Posting the experiment results comment on the PR (requires
   `pull-requests: write` permission on the workflow).
2. Resolving the specific job URL — the action does one API call to
   `GET /repos/.../actions/runs/<id>/jobs` so the PR comment and the
   `langfuse.github_job_url` metadata link to _this_ job's logs instead of the
   broader workflow run.

If `github_token` is blank, both features are silently skipped; the
experiment still runs and succeeds/fails as usual.

### Does PR commenting work on forked-PR runs?

No — GitHub restricts the default `GITHUB_TOKEN` to **read-only** on
workflows triggered from forks, which blocks comment creation. This is a
platform-level constraint, not something the action can work around
directly. Two common mitigations:

- Use `pull_request_target` (carefully — [read GitHub's security
  guidance][pr-target-security] first; this runs workflows in the context
  of the base repo with write permissions).
- Use a separate `workflow_run`-triggered job that grabs artefacts and
  posts the comment with elevated permissions.

[pr-target-security]: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/

### Why can't I see my experiment in Langfuse?

The action only renders `View in Langfuse` for dataset-backed experiments.
To get a `View in Langfuse` link, run against a real Langfuse dataset by passing `dataset_name` to the action.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
