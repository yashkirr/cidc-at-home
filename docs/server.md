# Running it on a server

You can run the app on a VPS or any always-on machine, so builds don't depend on your laptop being open.

The app only listens on `127.0.0.1`, on purpose: whoever can open the page can deploy. So don't open a port for it.
Reach it through an SSH tunnel instead.

## Set up the server

1. Install Node.js 22, git and the GitHub CLI. Sign in with `gh auth login`.
2. Install whatever your stages need (npm, docker, your cloud CLI) and sign in to those too.
3. Clone your repo and this one:

   ```sh
   git clone https://github.com/you/your-repo.git ~/your-repo
   git clone https://github.com/yashkirr/cidc-at-home.git ~/cidc-at-home
   ```

4. Start it so it keeps running after you log out. With tmux:

   ```sh
   tmux new -s cicd 'PIPELINE_NO_OPEN=1 ~/cidc-at-home/start.sh ~/your-repo'
   ```

   Or as a systemd user service, `~/.config/systemd/user/cicd-at-home.service`:

   ```ini
   [Unit]
   Description=CI/CD at home

   [Service]
   Environment=PIPELINE_NO_OPEN=1
   ExecStart=%h/cidc-at-home/start.sh %h/your-repo
   Restart=on-failure

   [Install]
   WantedBy=default.target
   ```

   Then `systemctl --user enable --now cicd-at-home` and `loginctl enable-linger $USER` so it runs without you logged in.

## Open it from your laptop

```sh
ssh -N -L 4321:localhost:4321 you@your-server
```

Leave that running and open http://localhost:4321/ on your laptop. The page works as if the app were local.

## Deploying to the same server

If the server is also where your app runs, a deploy stage can restart it directly, for example:

```json
{ "name": "Restart", "run": "docker compose up -d --build" }
```

See [examples/vps-docker-compose.json](../examples/vps-docker-compose.json) and
[examples/vps-rsync.json](../examples/vps-rsync.json).

## Things to know

- Restarting the app forgets the current run (the page goes back to "Waiting"). The repo list and the private copies
  stay.
- Only one run at a time. Two people pressing Build at once get "Something is already running".
