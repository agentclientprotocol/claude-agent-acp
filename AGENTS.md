# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run build         # tsc
npm run test:run      # vitest, single pass
npm run check         # eslint + prettier --check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
```

CI runs `format:check`, `lint`, `build` and `test:run`. Run `npm run check` before
opening a PR.

## Pull requests

Squash merges use the PR title as the commit subject, and release-please parses it
to compute the next version. Titles must be conventional commits using one of:
`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`,
`build`, `ci`. `conventional-prs.yml` rejects anything else.

The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:` the
patch, and `chore:`/`ci:`/`test:` and friends do not release at all.

## Releasing

Stable releases are fully automated by release-please. There is no manual release
workflow, and the version is never chosen by hand — it follows from the commit
history.

```sh
npm run release:preflight     # verifies it is safe to release, prints the PR and version
gh pr merge <pr-number> --squash
```

The preflight is the guard-list as code; if it exits non-zero, follow what it
prints rather than merging.

Every _other_ push to `main` publishes a preview to npm — `0.73.1-preview.4` and
so on — under the `preview` dist-tag, and tags the commit it came from. `latest`
only ever moves on a real release, and previews never reach the agent registry.
So anything merged to `main` is published within minutes; there is no staging
branch. Full runbook, including how to recover a stalled release:
[`docs/RELEASES.md`](docs/RELEASES.md).
