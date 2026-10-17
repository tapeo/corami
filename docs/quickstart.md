# Quick start

From nothing to an agent working on your project, with a live preview you open from your phone.

You need:

- a Linux server with a public IPv4, Ubuntu 22.04+ or Debian 12+. A small VPS is fine: 2 vCPU, 4 GB of RAM and 40 GB of disk start to be comfortable, 4 vCPU and 8 GB if it also builds Android apps
- a [Tailscale](https://tailscale.com) account, free for personal use
- a laptop, and optionally a phone
- the toolchain of your project (Node, pnpm, Flutter...) on the machines where it runs: Corami does not install it

## Index

- [1. Server](#1-server)
- [2. Laptop](#2-laptop)
- [3. Your first project](#3-your-first-project)
- [4. Your agent, always on](#4-your-agent-always-on)
- [5. A preview on your phone](#5-a-preview-on-your-phone)
- [Picking up from another machine](#picking-up-from-another-machine)
- [Keeping up to date](#keeping-up-to-date)
- [Backup](#backup)
- [When something does not work](#when-something-does-not-work)

## 1. Server

```bash
ssh root@your-server
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

Answer `server` when it asks what the machine is. The setup shows a Tailscale login link: open it and approve the machine, and the setup goes on by itself. The proposed answers to the other questions are fine.

If it stops at the HTTPS step, enable the HTTPS certificates in the Tailscale admin console (DNS page), once per tailnet, and let it try again. Previews need HTTPS: on any name that is not `localhost`, a browser disables service workers, the camera and the clipboard over plain HTTP.

The setup creates the account `corami`, which owns the projects, the agents and the previews. From now on you work as that account, over the tailnet:

```bash
ssh corami@your-server.<your-tailnet>.ts.net
corami doctor
```

What each step of the setup does, and how to run one again: [CLI reference](cli.md#setup).

## 2. Laptop

Install [Tailscale](https://tailscale.com/download) and sign in with the same account: `tailscale status` must list the server. On macOS, if the `tailscale` command is missing, turn on the command line integration in the app settings, or use `brew install tailscale`. Then:

```bash
# macOS and Linux
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

```powershell
# Windows: put Mutagen in the PATH first
irm https://github.com/tapeo/corami/releases/latest/download/install.ps1 | iex
```

The setup finds the server in your tailnet and asks you to confirm it. Open a new terminal and run `corami doctor`.

## 3. Your first project

Pick the line that matches where the project is today:

```bash
corami project add --local-path ~/dev/myapp                    # only on this laptop, uncommitted work included
corami project add --from-git git@github.com:me/myapp.git --local-path ~/dev/myapp   # on GitHub, GitLab or another git remote
corami project add --from-server --name myapp --local-path ~/dev/myapp # on another client: the project is already on the server
```

Every line ends with the same two things: the project on the server, in `~/projects/myapp`, and the synced copy of this laptop in the folder you give with `--local-path`. The first line has no source flag because this machine is where the project is: the folder itself moves to the server, keys and env files included, and leaves a backup next to it, so a build or a preview on the server has what the laptop has. `--from-git` clones the repository and then creates the copy here. In a terminal, a missing flag is asked with a value already written, so you can change it as you read it. Run `--from-git` from a folder that is already a clone of the repository and the command stops instead, pointing at the folder itself: the project is already here, and moving that folder is what makes it the copy.

That is all: no configuration file. The project lives in `~/projects/myapp` on the server, and every file you save on either side reaches the other within seconds. Dependencies and build outputs (`node_modules`, `build`, `Pods`...) are not synced: each machine regenerates them. Everything else is, keys and env files included: if a key must not travel, keep it out of the folder, or inject it from a secret manager.

For a private repository, run `corami setup git` on the server first: it creates the key of the server and tells you where to add it. Both sides keep their own `.git` and follow `origin`; how commits move between them is in the [CLI reference](cli.md#sync).

## 4. Your agent, always on

Install the agent on the server, not on the laptop: its sessions live there, so you can close the laptop half way through a task and pick it up from any device. Any harness works, and the shape is always the same: a service on `127.0.0.1`, published to your tailnet with `tailscale serve`.

With [opencode](https://opencode.ai), as `corami` on the server:

```bash
curl -fsSL https://opencode.ai/install | bash
opencode auth login                               # pick your provider
```

Create the unit once, in `~/.config/systemd/user/opencode-serve.service`:

```ini
[Unit]
Description=opencode serve
After=network-online.target

[Service]
ExecStart=/home/corami/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4096
Environment=OPENCODE_SERVER_PASSWORD=change-me
Restart=on-failure

[Install]
WantedBy=default.target
```

Start it and publish it:

```bash
systemctl --user enable --now opencode-serve
tailscale serve --bg --https=4096 http://127.0.0.1:4096
```

From the laptop: `opencode attach https://your-server.<your-tailnet>.ts.net:4096`. A web UI on top of it, such as OpenChamber, takes the same steps with its own port and opens in the browser, phone included. Terminal-only harnesses, such as Claude Code, run over SSH on the server, inside tmux.

A port published with `tailscale serve` is reachable by everyone in your tailnet. A tailnet used only by you is fine; otherwise restrict access with a Tailscale ACL, and keep the password of the agent.

### Tell the agent about Corami

Copy this into the `AGENTS.md` of the project, with the project name in place of `<project>`:

```markdown
## Corami environment

- The project lives on the server, synced with every client. The dev server runs on the server, not on this machine: `systemd-run --user --unit <project>-web --collect pnpm exec next dev -H 127.0.0.1 -p 3000`.
- Give the preview an address: `corami serve 3000` (from `~/projects/<project>`), then read `url` from the JSON. `corami serve ls` lists the addresses.
- After every UI change, open that URL with the browser of this harness (or a browser tool it offers) and read the console and the failed requests there, then take the screenshot. The page is in a secure context because the address is HTTPS.
- Builds run where the tools are: on the server, or on a client over SSH. See docs/builds.md in the Corami repository.
```

Corami ships no checker of its own: the preview is a normal HTTPS page, and the browser of the harness, or a Playwright or chrome-devtools MCP, can click, fill forms and log in.

## 5. A preview on your phone

On the server, start the dev server as a user service, so it survives the agent session, then give it an address:

```bash
cd ~/projects/myapp
systemd-run --user --unit myapp-web --collect pnpm exec next dev -H 127.0.0.1 -p 3000
corami serve 3000
```

```
https://your-server.tail1a2b3c.ts.net:4100 -> http://127.0.0.1:3000
responding on port 3000
```

Open that address from any device in your tailnet, phone included. It is stable: if the dev server moves to another port, `corami serve <new-port>` keeps the same URL, so bookmarks keep working. `corami serve ls` lists the addresses. The rules a dev server must follow, Docker included, are in [previews.md](previews.md).

## Picking up from another machine

Every file you save reaches the server within seconds, so when you close the laptop your work is already there, committed or not. On another computer, install Corami as in [step 2](#2-laptop), then:

```bash
corami project add --from-server --name myapp --local-path ~/dev/myapp
```

The files arrive in that folder, uncommitted changes included, and the copy gets its own `.git` on the branch of the server. Run the install command of the project when you need the dependencies.

## Keeping up to date

`corami update` on every machine. On the server it restarts the daemon; the dev servers keep running.

## Backup

Corami does not back anything up. A project that no client ever synced exists only on the server, uncommitted work included: sync it once from your laptop, or back up the server. What to save and how to restore: [backup.md](backup.md).

## When something does not work

Start with `corami doctor`: it says what is missing and the step that fixes it.

| Symptom | Where to look |
|---|---|
| `server_unreachable` from a client | `corami doctor net` on the server; is Tailscale up on both sides? |
| The preview does not open | `corami serve ls`: does it answer? `journalctl --user -u <project>-web` |
| A page loads half styled | The dev server needs the Tailscale name in its allowed origins, e.g. `allowedDevOrigins` in Next.js ([previews.md](previews.md#dev-servers-that-check-the-host-header)) |
| The preview answers on the wrong port | `corami serve <port>` again: the URL stays the same |
| Slow transfers between client and server | `tailscale status` says whether the connection is direct or through a relay |

Next: [builds](builds.md) on the server or on the Mac over SSH, and the [CLI reference](cli.md).
