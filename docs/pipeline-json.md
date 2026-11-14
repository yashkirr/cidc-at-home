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
| `deploy` | no | Stages run after a build passes, in order. |
| `environments` | no | Promotion rules per environment: bake time, health gates, Promote by hand, deploy hours. See [Promotion](#promotion-staging-bake-time-and-health-gates). Read from your checkout when the app opens the repo, like `autoDeploy`: restart the app after changing it. |
| `autoDeploy` | no, default `true` | Every build joins the queue as its batch is ready and deploys on its own once every build stage passes, after the builds in front. Builds Claude starts deploy too. Take a build off the queue to stop it going out. `false`: a **Deploy** button instead, pressed once per green build. Read from your checkout when the app opens the repo (like `branch`), so a pull request can't change it: restart the app after changing it. |

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

## Promotion: staging, bake time and health gates

List an environment under `environments` to make it a promotion step. Once its stages pass, it **bakes**: the app waits
its bake time while it checks its **health gates**, at the start, every 30 seconds and at the end. Nothing after it runs
until that passes. So a staging environment before prod is just two environments in order:

```json
"environment": "prod",
"deploy": [
  { "name": "Deploy staging", "environment": "staging", "run": "bash scripts/deploy.sh staging" },
  { "name": "Deploy prod", "run": "bash scripts/deploy.sh prod" }
],
"environments": {
  "staging": {
    "bake": "15m",
    "gates": [
      { "alarms": ["staging-5xx", "staging-p99-latency"], "region": "eu-west-1" },
      { "url": "https://staging.example.com/health" }
    ]
  },
  "prod": {
    "bake": "30m",
    "gates": [{ "alarms": ["prod-5xx"] }, { "run": "bash scripts/smoke.sh" }],
    "autoPromote": false,
    "windows": [{ "days": "mon-fri", "from": "09:00", "to": "22:00" }],
    "timezone": "Europe/London"
  }
}
```

The page shows a **Bake staging** stage after staging's stages, and a **Promote to prod** gate before prod's.

| Field | Default | What it does |
|---|---|---|
| `bake` | none | How long to watch the environment after it deploys: `"30s"`, `"15m"`, `"2h"` (a plain number is minutes). |
| `gates` | none | Health checks, below. One failed check fails the bake. |
| `rollback` | `true` | When a gate fails, roll this environment back to the build that was live there before, then pause the queue. `false`: only pause. |
| `autoPromote` | `true` | `false`: a build waits before this environment until you press **Promote** on the page. Before the first environment, that wait comes before the merge. |
| `windows` | any time | When builds may go into this environment. Outside them, a build waits at the door. `days` is like `"mon-fri"`, `"sat,sun"` or `"mon-wed,fri"` (default every day); `from` and `to` are 24-hour times. A window can run past midnight (`"22:00"` to `"06:00"`). |
| `timezone` | your machine's | The time zone for `windows`, like `"Europe/London"`. |

Each gate is one of:

| Gate | Fails when |
|---|---|
| `{ "alarms": ["name", ...], "region": "eu-west-1" }` | Any of these CloudWatch alarms (metric or composite) is in ALARM, or doesn't exist. Read with the AWS CLI (`aws cloudwatch describe-alarms`), signed in like your stages: the AWS profile the build used, or your default credential chain. No keys are kept by the app. `region` is optional. |
| `{ "url": "https://..." }` | The address does not answer with a 2xx or 3xx status within 10 seconds. |
| `{ "run": "command" }` | The command exits non-zero (or runs past 2 minutes). It runs in the build's folder with the build's sign-in, so it can check anything: Datadog, a smoke test, a database. |

A single failed check fails the gate. If you want retries or thresholds, write them in a `run` gate.

A check that can't run (the AWS sign-in ran out, the AWS CLI is missing, an alarm name has a typo) also stops the
promotion, but rolls nothing back: it says nothing about the app's health. Fix it, then **Retry** the bake stage. The
Live card shows the build as "health not checked" meanwhile.

**What happens when a gate fails:** the stages after it don't run, and that environment is rolled back to the build
that was live in it before (if there was one; if not, or with `"rollback": false`, the build stays and its Live
card shows it failed its health gates): a new build marked "rollback to #N", which rebuilds that build's commit
and runs only that environment's deploy stages, with no bake and no waits. Other environments keep what they have. The
queue pauses, as for any rollback: revert the bad change on GitHub, then **Resume queue**.

**Blocking an environment.** Press **Block deploys** on an environment's Live card and say why (a code freeze, an
incident). Builds wait before that environment, showing the reason, until you press **Unblock**. A block is kept across
restarts. A block, a deploy window or a Promote wait holds the deploy lane, so the builds queued behind it wait too.
Rollbacks are not held.

Agents (`mcp.mjs`) can't promote, block or unblock: those stay clicks on the page.

A pull request can't loosen these rules: `environments` comes from your own checkout, and while it has any, a build
whose pipeline.json deploys to a different set of environments (say it renames `prod`) is refused. Merge such a change
by hand, then restart the app.

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
  - On a retry, `CICD_RESUME_FROM` and `CICD_PASSED_STEPS`: see "Resuming a retried stage" in the
    [README](../README.md#resuming-a-retried-stage).

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
