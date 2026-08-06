#!/usr/bin/env bash
#
# Preflight checks for a release.
#
# release-please decides what the next version is; this script only verifies the
# repository is in a state where merging the open release PR produces a correct
# release. Merging main needs no review, so these checks are the only thing
# standing between a mistake and a published package — keep them as code rather
# than as a list someone has to remember. See docs/RELEASES.md.
#
# Requires an authenticated GitHub CLI. Nothing else: gh has a jq engine builtin.

set -euo pipefail

PENDING_LABEL="autorelease: pending"

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok    %s\n' "$1"
}

command -v gh >/dev/null 2>&1 ||
  fail "GitHub CLI (gh) is not installed."
gh auth status >/dev/null 2>&1 ||
  fail "GitHub CLI is not authenticated. Run 'gh auth login'."

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) ||
  fail "cannot work out which GitHub repository this is. Run from a checkout."

# A merged release PR that still carries the pending label means release-please
# never tagged it. In that state it refuses to open any new release PR at all,
# so every later release stalls silently until it is recovered by hand.
stuck=$(gh pr list --repo "$repo" --state merged --label "$PENDING_LABEL" \
  --json number --jq 'map("#\(.number)") | join(", ")')
[ -z "$stuck" ] ||
  fail "merged release PR still labelled '$PENDING_LABEL': $stuck.
      release-please is jammed and will not open new release PRs.
      See docs/RELEASES.md, 'Recovering a stalled release'."
pass "no untagged merged release PR"

rows=$(gh pr list --repo "$repo" --state open --label "$PENDING_LABEL" \
  --json number,title,headRefName --jq '.[] | [.number, .headRefName, .title] | @tsv')
count=$(printf '%s\n' "$rows" | grep -c . || true)

if [ "$count" -eq 0 ]; then
  fail "no open release PR.
      Nothing has landed since the last tag that release-please puts in a
      changelog, so there is nothing to release. Land a feat/fix/perf/revert/docs
      change first, or check that the Publish and Release workflow is running."
fi
if [ "$count" -gt 1 ]; then
  fail "$count open release PRs, expected exactly one:
$rows"
fi
IFS=$(printf '\t') read -r pr_number head_ref pr_title <<EOF
$rows
EOF
pass "one open release PR: #$pr_number ($pr_title)"

# release-please reads the version to tag from the PR title, while npm publishes
# whatever package.json says. If those disagree the tag and the published package
# describe different releases, so check all three sources against each other.
case $pr_title in
*"release "*) title_version=${pr_title##*release } ;;
*) fail "cannot read a version from PR title '$pr_title'." ;;
esac
pkg_version=$(gh api "repos/$repo/contents/package.json?ref=$head_ref" \
  -H "Accept: application/vnd.github.raw" --jq .version)
manifest_version=$(gh api "repos/$repo/contents/.release-please-manifest.json?ref=$head_ref" \
  -H "Accept: application/vnd.github.raw" --jq '."."')

if [ "$title_version" != "$pkg_version" ] || [ "$title_version" != "$manifest_version" ]; then
  fail "version mismatch on #$pr_number:
      PR title                      $title_version
      package.json                  $pkg_version
      .release-please-manifest.json $manifest_version"
fi
pass "version agrees across PR title, package.json and manifest: $title_version"

if gh release view "v$title_version" --repo "$repo" >/dev/null 2>&1; then
  fail "tag v$title_version already exists. Merging would try to release it twice."
fi
pass "tag v$title_version does not exist yet"

build=$(gh pr view "$pr_number" --repo "$repo" --json statusCheckRollup --jq '
  [.statusCheckRollup[]? | select(.name == "Build")]
  | if length == 0 then "MISSING" else (.[0].conclusion // .[0].status // "PENDING") end')
[ "$build" = "SUCCESS" ] ||
  fail "required check 'Build' is $build on #$pr_number, expected SUCCESS."
pass "required check 'Build' passed"

cat <<EOF

Ready to release $title_version.

  gh pr merge $pr_number --squash

Merging tags v$title_version, publishes to npm and updates the agent registry.
EOF
