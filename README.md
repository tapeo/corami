# Corami

![Corami: an always-on Linux server runs the agent, with projects, previews and git, while macOS, iOS, Windows and Linux clients keep a full local copy in two-way sync. Close the lid whenever: no commit needed, every save is already on the server.](docs/assets/corami-header-synced-no-commit.png)

Your coding agents run on an always-on Linux server. Every computer you use keeps a real copy of the code on its own disk, synced with the server in both directions, so you can close the laptop at any time and pick up from another device, phone included.

Corami is the host under your agent, not the agent: OpenCode, Claude Code or any other harness runs on the server, installed by you.

## A day with Corami

1. From the laptop you give the agent a task. The agent runs on the server.
2. You close the lid whenever, no commit needed: the files are always in sync, so every save is already on the server. The agent keeps working.
3. On the phone you open the preview at its HTTPS address and keep talking to the agent.
4. On another computer, `corami sync add myapp --path ~/dev/myapp` brings the same files, uncommitted work included.

## Why

- **It feels local because it is local.** The code is on your disk: the editor, the tests and Xcode run at local speed, with no remote filesystem.
- **The agent never stops.** Its sessions live on the server, not on a laptop that goes to sleep.
- **Previews with an address, not a tunnel.** `corami serve 3000` gives the dev server a stable HTTPS address on your tailnet: open it from any device and keep it in bookmarks.

Nothing is on the public internet: the server, the agent and the previews are reachable only through your [Tailscale](https://tailscale.com) network.

## Try it

You need a Linux server (a small VPS is fine), a Tailscale account, free for personal use, and a laptop.

```bash
# on the server, as root
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh

# on the laptop, signed in to the same Tailscale account
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
corami project import ~/dev/myapp     # the project moves to the server, the folder stays synced
```

The [quick start](docs/quickstart.md) goes through it step by step, then adds your agent and a preview you open from the phone.

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

`corami` is one binary: the CLI on every machine and the daemon on the server. Project files travel with [Mutagen](https://mutagen.io) over Tailscale SSH, which keeps every copy always in sync with the server; conflicts that cannot be solved without losing data are held and reported, never overwritten. Dependencies and build outputs (`node_modules`, `build`, `Pods`...) are not synced, each machine regenerates them, and files that look like secrets (`.env`, keystores) never enter the sync. Every command takes `--json`, the default without a terminal, so agents can drive it too.

## Status

Early: it works end to end on a real VPS with a macOS client. Binaries and updates come from the [GitHub releases](https://github.com/tapeo/corami/releases), and `corami update` keeps every machine current.

## Documentation

- [Quick start](docs/quickstart.md): from nothing to an agent and a preview on your phone
- [CLI reference](docs/cli.md)
- [Previews](docs/previews.md): a dev server with an HTTPS address
- [Builds](docs/builds.md): on the server, or on a client over SSH
- [Backup](docs/backup.md): what to save and how
- [Architecture](docs/architecture.md): how it is built
- [Development](docs/development.md)
- [Ideas for v2](docs/v2/README.md)

Corami is released under the [Functional Source License](https://fsl.software), version 1.1, with Apache 2.0 as the future license (FSL-1.1-ALv2), see [LICENSE](LICENSE). You can use, modify and share it for any purpose except offering a competing commercial product or service. Each version becomes Apache 2.0 two years after its release. Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).
