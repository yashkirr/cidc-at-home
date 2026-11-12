# pipeline.json reference

`pipeline.json` lives at the root of the repo you want to build and deploy.

```json
{
  "branch": "main",
  "environment": "prod",
  "build": [
    { "name": "Checks", "run": "bash scripts/check.sh", "env": { "CI": "1" } }
  ],
  "deploy": [
    { "name": "Release", "run": "bash scripts/release.sh" }
  ]
}
```

## Fields

| Field | Required | What it does |
|---|---|---|
| `branch` | no, default `main` | The branch you release from. Builds start from it, and pull requests into it are listed. |
| `environment` | no, default `prod` | A name for where deploys go ("Deploy to prod", "Live in prod"). Deploy stages make this environment live unless they name their own. |
| `build` | no | Stages run by the **Build** button, in order. |
| `deploy` | no | Stages run by the **Deploy** button, in order. |

Each stage:

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Shown on the stage card. |
| `run` | yes | A shell command, run with `bash -c` in the private copy of your repo. Exit 0 = passed. |
| `env` | no | Extra environment variables for this stage. A value starting with `~/` gets your home folder. |
| `environment` | no | Deploy stages only. The environment this stage makes live, if not the pipeline's own. See [Environments](#environments). |
| `parallel` | no | `true` starts this stage at the same time as the stage before it. Ignored on the first stage of `build` or `deploy`, so nothing deploys before the merge. |

The first failing stage stops the run (for deploy stages, the later stages of its environment). Later stages stay "Waiting". Stages running in parallel all finish first.

## Parallel stages

Two deploy stages that don't need each other can run side by side. Here the app goes to the store while the website
uploads, and both start right after the merge:

```json
"deploy": [
  { "name": "Website", "run": "bash scripts/release.sh" },
  { "name": "App", "run": "bash scripts/app-release.sh", "parallel": true }
]
```

The page stacks them in one column. Both run in the same private copy, so they must not write the same files. The
next stage (if any) waits for both. An environment is live only when every one of its stages passed: give the app
its own `environment` (below) so the website does not wait on the app store.

## Environments

Each deploy stage makes one environment live: the pipeline's `environment`, or its own. An environment goes live
when the merge and all of its stages pass. The page has a "Live in" card for each, showing the build live there.

```json
"environment": "prod",
"deploy": [
  { "name": "Deploy", "run": "bash scripts/release.sh" },
  { "name": "iOS app", "run": "eas build -p ios --auto-submit --no-wait", "parallel": true, "environment": "TestFlight" }
]
```

If "iOS app" fails, the build is still live in prod, and TestFlight keeps the build it had. A failed stage stops the
later stages of its own environment only. The queue pauses only when the pipeline's own environment does not go live.
Retry runs the failed stage again, and TestFlight goes live when it passes. A rollback runs every deploy stage again.

## Steps

A stage can have steps. Any line the command prints that starts with `== ` (two equals signs and a space) starts a
new step:

```bash
echo "== Lint";  npm run lint
echo "== Tests"; npm test
```

The page shows "Lint" and "Tests" under the stage, each with its own tick. When a stage fails, the step that was
running is the one marked failed.

After a stage's first full run, the page remembers its steps and lists them greyed out under the stage, even
when no build is there. That's how you see what will run where. PR numbers in step names show as `#N`.

Tip: put each stage in a script in your repo (`scripts/check.sh`) and keep `pipeline.json` short. The same script then
works from a terminal too.

## What every stage gets

- **Working folder:** the private copy of your repo, with the batch checked out. Not your own working copy.
- **Environment:** your own environment (the terminal you started the app from), plus:
  - `PIPELINE_WORK`: the private copy's path.
  - `PIPELINE_BRANCH`: the `branch` from `pipeline.json`.
  - `CI=1` and `FORCE_COLOR=0`, so tools print plain logs.
  - `AWS_PROFILE`, if you typed one on the page.
  - The stage's own `env`.

## Which pipeline.json is used

When you press Build, the page first shows the stages from the `pipeline.json` in your own folder. Once the batch is
made, the app reads `pipeline.json` again from the batch itself, so a pull request that changes the stages is built
with its own stages. GitHub Actions does the same with workflow files.

This means a pull request can change what runs on your machine. Only tick pull requests you trust. See
[security](security.md).

## Keep it fast

- The private copy is reused between builds. Files your `.gitignore` ignores (such as `node_modules`, build caches)
  survive, so tools that cache there get faster after the first build.
- Skip a reinstall when nothing changed, for example: compare `package-lock.json` with a copy you saved after the last
  `npm ci`.
- Point slow caches at a folder outside the copy with `env`, for example `"env": { "CACHE_DIR": "~/.cache/my-app" }`.
