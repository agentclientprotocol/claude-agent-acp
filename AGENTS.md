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

## Coding guidelines

- Keep edits consistent with the surrounding code's formatting, naming and idioms.
- Keep comments concise and concrete. Name the actual state, call or failure
  instead of alluding to it, prefer a short example over an abstract
  description, and avoid vague phrases like "keeps it honest". A comment or doc
  must be true on every code path it describes, and a doc that lists what a
  result omits or rejects must name the actual cases.
- When a request can't be served, throw a `RequestError` whose message says what
  happened and what to do (e.g. "Try again when the turn ends"). Don't drop the
  request silently.
- Don't report success for work you start without awaiting it. If the detached
  call can still refuse and its `.catch` only logs, check the refusal condition
  first or report the failure to the client.
- A result must not depend on what an earlier call happened to cache. A request
  right after a restart, with cold caches, must return the same thing as one
  after a warm-up.
- If code relies on an ordering or call sequence that nothing enforces (e.g. an
  echo arriving before the result), say so in a short comment.

## Architecture and design fit

- Before coding, read the code the change plugs into and find the module that
  owns the state or concept. Build on that module, not beside it. `acp-agent.ts`
  is already large: give a feature with its own state its own module (as
  `task-notifications.ts` or `clear-context-coordinator.ts` do) and call it
  from there.
- Prefer extending an existing mechanism over adding a new one, even if it takes
  a small refactor (moving a helper, generalizing a function). Add a parallel
  path, special case or flag only when the existing structure can't support the
  change.
- Before writing new logic, check whether it already exists in a sibling handler
  of the same flow or in a helper that works with the same data, and reuse it.
  Paths that handle the same input must apply the same rules through the same
  code: the live stream and the `session/load` replay, the command list and
  command dispatch, `prompt` and `steer`. Two copies of one check drift apart.
- Put guards, filters and cleanup in the module that owns the state, so every
  caller gets them. If guards, flags or fallbacks pile up in one place,
  restructure instead of adding another.
- If a result is meant to match another request's output, reuse that request's
  logic.
- The adapter serves ACP v1 and v2. A change that is not meant for one protocol
  version only must work correctly in both. `src/v2/` converts v2 requests to v1
  and reuses the v1 logic; keep v2-only differences in the conversion.
- A session runs one turn at a time. "Claude is working" means `startTurn`'s
  check (an unsettled turn in `turnQueue`, or `foregroundWork` for the session);
  don't write a narrower one. Anything that sends `session/update` must go
  through the turn queue or be refused while the session is busy, or its output
  lands inside another turn. Keep the session marked busy across awaited network
  calls.
- Don't branch on a local copy of state that Claude Code or a remote service
  owns: it goes stale when the other side changes. Have a command set the state
  the user asks for instead of toggling it.
- A command or name the adapter adds must not shadow one that Claude Code or the
  user's own commands and skills already provide.
- New optional request fields and `_meta` keys must not reject requests that
  were valid before.
- If a workaround or new path is unavoidable (e.g. a Claude Code or SDK
  limitation), say why in a short code comment and in the PR description.

## Testing guidelines

- Before adding a test, search `src/tests/` for existing tests of the same API
  and scenario, and add to their file and `describe` block. Use the helpers in
  `helpers.ts` and `session-doubles.ts` instead of copying setup.
- Don't add cases that take the same code path. Tests that differ only in input
  and expected output belong in one `it.each`. Don't repeat another test's
  assertions; assert only what this test is about.
- Reach a state the shortest way (e.g. set `session.tornDown = true`) instead of
  driving a full flow with extra mocks, unless the flow is what you test.
- Build test doubles from what the bundled Claude Code CLI really sends,
  including fields like `origin` it echoes back and fields it omits. A double
  simpler than the real message hides bugs. If unsure, check against the real
  CLI (`npm run test:integration`).
- Cover both ACP v1 and v2 when a change affects what a client receives
  (updates, responses, replay). A change to internal logic only does not need
  its tests duplicated per version.
- For each behavior the docs or comments promise, including what is omitted or
  rejected, have a test that would fail if it broke.

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
so on — under the `preview` dist-tag, tags the commit it came from, and updates
the agent registry the same way a release does. Only `latest` is reserved for
real releases. So anything merged to `main` is published within minutes; there is
no staging branch. Full runbook, including how to recover a stalled release:
[`docs/RELEASES.md`](docs/RELEASES.md).
