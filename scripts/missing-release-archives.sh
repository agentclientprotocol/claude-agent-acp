#!/usr/bin/env bash
#
# Prints the archives of the build matrix in .github/workflows/binaries.yml that
# a GitHub release does not have yet, one per line. Prints nothing when the
# release is complete. Fails when the release does not exist.
#
#   scripts/missing-release-archives.sh v0.112.0
#
# An asset that never finished uploading (state "open") counts as missing.
# Requires an authenticated GitHub CLI; set GH_REPO outside a clone.

set -euo pipefail

tag="${1:?usage: $0 <tag>}"
matrix="$(dirname "$0")/../.github/workflows/binaries.yml"

expected="$(sed -n 's/^ *archive: *//p' "$matrix" | sort)"
if [ -z "$expected" ]; then
  echo "No 'archive:' entries in $matrix." >&2
  exit 1
fi
attached="$(gh release view "$tag" --json assets \
  --jq '.assets[] | select(.state == "uploaded") | .name' | sort)"

comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$attached")
