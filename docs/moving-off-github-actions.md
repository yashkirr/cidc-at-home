# Moving off GitHub Actions

Most workflows are a list of shell commands with some setup around them. Here is how the usual parts map across.

| GitHub Actions | Here |
|---|---|
| `on: pull_request` checks | Build stages. You run them on a batch of pull requests when you press Build. |
| `on: push` to main, deploy job | Deploy stages, after a green build. |
| `workflow_dispatch` (run by hand) | Build with no pull requests ticked, then Deploy. |
| `run:` steps | One stage each, or one script with `== Step` lines. |
| `actions/checkout` | Done for you: stages run in the batch. |
| `actions/setup-node`, `setup-python` and so on | Install the tool once on your machine. |
| `actions/cache` | Not needed for ignored folders: the private copy keeps them between builds. |
| Secrets (`${{ secrets.X }}`) | Your own sign-ins: `~/.aws`, `gh`, `gcloud`, a password manager CLI, or environment variables in the terminal you start the app from. Never put them in `pipeline.json`. |
| OIDC role to AWS | An AWS profile on your machine (type its name in the page). |
| Matrix builds | Separate stages, or a loop in a script. |
| `schedule:` (cron) | Not built in. Use cron or launchd to call your script, or just build when you need to. |
| Status checks on the pull request | The page. Pull requests on GitHub show no tick from this. |

## A worked example

This workflow:

```yaml
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

plus a deploy workflow on push to main that runs `./scripts/deploy.sh`, becomes:

```json
{
  "build": [
    { "name": "Install", "run": "npm ci" },
    { "name": "Checks", "run": "echo '== Lint'; npm run lint && echo '== Tests'; npm test" },
    { "name": "Build", "run": "npm run build" }
  ],
  "deploy": [
    { "name": "Deploy", "run": "./scripts/deploy.sh" }
  ]
}
```

## Step by step

1. **List what your workflows run.** Open each file in `.github/workflows/` and write down the `run:` lines and what
   each `uses:` does.
2. **Turn them into scripts** in your repo, such as `scripts/check.sh` and `scripts/deploy.sh`. Make each one print
   `== Name` before each part. Run them from a terminal until they pass.
3. **Write `pipeline.json`** that calls the scripts.
4. **Build once** with no pull requests ticked and compare with your last green Actions run: same steps, same results.
5. **Turn off the triggers** you no longer want. Keep `workflow_dispatch:` on a workflow if you'd like a way to run it
   on GitHub by hand later. Delete the rest.
6. **Scheduled jobs:** move them to cron, or a scheduled task on your server, calling the same scripts.

## Tips

- Keep the scripts runnable on their own. The app is a nicer way to run them, not the only way.
- If a step needs to differ between your machine and CI, read `CI=1`, which every stage gets.
- Make build stages produce what deploy needs (a build folder, a plan file), and have deploy stages use those
  rather than building again. Then what you deploy is exactly what you tested.
