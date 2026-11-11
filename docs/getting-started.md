# Getting started

## What you need

- **Node.js 22 or newer.** Check with `node -v`.
- **git.**
- **GitHub CLI**, signed in: `gh auth login`. The app uses it to list pull requests and to merge them.
- **bash.** Mac and Linux have it. On Windows, run the app inside WSL.
- Whatever your own stages call: npm, docker, terraform, the AWS CLI, rsync, and so on.

There are no npm packages to install. The app is one Node file and one HTML page.

## Start it

```sh
git clone https://github.com/yashkirr/cidc-at-home.git
cd cidc-at-home
./start.sh /path/to/your/repo
```

- **Mac:** double-click `start.command`. The first time, macOS may ask if you want to open it: say yes.
- **Anywhere:** `./start.sh`, or `npm start`, or `node server.mjs`.

The page opens at http://localhost:4321/. To use another port: `PIPELINE_PORT=5000 ./start.sh`.
To stop the browser opening by itself: `PIPELINE_NO_OPEN=1 ./start.sh`.

The terminal window must stay open. Closing it stops the app, and stops any stage that is running.

## Add your repos

The path you start it with is added for you. To add more, type a repo folder into **Add repo** at the top of the
page. The app remembers them in `~/.cicd-at-home/repos.json` and lists them in the **Repo** menu.

Each repo needs a `pipeline.json` at its root. Start from one of the [examples](../examples/), then see the
[reference](pipeline-json.md).

## Your first build

1. Pick the repo.
2. Tick the pull requests you want in this release. Tick none to build main as it is.
3. Press **Build**.

The first build is slower: the app makes a private copy of your repo in `~/.cicd-at-home/work/` and your stages start
from nothing (fresh installs, empty caches). Later builds reuse that copy, so ignored folders such as
`node_modules` are still there.

Click any stage to see its log. A failed stage shows which step failed, and the log shows why.

## Deploy

When every build stage is green, **Deploy** unlocks. Press it and confirm. The app then:

1. merges the ticked pull requests on GitHub, in the order they were built,
2. checks that GitHub's main now has exactly the files that were tested,
3. runs your deploy stages.

Deploy unlocks once per green build. To deploy again, build again.

## The AWS profile box

If your stages use the AWS CLI or Terraform, type the name of a profile from `~/.aws/config` into the box. The app
sets `AWS_PROFILE` for every stage of the build and of the deploy that follows. Leave it empty if you don't use AWS
or use your default profile. It is only a name; no keys go through the page.
