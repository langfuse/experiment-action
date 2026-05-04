# AGENTS

## Key commands

| Command               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `pnpm install`        | Install dependencies                                   |
| `pnpm run typecheck`  | Run `tsc --noEmit`                                     |
| `pnpm run lint`       | Run ESLint over `src/` and `tests/`                    |
| `pnpm run test`       | Run the Vitest suite                                   |
| `pnpm run build`      | Rebuild `dist/` via `ncc` and copy the runner wrappers |
| `pnpm run check-dist` | Rebuild and fail if `dist/` is stale                   |
| `pnpm run all`        | Typecheck, lint, test, schema check, and build         |

## Dist expectations

`dist/` is committed and GitHub executes `dist/index.js` directly.

If you change runtime behavior, runner wiring, inputs, outputs, or comment rendering, rebuild it:

```sh
pnpm run build
git add dist
```

## Comment format changes

If you change the PR comment layout or wording in `src/comment.ts`, also do the following:

1. Update the explicit title/body assertions in `tests/comment.test.ts` if needed.
2. Refresh the markdown snapshots under `tests/snapshots/`.
3. Run:

```sh
pnpm vitest run tests/comment.test.ts
```

If the change was intentional and snapshots need updating:

```sh
pnpm vitest run tests/comment.test.ts -u
```

Things that commonly need attention when the comment format changes:

- the top title/header line
- overview table columns and wording
- `<details>` summary text
- item table columns or labels
- hidden section markers used for comment upserts
