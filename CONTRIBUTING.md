# Contributing

## Development setup

```sh
pnpm install
pnpm run all    # typecheck + lint + test + bundle
```

### Useful scripts

| Command                            | What it does                                           |
| ---------------------------------- | ------------------------------------------------------ |
| `pnpm run typecheck`               | `tsc --noEmit`                                         |
| `pnpm run lint`                    | ESLint over `src/` and `tests/`                        |
| `pnpm run test`                    | vitest, unit tests only                                |
| `pnpm run build`                   | Bundle via `ncc` into `dist/` and copy runner wrappers |
| `pnpm run check-dist`              | Rebuild and fail if `dist/` has uncommitted changes    |
| `pnpm run format` / `format:check` | Prettier                                               |

## Project layout

```
action.yml                    # action manifest
src/
  main.ts                     # entry point
  inputs.ts, metadata.ts, ... # parsing + wiring
  runners/
    install.ts                # `pip install langfuse`, `npm install langfuse tsx`
    python.ts, node.ts        # dispatch to the right wrapper
    wrappers/
      python_runner.py        # imports user module, calls experiment(), writes result JSON
      node_runner.mjs         # same for JS/TS via tsx
tests/
  *.test.ts                   # vitest unit tests
  fixtures/                   # experiment scripts used in CI e2e jobs
dist/                         # committed bundle — GitHub runs this directly
```

## The `dist/` directory

`dist/index.js` is the bundled output that GitHub Actions executes. It **must**
be committed. CI runs `pnpm run check-dist` to guard against a stale bundle —
rebuild before pushing:

```sh
pnpm run build
git add dist
```

## Local development

The `tests/fixtures/` scripts under `passing/`, `regression/`, and `mixed/`
exercise the runner plumbing without touching Langfuse. Fixtures under
`tests/fixtures/e2e/` use the real SDK and need a reachable Langfuse server.

### Start a local Langfuse

```sh
cp .env.example .env          # pre-seeded dev credentials work out of the box
pnpm run dev                  # downloads langfuse's docker-compose.yml, starts + waits for health
pnpm run dev:down             # tear down and wipe volumes
```

The repository's end-to-end coverage runs in GitHub Actions CI, where the
workflow creates a dataset first and then runs the E2E fixtures against it.

### Point at Langfuse Cloud

Edit `.env` to set `LANGFUSE_BASE_URL=https://cloud.langfuse.com` and supply
your own API keys. The rest of the flow is unchanged.

## Releasing

1. Bump the version in `package.json`
2. Rebuild: `pnpm run build && git add dist`
3. Commit and open a PR
4. After merge, tag: `git tag v1.2.3 && git push --tags`

## Contract changes

The public contract is:

- Inputs and outputs declared in `action.yml`
- The `experiment()` function signature documented in the README
- The JSON shape of `result_json`

Any change to these needs a major version bump and a note in the PR description.

## Reporting bugs and feature requests

All issue tracking happens in the main [langfuse/langfuse](https://github.com/langfuse/langfuse)
repository — blank issues on this repo are disabled to keep reporting in
one place.

- **Bug in the action** or **bug in Langfuse itself (SDK, API, UI)** →
  open a bug report in `langfuse/langfuse` with the `Experiment Action`
  label. The links under "New issue" on this repo route there
  automatically.
- **Feature requests** → the `ideas` category in
  [Langfuse discussions](https://github.com/orgs/langfuse/discussions).
- **Usage questions** → the `support` category in the same discussions.
