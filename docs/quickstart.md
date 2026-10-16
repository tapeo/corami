# Quick start

From nothing to a live preview of your own project, reachable from your phone.

You need:

- a Linux server with a public IPv4 (a small VPS is fine: 2 vCPU, 4 GB of RAM, 40 GB of disk start to be comfortable; 4 vCPU and 8 GB if the server also builds Android apps)
- a [Tailscale](https://tailscale.com) account, free for personal use
- a laptop as your client, and optionally a phone
- the toolchain your project needs (Node, pnpm, Flutter...), installed on the machines where it will run. Corami does not install those for you

## Index

- [1. Server](#1-server)
- [2. Your first project](#2-your-first-project)
- [3. Your agent, always on](#3-your-agent-always-on)
- [4. Your laptop, with the code on disk](#4-your-laptop-with-the-code-on-disk)
- [5. A preview with an address](#5-a-preview-with-an-address)
- [6. Verifying what an agent produced](#6-verifying-what-an-agent-produced)
- [7. Backup](#7-backup)
- [Keeping up to date](#keeping-up-to-date)
- [When something does not work](#when-something-does-not-work)
- [Where to go next](#where-to-go-next)

## 1. Server

```bash
ssh root@your-server
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

The installer downloads the binary to `~/.corami/bin`, checks its sha256, adds that folder to the PATH in `~/.bashrc` and runs `corami setup`, which asks what the machine is: answer server. The setup is idempotent and can be re-run; `--step <name>` runs a single step. When a step fails it says why and offers to try it again.

1. It installs Tailscale if needed and shows a login link: open it and approve the machine. The setup waits for the approval and goes on.
2. It proposes your Tailscale login as the owner, the only account that can reach the daemon. The daemon answers only to the owner; previews are reachable by everyone in the tailnet, so in a shared tailnet restrict them with an ACL rule.
3. It offers to close public SSH, keeping only the tailnet. From then on you enter with `ssh root@your-server.<your-tailnet>.ts.net`, or from the provider console. The default is no, and `corami setup server --firewall` does it later.
4. It publishes the daemon over HTTPS. That needs the HTTPS certificates enabled in the Tailscale admin console, once per tailnet: if they are not, the step fails with the link to that page and offers to try again. Previews need HTTPS because a browser treats plain HTTP on any name that is not `localhost` as insecure, which disables service workers, camera access, geolocation, the clipboard and `crypto.subtle`.
5. It installs the daemon (`corami-daemon`) and the git alignment service (`corami-git-watch`) as systemd user services, and publishes the daemon at `https://<machine>.<your-tailnet>.ts.net:7420`.

From a new shell, check:

```bash
corami doctor          # network, HTTPS, tools, services
corami --version
```

## 2. Your first project

A project is added to the server once. From a git remote, on any machine:

```bash
corami project add git@github.com:me/myapp.git
```

For a private repository, run `corami setup git` on the server first: it creates the SSH key of the server and tells you where to add it. A project that lives only on your laptop comes over with `corami project import` instead ([section 4](#4-your-laptop-with-the-code-on-disk)), and a folder already on the server with `corami project add --path <folder>`.

That is all: there is no configuration file to write. The project lives in `~/corami/projects/myapp` on the server, and every client takes its own copy with `corami sync myapp`.

## 3. Your agent, always on

Corami does not install an agent for you, and it is not one. Install whatever you use on the server and reach it from your devices. The shape is always the same: bind the agent to `127.0.0.1`, publish that port with `tailscale serve`, keep it alive with a systemd user service.

Example with [opencode](https://opencode.ai):

```bash
curl -fsSL https://opencode.ai/install | bash     # on the server
opencode auth login                               # pick your provider
```

Then run it as your user service and publish it:

```bash
systemctl --user enable --now opencode-serve     # unit you create once, see below
tailscale serve --bg --https=4096 http://127.0.0.1:4096
```

A minimal unit, in `~/.config/systemd/user/opencode-serve.service`:

```ini
[Unit]
Description=opencode serve
After=network-online.target

[Service]
ExecStart=/root/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4096
Environment=OPENCODE_SERVER_PASSWORD=change-me
Restart=on-failure

[Install]
WantedBy=default.target
```

From any client, in a terminal: `opencode attach https://your-server.<your-tailnet>.ts.net:4096`. Any web UI on top of it opens in the browser, phone included.

Keep the harness on the server, not on the laptop: the sessions stay there, so you can close the laptop half way through a task and find the work again from another device. A harness running on a client has sessions that live only on that client.

Remember that a port published with `tailscale serve` is reachable by everyone in your tailnet. A tailnet used only by you is fine; otherwise restrict access with a Tailscale ACL, and set the agent password above.

## 4. Your laptop, with the code on disk

First install [Tailscale](https://tailscale.com/download) on the laptop and sign in with the same account: `tailscale status` must list the server. Corami does not install Tailscale on a client. On macOS, if the `tailscale` command is missing, turn on the command line integration in the app settings, or use `brew install tailscale`.

```bash
# on the laptop
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

The installer adds `~/.corami/bin` to the PATH (`~/.zshrc` on macOS, `~/.bashrc` on Linux) and runs `corami setup client` (on Linux it first asks what the machine is: answer client). It looks in your tailnet for the server and asks you to confirm it, then checks the daemon and SSH to the server, installs Mutagen, and installs two services: the Mutagen daemon, so that the sync starts again by itself after a reboot, and the git alignment service. On macOS they are the launchd agents `io.mutagen.mutagen` and `dev.corami.git-watch`. Then, in a new terminal:

```bash
corami sync myapp
```

`corami sync` keeps `~/corami/myapp` in sync with the server, in both directions, and gives the copy its own `.git`: a clone of `origin` on the same branch as the server, made with the git credentials of the laptop. If the clone fails the files are synced anyway, and `corami sync myapp` run again retries it. Run `corami sync` once for every project you want on this machine.

A project that only exists on your laptop comes over with:

```bash
corami project import ~/dev/other-app
```

The local folder becomes the synced copy, with a backup next to it. The repository history, tags and stashes arrive on the server, and the local copy keeps its own `.git`, so you can commit on either side. Files that look like keys stay on this machine, in the backup folder.

Both sides keep their own `.git`, are equals, and follow only `origin`. The `corami git watch` service runs on the server and on every client: it makes a round at startup and then one every minute, fetches `origin`, and when it is behind, with the files already delivered by the sync, moves its `HEAD` without touching the files. Pushing is a human act: `git push` from the side that has the commits, and the other side follows after the push. If you are curious, or you need to fix something by hand:

```bash
corami sync status                 # both sides against origin, for every local copy
corami git watch --once myapp      # one alignment round, in the foreground
git push                           # publish from the side that has the commits
```

A commit that is only on one side arrives on the other after the push. For a commit that came from somewhere else, like a pull request merged on GitHub, run `git pull --ff-only` on the server: the files are not on either side yet, so the alignment picks them up at the next round, when the sync has delivered them.

### Picking up from another machine

Every file you save reaches the server within seconds, so when you turn a machine off your work is already there, committed or not. On the next machine:

```bash
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
corami sync myapp
```

The files arrive, uncommitted changes included, and the copy gets its own `.git` on the branch of the server. From there it follows `origin` like any other side. Dependencies, build outputs and secret files (`.env`, keystores) are not synced: run the install command of the project on this machine when it is needed.

## 5. A preview with an address

On the server, start the dev server and give it an address:

```bash
# on the server
cd ~/corami/projects/myapp
systemd-run --user --unit myapp-web --collect \
  pnpm exec next dev -H 127.0.0.1 -p 3000
corami serve 3000
```

```json
{
  "ok": true,
  "data": {
    "project": "myapp",
    "name": "web",
    "public_port": 4100,
    "target_port": 3000,
    "url": "https://corami.tail1a2b3c.ts.net:4100",
    "responding": true
  }
}
```

Open that URL from any device in your tailnet, phone included. It is HTTPS, so the browser treats it as a secure context. The address is stable: if the dev server moves to another port, `corami serve <new-port>` moves the rule and the URL stays the same. `corami serve ls` lists the addresses, `corami serve rm web` removes one.

A background command of the harness shell dies with the session: that is why the example starts the dev server as a user service (`journalctl --user -u myapp-web -f` for the logs). With Docker Compose, `docker compose up -d` is already enough. All the rules are in [previews.md](previews.md).

## 6. Verifying what an agent produced

The preview is a normal HTTPS page, so it is verified where every other page is: in the browser of your harness, or with a browser tool the harness offers (a Playwright or chrome-devtools MCP, for example). Console, network and screenshots come from there, and the agent can click, fill forms and log in, which a one-shot checker cannot do.

To give the agent the same picture, copy this into the `AGENTS.md` of the project, with the project name in place of `<project>`:

```markdown
## Corami environment

- The project lives on the server, synced with every client. The dev server runs on the server, not on this machine: `systemd-run --user --unit <project>-web --collect pnpm exec next dev -H 127.0.0.1 -p 3000`.
- Give the preview an address: `corami serve 3000` (from `~/corami/projects/<project>`), then read `url` from the JSON. `corami serve ls` lists the addresses.
- After every UI change, open that URL with the browser of this harness (or a browser tool it offers) and read the console and the failed requests there, then take the screenshot. The page is in a secure context because the address is HTTPS.
- Builds run where the tools are: on the server, or on a client over SSH. See docs/builds.md in the Corami repository.
```

## 7. Backup

Corami does not back anything up: the server is backed up with the tools you prefer, a snapshot of the provider or restic with a timer. The projects, the configuration and the SSH keys of the server are worth saving; what to leave out and how to restore on a new server are in [backup.md](backup.md).

One thing to know: a project that no client ever synced exists only on the server, uncommitted work included. Sync it once from your laptop, or include the server in the backup.

## Keeping up to date

```bash
corami update --check
corami update
```

On the server, `corami update` restarts the daemon. The dev servers running as user services or containers are not touched: they keep running.

## When something does not work

| Symptom | Where to look |
|---|---|
| `server_unreachable` from a client | `corami doctor net` on the server; is Tailscale up on both sides? |
| The preview does not open | `corami serve ls`: does it answer? `journalctl --user -u <project>-web` |
| A page loads half styled | The dev server needs the Tailscale name in its allowed origins, e.g. `allowedDevOrigins` in Next.js ([previews.md](previews.md#dev-servers-that-check-the-host-header)) |
| The preview answers on the wrong port | `corami serve <port>` again: the URL stays the same |
| Nothing listens on the target port | The JSON of `corami serve` says which port; check the service with `journalctl --user -u <project>-web` |
| Slow transfers between client and server | `tailscale status` says whether the connection is direct or through a relay |

## Where to go next

- [CLI reference](cli.md)
- [Previews](previews.md) and [Builds](builds.md)
- [Architecture](architecture.md)
