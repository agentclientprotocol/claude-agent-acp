# Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please)
in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). Every push
to `main` re-computes the next version from the conventional commit messages and
keeps a single release PR open, titled `chore(main): release X.Y.Z` and labelled
`autorelease: pending`.

Merging that PR is what releases. It tags `vX.Y.Z`, creates the GitHub release,
publishes to npm, and dispatches a version update to the agent registry.

There is no manual release button, and versions are never typed in by hand: the
version is an output of the commit history, not an input.

Every _other_ push to `main` publishes a preview instead — see
[Preview releases](#preview-releases). Anything merged to `main` is on npm within
minutes; there is no staging branch.

## Releasing

```sh
npm run release:preflight
```

This reports the open release PR, the version it will ship, and checks that the
repository is in a state where merging is safe. Nothing has to be remembered —
if it exits non-zero, follow what it prints instead of merging.

Then merge it, using the PR number the preflight printed:

```sh
gh pr merge <pr-number> --squash
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run is looked up rather than picked interactively, so this is safe to script.
If the workflow has already finished, `gh run list --workflow=publish.yml` shows
the outcome instead.

Merging main requires no review, so a green preflight and `Build` are the only
gates. Once the workflow finishes, confirm both outputs landed:

```sh
gh release view "v<version>"
npm view "@agentclientprotocol/claude-agent-acp@<version>"
```

## Preview releases

Every push to `main` that is not a release merge publishes a preview from the
same workflow. There is no GitHub release — only an npm publish under the
`preview` dist-tag, a `v<version>` tag on the commit it came from, and the same
agent registry update a stable release dispatches, since the registry has its own
handling for preview versions.

Those are three jobs, in that order: `publish-npm-preview` mirrors `publish-npm`
and does nothing but publish; `publish-tag-preview` creates the tag; and
`trigger-registry-update` is shared with the stable path. The tag is a separate
job so that a tag failure can be retried on its own with **Re-run failed jobs**
— re-running the publish is not an option, because npm versions are immutable and
publishing the same one twice fails outright.

Both downstream jobs are gated on a `published` output that the publish step
sets, not on whether the publish job went green. That keeps the two concerns
apart — `published` means "npm has this version" and nothing else — and it means
a rehearsal run that only passes `--dry-run` neither tags nor dispatches.

A stable and a preview dispatch can never collide — a release merge publishes
stable and skips the preview, every other push does the reverse — so the registry
sees exactly one dispatch per published version.

```sh
npm install @agentclientprotocol/claude-agent-acp@preview
npm view @agentclientprotocol/claude-agent-acp dist-tags
git ls-remote --tags origin 'refs/tags/*preview*'
```

The version is the `package.json` version with the patch incremented, plus
`-preview.N`: with `main` at 0.73.0 the previews are `0.73.1-preview.1`,
`0.73.1-preview.2`, and so on. `N` restarts at 1 whenever release-please moves
`package.json`, which keeps the sequence monotonic whichever way the next release
goes — a patch release makes the next base 0.73.2, a minor makes it 0.74.1, and
both sort above every `0.73.1-preview.*`.

`0.73.1-preview.4` is **not** a promise that 0.73.1 will ship. The base is a
patch bump because that is the only choice depending solely on `package.json`,
which release-please only ever increases. Using release-please's predicted next
version would read better but that prediction moves mid-flight: a `fix:` opens a
0.73.1 release PR, a later `feat:` moves it to 0.74.0, and `N` would reset under
previews that were already published.

`N` comes from [`scripts/next-preview-version.mjs`](../scripts/next-preview-version.mjs),
which takes the larger of two sources. The npm registry says what is taken — npm
versions are immutable and stay reserved even after `npm unpublish`, so reusing
one is a hard failure — but it is CDN-served and can lag a publish by minutes.
The git tags this job writes are strongly consistent and cover that window. The
job publishes before it tags, so a version can exist on npm without a tag but
never the reverse; that is why a registry read failure aborts the run rather than
falling back to the tags alone.

Two pushes landing together cannot collide, because the job takes a concurrency
group. GitHub keeps only one run pending per group, so a third push arriving
while one preview runs and another waits drops the waiting one — that commit
simply gets no preview.

`latest` stays put because the job passes `npm publish --tag preview`. Without
it npm would move `latest` onto the preview: `--tag` defaults to `latest` even
for a semver prerelease. Right after a release the `preview` dist-tag can name a
version _below_ `latest` until the next push lands; that is cosmetic.

Release merges are excluded by checking the head commit's author and the subject
release-please generates. Both are checked, either is enough, and the cost of a
miss is one wasted version number plus a `preview` tag briefly pointing at
already-released code — `latest` is untouched. release-please's own
`releases_created` output would be a sharper signal, but previews hang off the
`CI` workflow finishing rather than off the push, so they run in a different
workflow run from the `release-please` job and cannot read its outputs.

To publish a preview by hand — from any commit, bypassing the CI gate:

```sh
gh workflow run publish.yml --ref main \
  -f channel=preview -f ref=<commit-or-branch> -f publish_npm=false
```

`--ref main` is required: the `release` environment only accepts protected
branches, so a dispatch from anywhere else is rejected before the job starts.

## How the version is chosen

Squash merges use the PR title as the commit subject, so the PR title decides the
next version. [`conventional-prs.yml`](../.github/workflows/conventional-prs.yml)
rejects titles release-please would not understand.

| PR title prefix                                           | Effect                      |
| --------------------------------------------------------- | --------------------------- |
| `fix:`, `perf:`, `revert:`, `docs:`                       | patch, e.g. 0.66.0 → 0.66.1 |
| `feat:`                                                   | minor, e.g. 0.66.0 → 0.67.0 |
| any of the above with `!`, or BREAKING CHANGE             | minor while below 1.0.0     |
| `chore:`, `ci:`, `build:`, `test:`, `refactor:`, `style:` | no release on their own     |

Breaking changes bump the minor rather than the major because
`bump-minor-pre-major` is set in
[`release-please-config.json`](../release-please-config.json) and the package is
still below 1.0.0. That is deliberate: it keeps a single `!` in a PR title from
shipping 1.0.0 by accident.

Note that `config-file` only takes effect while the workflow does **not** pass a
`release-type` input to the action — with `release-type` set, the action ignores
the config entirely. The release type is declared inside the config instead.

`release-type` also switches release-please from `Manifest.fromManifest` to
`Manifest.fromConfig`, which is a second and sharper reason never to set it. On
the manifest path the previous release is found by an exact string match against
the version in [`.release-please-manifest.json`](../.release-please-manifest.json),
which is why the `v<x>-preview.<n>` tags are invisible to it. On the config path
release-please instead sorts every candidate tag and release descending and takes
the highest — and there the preview tags _would_ be candidates.

Because the config is what is read, it also has to say
`"include-component-in-tag": false`. Left at its default, release-please derives a
component from the package name and tags `claude-agent-acp-vX.Y.Z` instead of
`vX.Y.Z`. That renames the tag every step here looks up, and because no tag under
the new scheme exists, it also walks the entire commit history into the changelog
rather than just what landed since the last release. The preflight checks the tag
release-please is going to use, so this cannot reach a published release.

Releasing 1.0.0 is therefore an explicit act: add `"release-as": "1.0.0"` to
`release-please-config.json` in its own PR, release, then remove it again.

## Recovering a stalled release

### The release PR merged but nothing was tagged

The preflight fails with `release-please is jammed`. While a merged release PR
still carries `autorelease: pending`, release-please refuses to open any new
release PR at all, so every later release stalls silently until this is cleared.

Take the release notes release-please already wrote into the changelog, create
the missing release, then move the label the way release-please would have:

```sh
awk '/^## \[<version>\]/{f=1;print;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md
gh release create "v<version>" --target <merge-commit-sha> --notes-file notes.md
gh pr edit <pr-number> --remove-label "autorelease: pending" \
  --add-label "autorelease: tagged"
```

Then publish the tag as described below.

### The tag exists but npm or the registry is missing

npm publishes through OIDC from inside the workflow, so this cannot be done from
a laptop. Re-run the publish workflow against the existing tag:

```sh
gh workflow run publish.yml -f ref="v<version>" -f publish_npm=true
```

npm versions are immutable. If the package already published and only the
registry update failed, pass `-f publish_npm=false` so the run skips publishing
and only re-dispatches the registry update.

### A preview published but the commit was not tagged

Only the publish is irreversible, so re-run just the tag job:

```sh
gh run rerun <run-id> --failed
```

Or **Re-run failed jobs** on the run in the web or mobile UI. This re-runs
`publish-tag-preview` alone and leaves the successful publish untouched, which
matters because re-publishing an immutable npm version would fail.

If the re-run reports that it received no version or commit, the run's carried
over job outputs are gone and it cannot tag anything safely. Do it by hand
instead, taking the version from the publish job's log:

```sh
gh api "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/git/refs" \
  -f ref="refs/tags/v<version>" -f sha="<commit-sha>"
```

Either way nothing is broken in the meantime: the next preview still picks the
right `N` once the registry CDN catches up. The tag is how that number is known
immediately.

## Credentials

| Secret                                                        | Used for                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `RELEASE_PLZ_APP_ID`, `RELEASE_PLZ_APP_PRIVATE_KEY`           | App token for release PRs and tags, so they can trigger workflows |
| `REGISTRY_UPDATER_APP_ID`, `REGISTRY_UPDATER_APP_PRIVATE_KEY` | App token scoped to the `registry` repository                     |

Publishing to npm uses OIDC trusted publishing, so there is no npm token. All
release jobs run in the `release` environment.

npm binds a trusted publisher to one repository, one **workflow filename** and
one environment, and a package may only have one such binding. That is why
preview publishing is another job inside `publish.yml` rather than a workflow of
its own: a separate file would fail to authenticate, and registering it would
cost the stable path its publisher.
