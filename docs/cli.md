# CLI reference

Commands of v1. They all accept `--json`. Without a TTY the output is JSON by default. Envelope and exit codes are in `architecture.md`.

## Index

- [Setup](#setup)
- [Projects](#projects)
- [Previews](#previews)
- [Sync](#sync)
- [Backup](#backup)
- [Output examples](#output-examples)

## Setup

| Command | Where | Description |
|---|---|---|
| `corami setup` | all | in a terminal: asks what the machine is, then runs the setup of that role |
| `corami setup server [--owner <login>] [--user <user>]` | server, as root | idempotent setup: Tailscale, the account that owns the projects, HTTPS, the `corami-daemon` and `corami-git-watch` services |
| `corami setup server --firewall` | server | closes public SSH: you enter with Tailscale SSH |
| `corami setup server --step <step>` | server | runs a single step: `preflight`, `packages`, `tailscale`, `hosts`, `user`, `firewall`, `daemon`, `git-watch`, `serve`, `summary` |
| `corami setup client [server] [--user <user>]` | client | idempotent setup: checks Tailscale, daemon and SSH, installs Mutagen, the Mutagen daemon service and `corami-git-watch`, saves the configuration |
| `corami setup client <server> --step <step>` | client | runs a single step: `tailscale`, `daemon`, `ssh`, `mutagen`, `mutagen-daemon`, `config`, `git-watch` |
| `corami setup git [--provider github\|gitlab\|bitbucket]` | server, as the account | SSH key of the server, check and rewriting of HTTPS remotes |
| `corami doctor [area]` | all | checks with remedies. Areas: `net`, `tools`, `git`, `server` |
| `corami update [--check]` | all | updates the binary from the GitHub release, with a sum check; on the server it restarts the daemon, and as root it also replaces the binary of the account |

In a terminal the setups ask what the flags do not say, and only that:

- `corami setup` without a role asks for it. Outside Linux the machine can only be a client.
- `corami setup server` waits for the approval of the Tailscale login link instead of stopping, proposes the Tailscale login of the server as the owner when `--owner` is missing and none is saved, and offers to close public SSH when Tailscale SSH is on and the firewall is not in place yet.
- `corami setup client` without a server proposes the one already configured, then the machines of the tailnet where a Corami daemon answers, then asks for the name. The account of the server is the one the daemon announces, `--user` an override.
- A failed step shows the reason and offers to run it again.

The server setup runs as root and creates the account that owns the projects, `corami` by default: the projects, the daemon, the git alignment service, the agents and their previews belong to it. Root keeps for the machine: a command that would write under the home of root on such a server (`project add`, `serve`, `setup git`) stops and says to run it as that account.

Without a terminal, or with `--json`, they ask nothing: the options come from the flags, and a missing server or role is a `usage` error.

To install `corami` on a new machine use the script from the release. It installs the binary in `~/.corami/bin`, adds it to the PATH and runs `corami setup` with the terminal as input:

```bash
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh -s -- server --owner me@example.com
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh -s -- client <server>
```

A role and flags after `--` go to the setup. Without a terminal it installs the binary only, unless it is given a client and its server. The services the setups install:

| Service | Where | What it does | Installed by |
|---|---|---|---|
| `corami-daemon` | server, systemd (user service with linger, system service when user services are not available) | API, project registry, previews | `corami setup server`, step `daemon` |
| HTTPS on port 7420 | server, `tailscale serve` | publishes the daemon to your tailnet | `corami setup server`, step `serve` |
| `corami-git-watch` | server and clients: systemd on Linux, launchd agent `dev.corami.git-watch` on macOS, scheduled task on Windows | keeps `.git` aligned with `origin` | both setups, step `git-watch` |
| Mutagen daemon | clients: user systemd unit `corami-mutagen` on Linux, launchd agent `io.mutagen.mutagen` on macOS, logon registration on Windows | carries the sync sessions, also after a reboot | `corami setup client`, step `mutagen-daemon` |

`corami doctor` reports a service that is not running and the step that installs it again.

## Projects

A project is added to the server once, with `project add` or `project import`, and every client then takes its local copy with `corami sync <project>`. The [README](../README.md#start-a-project) shows which command fits where the project is today.

| Command | Description |
|---|---|
| `corami project add <git-url> [--name <name>]` | clones on the server, from any machine |
| `corami project add --path <folder>` | on the server: registers a folder already there, without moving it |
| `corami project import [folder]` | on a client: moves a local project to the server, with git history and env files; the folder becomes the synced copy. Files that look like keys stay on the client, in the backup folder |
| `corami project ls` | list with the previews of each project |
| `corami project show <name>` | project detail: path, git, previews |
| `corami project rm <name> --yes` | removes the project from the server, previews included |

There is no configuration file in the repository: Corami knows a project by its folder.

## Previews

Corami starts no project process. Start the dev server yourself (a user service, a container), then give it an address. The rules are in [previews.md](previews.md).

| Command | Where | Description |
|---|---|---|
| `corami serve <port> [--name <name>] [--project <project>]` | server | stable HTTPS address for `127.0.0.1:<port>`. The project comes from the folder. The name is `web` by default |
| `corami serve ls [project]` | all | registered addresses, with `responding` |
| `corami serve rm <name> [--project <project>]` | all | removes the address and the record |

The public port is stable per preview and comes from the daemon, in the range 4100-4999. Registering the same name again with another port moves the rule and keeps the URL.

## Sync

| Command | Where | Description |
|---|---|---|
| `corami sync <project> [--path <folder>] [--no-git]` | client | creates the local copy, starts the session and gives the copy its own `.git`, cloned from `origin` on the branch of the server; run again, it retries a clone that failed |
| `corami sync status [project]` | client | state, conflicts, last error, last change and git state of the two sides towards `origin` |
| `corami sync flush [project]` | client | flushes the session queue |
| `corami sync rm <project> [--force] [--dry-run]` | client | removes only the local copy, after the checks |
| `corami sync prune --unused <duration> [--dry-run] [--yes]` | client | lists and removes the unused copies of this client; without `--yes` it touches nothing |
| `corami git watch [project] [--once]` | all | the alignment cycle in the foreground: it runs as a service on the server and on every client |

Inside a synced copy the project name is not needed: the commands find it from the sync sessions.

The account of the server for the sync and the import is `server_user` of the configuration, saved by `corami setup client`, then `user` of the health answer of the daemon, then `root`. `--user` overrides it for one command.

Every side is a peer and follows only `origin`: `corami git watch` runs one cycle at startup and then one every minute, downloads the refs of `origin` and, when it is behind and the files have already arrived with the sync, moves its HEAD without touching the files. The push is done by whoever makes the commit: `git push` from the side that has the commits, and the other aligns after the push. A merged PR on GitHub enters with a `git pull` on any side, and the other follows when the files arrive with the sync.


## Output examples

```bash
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
    "created_at": "2026-10-16T10:00:00.000Z",
    "url": "https://corami.tail1a2b3c.ts.net:4100",
    "responding": true
  }
}
```

```bash
corami update --check --json
```

```json
{ "ok": true, "data": { "current": "0.0.1", "latest": "9.9.9", "update_available": true } }
```
