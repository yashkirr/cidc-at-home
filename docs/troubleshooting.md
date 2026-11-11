# Troubleshooting

**"Port 4321 is busy. Is the pipeline already open?"**
It probably is: open http://localhost:4321/. Or start on another port: `PIPELINE_PORT=5000 ./start.sh`.

**"No pipeline.json in ..."**
Add one at the root of that repo. Start from [examples](../examples/).

**After Build: "No pipeline.json in .../.cicd-at-home/work/..."**
The batch has no `pipeline.json`: it is in your folder but not on GitHub's main yet. Commit it and push it to main,
or tick the pull request that adds it.

**"Could not list PRs"**
The GitHub CLI isn't signed in, or the repo's `origin` isn't on GitHub. Run `gh auth status` in the repo folder.

**"PR #12 clashes with main or with a PR added before it."**
Two changes touch the same lines. Update that pull request on GitHub (merge main into it), or leave it out of this
batch and build again.

**"Main changed on GitHub since the build. Run the build again."**
Someone pushed to the branch after you built. Build again so the new commits are tested too.

**"GitHub did not merge PR #12."**
Usually someone pushed to the pull request after the build, or branch protection blocks it. Pull requests above it in
the list are already merged; the deploy did not run. Build again.

**"GitHub's main is not the same as the tested batch."**
Something else changed main while merging. Nothing was deployed. Build again.

**A stage passes on my machine but fails here.**
Stages run in the private copy (`~/.cicd-at-home/work/...`) with `CI=1` set. Run the command there by hand to see the
difference: `cd ~/.cicd-at-home/work/<repo>-<id> && <your command>`.

**I want a completely fresh copy.**
Close the app, then delete the copy and tell git it is gone:
`git -C /path/to/your/repo worktree remove --force ~/.cicd-at-home/work/<repo>-<id>`. The next build makes a new one.

**The page shows "Waiting" after I restarted the app.**
The current run lives in memory only. Build again.
