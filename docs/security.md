# Security

This app can merge pull requests and deploy to production, using whatever is signed in on the machine it runs on.
Treat the page like a deploy key.

## What it does to stay safe

- **Local only.** It listens on `127.0.0.1`, never on a network address. On a server, reach it with an SSH tunnel
  ([server.md](server.md)).
- **Other websites can't drive it.** Every action needs a secret token that is made fresh each time the app starts
  and is only in the page it serves. Other sites can't read that page. The app also refuses requests whose `Host` is
  not `localhost` or `127.0.0.1` on its port, which stops DNS rebinding.
- **Agents get their own key.** The app writes its port and an agent-only token to `~/.cicd-at-home/mcp.json`,
  readable only by you, for `mcp.mjs` (Claude Code's connection). That token can read the pipeline, build, retry a
  failed stage and resume the queue. The app refuses anything else from it (deploy, rollback, stop, queue changes,
  repos), whatever sends it. Anything running as you can read that file, the same as it can read your other sign-ins.
- **Agent audit trail.** Every call made with the agent token, allowed or refused, is appended to
  `~/.cicd-at-home/agent-log.jsonl` (readable only by you) and shown under Agent activity. The agent's name is what its
  MCP client reports, so it says which tool acted, not proof of who. The log is plain text: anything running as you
  could edit it.
- **No fork pull requests.** Only pull requests from branches in the same repo are listed. Fork pull requests would let
  anyone on GitHub run code on your machine.
- **No drafts.** Draft pull requests can't be picked.
- **Nothing untested is merged.** Each merge on GitHub is pinned to the exact commit that was tested. If someone pushed
  after the build, GitHub refuses the merge.
- **Nothing unmerged is deployed.** Deploy only runs after main on GitHub has exactly the tested files.
- **Same sign-in for build and deploy.** The deploy uses the AWS profile the build used, whatever the box says later.
- **Stops cleanly.** Closing the app stops a running stage, so a deploy never carries on unseen.

## What it trusts

- **Your pull requests.** A pull request's code, and its `pipeline.json`, run on your machine with your sign-ins
  (GitHub, cloud, SSH keys). That is the same trust GitHub Actions gives a pull request from your own repo with
  secrets. Only tick pull requests you have read, from people you trust.
- **The machine.** Anyone with a shell on it can use your sign-ins anyway.
- **`gh`.** Merges happen as whoever is signed in to the GitHub CLI.

## Keeping secrets out of your repo

- Never put keys or passwords in `pipeline.json`. It is committed to your repo.
- Let tools use their own sign-in (`~/.aws`, `gh auth`, `gcloud auth`, `docker login`), or read secrets in your scripts
  from a secret store at run time.
- Stage logs show whatever your commands print. Don't echo secrets.

## Reporting a problem

Open an issue on this repo. For anything sensitive, please don't put details in a public issue; ask for a private
contact first.
