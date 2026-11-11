#!/usr/bin/env bash
# Merge stage: merges the tested PRs on GitHub (in batch order, each only if its head is still the tested commit),
# then checks that GitHub's main now has exactly the files that were tested. Reads .pipeline-batch from batch.sh.
set -euo pipefail
fetch() { for i in 1 2 3 4 5; do git fetch -q origin "$@" && return; sleep "$i"; done; return 1; }  # see batch.sh
cd "${PIPELINE_WORK:?run from the pipeline app}"
BASE=${PIPELINE_BRANCH:-main}
say() { printf '\n== %s\n' "$1"; }
die() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }

[ -f .pipeline-batch ] || die "No batch. Run the build first."
base=$(head -1 .pipeline-batch)
tested=$(git rev-parse 'HEAD^{tree}')

say "Main unchanged"
fetch "$BASE"
# Files, not commits: a batch stacked on an earlier batch was built on that batch's commit, and once that batch is
# merged GitHub's main has the same files under different commits.
[ "$(git rev-parse "origin/$BASE^{tree}")" = "$(git rev-parse "$base^{tree}")" ] ||
  die "Main on GitHub is not what this batch was built on (someone pushed, or the batch below it did not merge). Run the build again."
echo "Yes"

tail -n +2 .pipeline-batch | while read -r n sha; do
  say "Merge PR #$n"
  # sha= makes GitHub refuse if someone pushed to the PR after it was tested.
  gh api -X PUT "repos/{owner}/{repo}/pulls/$n/merge" -f sha="$sha" -f merge_method=merge --jq .message ||
    die "GitHub did not merge PR #$n. PRs above it are merged. Run the build again."
done

say "Main matches the tested batch"
for i in 1 2 3 4 5; do  # GitHub can take a moment to show the last merge
  fetch "$BASE"
  [ "$(git rev-parse "origin/$BASE^{tree}")" = "$tested" ] && break
  [ "$i" = 5 ] && die "GitHub's main is not the same as the tested batch. Nothing was deployed. Run the build again."
  sleep 3
done
git checkout -q --detach "origin/$BASE"  # same files, so the build stays valid
echo "main is at $(git log -1 --format='%h %s')"
