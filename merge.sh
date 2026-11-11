#!/usr/bin/env bash
# Merge stage: merges the tested PRs on GitHub (in batch order, each only if its head is still the tested commit),
# then checks that GitHub's main now has exactly the files that were tested. Reads .pipeline-batch from batch.sh.
set -euo pipefail
cd "${PIPELINE_WORK:?run from the pipeline app}"
BASE=${PIPELINE_BRANCH:-main}
say() { printf '\n== %s\n' "$1"; }
die() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }

[ -f .pipeline-batch ] || die "No batch. Run the build first."
base=$(head -1 .pipeline-batch)
tested=$(git rev-parse 'HEAD^{tree}')

say "Main unchanged"
git fetch -q origin "$BASE"
[ "$(git rev-parse "origin/$BASE")" = "$base" ] || die "Main changed on GitHub since the build. Run the build again."
echo "Yes"

tail -n +2 .pipeline-batch | while read -r n sha; do
  say "Merge PR #$n"
  # sha= makes GitHub refuse if someone pushed to the PR after it was tested.
  gh api -X PUT "repos/{owner}/{repo}/pulls/$n/merge" -f sha="$sha" -f merge_method=merge --jq .message ||
    die "GitHub did not merge PR #$n. PRs above it are merged. Run the build again."
done

say "Main matches the tested batch"
for i in 1 2 3 4 5; do  # GitHub can take a moment to show the last merge
  git fetch -q origin "$BASE"
  [ "$(git rev-parse "origin/$BASE^{tree}")" = "$tested" ] && break
  [ "$i" = 5 ] && die "GitHub's main is not the same as the tested batch. Nothing was deployed. Run the build again."
  sleep 3
done
git checkout -q --detach "origin/$BASE"  # same files, so the build stays valid
echo "main is at $(git log -1 --format='%h %s')"
