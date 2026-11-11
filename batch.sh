#!/usr/bin/env bash
# Batch stage: GitHub's main plus the chosen open PRs, merged in order into this checkout (the pipeline's own
# worktree, never your working copy). Usage: batch.sh [PR number...]. Writes .pipeline-batch: base sha, then "number sha".
# PIPELINE_BASE (a commit) starts from there instead of main: the app sets it to stack this batch on one being deployed,
# or, with PIPELINE_ROLLBACK (a build number), to rebuild the commit an earlier build deployed.
# Every picked PR is tried, so one run names all the PRs that clash; then the stage fails. Nothing is left out silently.
set -euo pipefail
cd "${PIPELINE_WORK:?run from the pipeline app}"
BASE=${PIPELINE_BRANCH:-main}
say() { printf '\n== %s\n' "$1"; }
git() { command git -c user.name="CI/CD at home" -c user.email=pipeline@localhost "$@"; }
# The deploy lane may be fetching in the same repo at the same moment; git's ref lock makes one of them wait.
fetch() { for i in 1 2 3 4 5; do git fetch -q origin "$@" && return; sleep "$i"; done; return 1; }

start=${PIPELINE_BASE:-origin/$BASE}
say "Get main"
fetch "$BASE"
git merge --abort 2>/dev/null || true  # a stopped run can leave a merge half done
git checkout -qf --detach "$start"
git reset -q --hard "$start"
git clean -qfd  # untracked files only; ignored build caches (node_modules and so on) stay
base=$(git rev-parse HEAD)
if [ -n "${PIPELINE_ROLLBACK:-}" ]; then
  echo "Rollback: the commit build #$PIPELINE_ROLLBACK deployed, $(git log -1 --format='%h %s')"
elif [ -n "${PIPELINE_BASE:-}" ]; then
  echo "Stacked on the batch being deployed: main plus"
  git log --format='  %s' "origin/$BASE..HEAD" | grep '^  Batch: PR' || echo "  (no PRs)"
else
  echo "main is at $(git log -1 --format='%h %s')"
fi
echo "$base" > .pipeline-batch

clashed=""
for n in "$@"; do
  case $n in *[!0-9]*|'') echo "Not a PR number: $n" >&2; exit 1 ;; esac
  say "Add PR #$n"
  fetch "pull/$n/head"
  sha=$(git rev-parse FETCH_HEAD)
  git log -1 --format='%h %s' "$sha"
  if ! git merge -q --no-ff --no-edit -m "Batch: PR #$n" "$sha"; then
    git merge --abort || true
    echo "!! PR #$n clashes with main or with a PR added before it."
    clashed="$clashed #$n"
    continue
  fi
  echo "$n $sha" >> .pipeline-batch
done

if [ -n "$clashed" ]; then
  say "Batch stopped"
  echo "These PRs clash:$clashed. Fix them on GitHub, or untick them, and build again. Nothing was built." >&2
  exit 1
fi

say "Batch ready"
git log --oneline "$base..HEAD" | cat
[ "$#" -gt 0 ] || echo "No PRs picked: the batch is main as it is."
