# How it works

## The pieces

| File | What it is |
|---|---|
| `server.mjs` | The app. A small web server on 127.0.0.1 that runs the stages and streams their output to the page. |
| `index.html` | The page. |
| `batch.sh` | The **Batch PRs** stage: main plus the ticked pull requests. |
| `merge.sh` | The **Merge on GitHub** stage. |
| `start.command`, `start.sh` | Launchers. |

Nothing else. No database: the app keeps the current run in memory, and the list of repos in
`~/.cicd-at-home/repos.json`.

## Build

```
Batch PRs  ->  your build stages  ->  (Deploy unlocks)
```

**Batch PRs** (`batch.sh`) works in a private copy of your repo, a git worktree in `~/.cicd-at-home/work/`. Your own
working copy is never touched, so you can keep coding while a build runs.

1. Fetch the branch from GitHub and reset the private copy to it. Leftover files from the last run are removed, but
   ignored files (caches, `node_modules`) are kept.
2. For each ticked pull request, in order: fetch it from GitHub (`pull/<number>/head`) and merge it. If one
   clashes with the branch or with one merged before it, the stage still tries the rest, then fails and names every
   pull request that did not fit. Nothing is left out for you: you untick them and build again.
3. Write `.pipeline-batch`: the branch's commit, then each pull request with the exact commit that was merged.

Then your **build stages** run, one after another, in the batch. Every stage must pass for Deploy to unlock.

## Deploy

```
Merge on GitHub  ->  your deploy stages
```

**Merge on GitHub** (`merge.sh`):

1. Checks the branch on GitHub has not moved since the build. If someone pushed to it, the stage stops: build again.
2. Merges each pull request on GitHub with the GitHub API, passing the commit that was tested. If anyone pushed to a
   pull request after the build, GitHub refuses that merge, so nothing untested goes in.
3. Fetches the branch again and compares its files with the tested batch (git tree hashes). Only if they are
   identical does deploy go on.

Then your **deploy stages** run in the same private copy, which now sits on the branch's new commit. Build output from
the build stages (a `dist/` folder, a Terraform plan file) is still there, so deploy stages can ship exactly what was
built and tested.

## Build the next batch while one deploys

Pressing **Deploy** hands the green batch to the deploy row, and **Build** unlocks again straight away. Pick the next
pull requests and build them while the deploy runs.

- The next batch is built in a second private copy (`~/.cicd-at-home/work/<repo>-<id>-next`), so it never touches the
  files the deploy is using. Its ignored caches (`node_modules` and so on) start cold the first time.
- It is **stacked** on the batch being deployed: `batch.sh` starts from that batch's tested commit (`PIPELINE_BASE`)
  instead of the branch on GitHub, then merges the new pull requests on top. The ones being deployed are greyed out.
- Every batch is a numbered **build** (Build #1, #2, ...). The **Builds** box on the page shows the build live in
  the environment and its PRs, the build deploying now, and the queue behind it. Numbers and the live build are kept
  in `~/.cicd-at-home/builds-<repo>-<id>.json`, so they survive a restart.
- Deploys go one at a time. While one runs, Deploy says **Queue deploy**. Press it while the build is still running
  or once it is green. Queued builds deploy on their own, oldest first, each once it is green. The queue can hold
  several builds (each in its own worktree, up to 10 in flight), each stacked on the one in front of it.
- **Take off queue** works on the last build in the queue only, because the ones behind a build are stacked on it.
- If a deploy fails or is stopped, the queue pauses: look, then **Resume queue**. If its merge failed, every build
  stacked on it is marked bad and dropped, because it was built on code main does not have.
- **Merge on GitHub** checks that the branch on GitHub has the same *files* the batch was built on. Once the batch
  under it is merged, it does, so the stacked batch deploys without a rebuild. If the batch under it did not merge, the
  page asks you to build again, and the merge stage refuses anyway.
- **Stop build** and **Stop deploy** stop one without the other.

## Why merge first, then deploy

Deploying straight from a batch of unmerged pull requests would put code live that main does not have. The next deploy
from main would then quietly remove it. Merging first, and checking main matches the batch, keeps "what is live" and
"what is on main" the same thing.

## Stop

**Stop** sends SIGTERM to the whole running stage (its process group), not just the shell, so child processes stop too.
Closing the app's terminal window does the same.

A stopped batch can leave a half-done merge in the private copy. The next build cleans that up.

## The page

The page gets live updates over Server-Sent Events (`/events`): the full state when it connects, then each log line as
it arrives. Open it in more than one tab if you like; they all show the same run.
