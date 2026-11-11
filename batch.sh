#!/usr/bin/env bash
# Batch stage: GitHub's main plus the chosen open PRs, merged in order into this checkout (the pipeline's own
# worktree, never your working copy). Usage: batch.sh [PR number...]. Writes .pipeline-batch: base sha, then "number sha".
set -euo pipefail
cd "${PIPELINE_WORK:?run from the pipeline app}"
BASE=${PIPELINE_BRANCH:-main}
say() { printf '\n== %s\n' "$1"; }
git() { command git -c user.name="CI/CD at home" -c user.email=pipeline@localhost "$@"; }

say "Get main"
git fetch -q origin "$BASE"
git merge --abort 2>/dev/null || true  # a stopped run can leave a merge half done
git checkout -qf --detach "origin/$BASE"
git reset -q --hard "origin/$BASE"
git clean -qfd  # untracked files only; ignored build caches (node_modules and so on) stay
base=$(git rev-parse HEAD)
echo "main is at $(git log -1 --format='%h %s')"
echo "$base" > .pipeline-batch

for n in "$@"; do
  case $n in *[!0-9]*|'') echo "Not a PR number: $n" >&2; exit 1 ;; esac
  say "Add PR #$n"
  git fetch -q origin "pull/$n/head"
  sha=$(git rev-parse FETCH_HEAD)
  git log -1 --format='%h %s' "$sha"
  if ! git merge -q --no-ff --no-edit -m "Batch: PR #$n" "$sha"; then
    git merge --abort || true
    echo "PR #$n clashes with main or with a PR added before it. Fix the clash on GitHub, or leave it out of this batch." >&2
    exit 1
  fi
  echo "$n $sha" >> .pipeline-batch
done

say "Batch ready"
git log --oneline "$base..HEAD" | cat
[ "$#" -gt 0 ] || echo "No PRs picked: the batch is main as it is."
