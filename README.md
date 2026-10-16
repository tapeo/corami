# Corami

![Corami: an always-on Linux server runs the agent, with projects, previews and git, while macOS, iOS, Windows and Linux clients keep a full local copy in two-way sync. Close the lid whenever: no commit needed, every save is already on the server.](docs/assets/corami-header-synced-no-commit.png)

Corami is a remote dev host for AI agents. A Linux server holds your projects and keeps your agents running, always on. Every machine you work from keeps a real copy of the project on its own disk, synced with the server in both directions, in real time. Your editor, your terminal and your builds run at local speed, and your work never lives on one laptop only. Corami sits under your harness, it is not one: OpenCode, OpenChamber, Claude Code or anything else, installed on the server and reached from every device.

## Why

- **It feels local because it is local.** Every client has the project on its own disk: open it in your editor, run the tests, build with Xcode. No remote filesystem, no lag.
- **Everything is synced, both ways, all the time.** A file you save on your laptop reaches the server within seconds; a file the agent writes on the server reaches your laptop just as fast. Once a commit is pushed, every other side moves to it within a minute, without touching your files.
- **Turn off your computer and keep going.** By the time you shut it down, your files are already on the server. Open another client, run `corami sync myapp`, and the same files are there, uncommitted work included. The agent keeps working while your laptop sleeps, and its sessions and the previews stay reachable from any device, phone included.
- **Previews with an address, not a tunnel.** The dev server runs on the server and `corami serve` gives it a stable HTTPS address on your tailnet: open it from the Mac, from the phone, from anywhere, and keep it in bookmarks.
- **Builds run where the tools are.** On the server for most projects, over SSH on the Mac when only Xcode can do it. Corami keeps the code aligned on every side; the command is yours.

The sync leaves out dependencies and build outputs (`node_modules`, `build`, `Pods`...): each machine regenerates them. Files that look like secrets (`.env`, keystores) never enter the sync. Changes saved while a machine is offline travel as soon as it is back online.

## How it works

```
                 ┌──────────────── Linux server (always on) ────────────────────┐
                 │ corami daemon · projects (source of truth) · previews        │
                 │ your agent, installed by you                                 │
                 └──────▲──────────────────▲────────────────────▲──────────────┘
                        │ Tailscale        │ Tailscale SSH       │
                        │ (HTTPS)          │ (Mutagen)           │
   phone ───────────────┘      macOS ──────┘       Linux/Windows┘
   browser: agent UI,           synced copy,         synced copy,
   previews                     builds (Xcode)       builds
```

`corami` is one binary: the CLI on every machine and the daemon on the server, compiled from the same TypeScript source. The daemon keeps the project registry and the preview addresses, and it binds to `127.0.0.1`, published over HTTPS with `tailscale serve`: nothing is on the public internet and it answers only to the owner. Project files travel with Mutagen over Tailscale SSH, in both directions; conflicts that cannot be solved without losing data are held and reported, never overwritten.

It is early, and it works end to end on a real VPS with a macOS client. Details in [docs/architecture.md](docs/architecture.md).

## Requirements

- A Linux server with a public IPv4 (Ubuntu 22.04+ or Debian 12+). A small VPS is fine: 2 vCPU, 4 GB of RAM and 40 GB of disk start to be comfortable, 4 vCPU and 8 GB if the server also builds Android apps.
- A [Tailscale](https://tailscale.com) account, free for personal use, with HTTPS certificates enabled in the admin console (DNS page), once per tailnet.
- A client on macOS, Linux or Windows. Optionally a phone or tablet.

## Install

The binary comes from the [GitHub releases](https://github.com/tapeo/corami/releases), through `install.sh`, and updates with `corami update`. It is not published on npm: `package.json` only serves development.

### 1. Server

On a fresh server, as root:

```bash
ssh root@your-server
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

The script puts `corami` in `~/.corami/bin` and asks what the machine is: answer server. The setup installs Tailscale and shows a login link: open it and approve the machine, the setup waits and goes on. It proposes your Tailscale login as the only account allowed to reach the daemon, creates the account `corami`, which owns the projects and runs the services, offers to close public SSH, installs the services and publishes the daemon at `https://<machine>.<your-tailnet>.ts.net:7420`.

From then on you work as `corami`, and enter with `ssh corami@your-server.<your-tailnet>.ts.net`: the projects, the agents and the services belong to that account. Root stays for the machine only: the packages of the toolchain, the provider console.

### 2. Client

Install [Tailscale](https://tailscale.com/download), sign in with the same account and check that `tailscale status` lists the server. On macOS, if the command is missing, turn on the command line integration in the app settings, or install it with `brew install tailscale`. Then:

```bash
# macOS and Linux
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
```

```powershell
# Windows: put Mutagen in the PATH first
irm https://github.com/tapeo/corami/releases/latest/download/install.ps1 | iex
```

The client setup looks in your tailnet for the server and asks you to confirm it, then installs Mutagen and the services. Both setups can be re-run at any time, and when a step fails they say why and offer to try it again. Without a terminal, from a script or an agent, they ask nothing and take their options as flags: `corami setup server --owner <login>`, `corami setup client <server>` ([CLI reference](docs/cli.md#setup)).

### 3. Doctor

Open a new terminal and run `corami doctor`: it reports what is missing and the step that fixes it. Phones and tablets install nothing: the Tailscale app and a browser are enough. `corami update` on every machine keeps them current.

## Start a project

A project is added once, to the server, which keeps it from then on; every client then takes its own local copy. Pick the command that matches where the project is today, then take the copy:

```bash
corami project add git@github.com:me/myapp.git   # on GitHub, GitLab or another git remote (from any machine)
corami project import ~/dev/myapp                # only on this computer, uncommitted work included
corami project add --path ~/code/myapp           # already in a folder on the server

corami sync myapp                                # on every client: ~/corami/myapp, synced both ways
```

The paths are always the same: `~/projects/<name>` on the server, `~/corami/<name>` on every client. For a private repository, run `corami setup git` on the server first and add its SSH key to GitHub, GitLab or Bitbucket.

### Your agent

Install the harness on the server and use it from any device: it is where the sessions live, so they are there when you close the laptop, half way through a task. Any harness works; the shape is always the same: a service on `127.0.0.1` and a `tailscale serve` rule. With opencode:

```bash
# on the server
opencode auth login
systemctl --user enable --now opencode-serve      # a unit you create once
tailscale serve --bg --https=4096 http://127.0.0.1:4096
```

```bash
# from a client
opencode attach https://<machine>.<your-tailnet>.ts.net:4096
```

### Day by day

```bash
corami serve 3000              # on the server: a stable HTTPS address for the dev server on 3000
corami serve ls                # the addresses, and whether something answers
corami sync status             # both sides against origin, for every local copy
```

Corami starts no project process: start the dev server as a user service of the server, so it survives the harness session, then give it an address. The rules and the details are in [docs/previews.md](docs/previews.md); builds, on the server or on the Mac over SSH, are in [docs/builds.md](docs/builds.md); a backup of the server, with your own tools, is in [docs/backup.md](docs/backup.md).

Every command takes `--json`, and without a terminal that is the default. The UI is verified with the browser of the harness, or with a browser tool the harness offers: Corami ships no checker of its own.

## Documentation

- [Quick start](docs/quickstart.md)
- [CLI reference](docs/cli.md)
- [Previews](docs/previews.md): a dev server with an HTTPS address
- [Builds](docs/builds.md): on the server, or on a client over SSH
- [Backup](docs/backup.md): what to save and how
- [Architecture and implementation details](docs/architecture.md)
- [Development](docs/development.md)
- [Ideas for v2](docs/v2/README.md)

Corami is released under the [Functional Source License](https://fsl.software), version 1.1, with Apache 2.0 as the future license (FSL-1.1-ALv2), see [LICENSE](LICENSE). You can use, modify and share it for any purpose except offering a competing commercial product or service. Each version becomes Apache 2.0 two years after its release. Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).
