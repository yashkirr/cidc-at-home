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
| `environment` | no, default `prod` | A name for where deploys go. It is only shown on the page ("Deploy to prod"). |
| `build` | no | Stages run by the **Build** button, in order. |
| `deploy` | no | Stages run by the **Deploy** button, in order. |

Each stage:

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Shown on the stage card. |
| `run` | yes | A shell command, run with `bash -c` in the private copy of your repo. Exit 0 = passed. |
| `env` | no | Extra environment variables for this stage. A value starting with `~/` gets your home folder. |
| `parallel` | no | `true` starts this stage at the same time as the stage before it. Ignored on the first stage of `build` or `deploy`, so nothing deploys before the merge. |

The first failing stage stops the run. Later stages stay "Waiting". Stages running in parallel all finish first.

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
next stage (if any) waits for both. A deploy is live only when every stage passed.

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
