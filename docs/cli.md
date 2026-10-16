# CLI reference

Commands of v1. A command that does several things has actions, as in `corami sync prune`, and each action has its own flags. Every command accepts the global flags `--json`, `--help` and `--version`. Without a TTY the output is JSON by default, the help included. A flag the command or the action does not know, or a flag without its value, is a `usage` error. Envelope and exit codes are in `architecture.md`.

`corami help [command [action]]` is the same as `--help` on the command or the action: `corami help sync prune` shows the flags of `sync prune` only.

## Index

- [Setup](#setup)
- [Projects](#projects)
- [Previews](#previews)
- [Sync](#sync)
- [Output examples](#output-examples)

## Setup

| Command | Where | Description |
|---|---|---|
| `corami setup` | all | in a terminal: asks what the machine is, then runs the setup of that role |
| `corami setup server [--owner <login>] [--user <user>]` | server, as root | idempotent setup: Tailscale, the account that owns the projects, HTTPS, the `corami-daemon` and `corami-git-watch` services |
| `corami setup server [--hostname <name>] [--auth-key <key>] [--fqdn <name>]` | server, as root | the name of the machine on Tailscale (`corami` by default), a Tailscale authentication key instead of the login link, the MagicDNS name when already known |
| `corami setup server --firewall` | server | closes public SSH: you enter with Tailscale SSH |
| `corami setup server --step <step>` | server | runs a single step: `preflight`, `packages`, `tailscale`, `hosts`, `user`, `firewall`, `daemon`, `git-watch`, `serve`, `summary` |
| `corami setup client [server] [--user <user>]` | client | idempotent setup: checks Tailscale, daemon and SSH, installs Mutagen, the Mutagen daemon service and `corami-git-watch`, saves the configuration |
| `corami setup client <server> --step <step>` | client | runs a single step: `tailscale`, `daemon`, `ssh`, `mutagen`, `mutagen-daemon`, `config`, `git-watch` |
| `corami setup git [--provider github\|gitlab\|bitbucket] [--identity-name <name>] [--identity-email <email>]` | server, as the account | SSH key of the server, check and rewriting of HTTPS remotes; with `--identity-email` it also sets the git identity of the account, `Corami` as the name by default |
| `corami doctor [area]` | all | checks with remedies. Areas: `net`, `tools`, `git`, `server` |
| `corami update [--check] [--version vX.Y.Z] [--force]` | all | updates the binary from the GitHub release, with a sum check, or installs one exact version; `--force` installs the same version again; on the server it restarts the daemon, and as root it also replaces the binary of the account |

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

`project` acts on the server, `sync` on the copy of this machine. A project is added to the server once, with `project add` or `project import`, and every client then takes its copy with `corami sync add`. `project rm` removes it from the server, previews included, and on a client it closes the copy of that machine first: the files stay where they are, the session does not. `sync rm` is the other way round: it frees the disk of this machine and leaves the server alone. The [quick start](quickstart.md#3-your-first-project) shows which command fits where the project is today.

| Command | Description |
|---|---|
| `corami project add <git-url> [--name <name>] [--no-sync] [--dry-run]` | clones on the server; on a client it creates the copy of this machine in the same command, unless `--no-sync` |
| `corami project add --path <folder> [--dry-run]` | on the server: registers a folder already there, without moving it. A client refuses it: `project import` moves a folder of this machine instead |
| `corami project import [folder] [--name <name>] [--include <glob>] [--user <user>] [--dry-run]` | on a client: moves a local project to the server, with git history and env files; the folder becomes the synced copy. Files that look like keys stay on the client, in the backup folder. `--include` copies more files not tracked by git, repeatable |
| `corami project ls` | list with the previews of each project |
| `corami project show <name>` | project detail: path, git, previews |
| `corami project rm <name> --yes` | removes the project from the server, previews included. Deletes the folder only if Corami created it: one registered with `--path` stays on disk |

`project add <git-url>` on a client creates the copy at `~/corami/<name>` and starts its session. Before registering the project it stops when the folder it runs in is already a clone of the url (`project import` is the command then), when a session of that name is left behind by a project removed elsewhere (close it with `sync rm` first), and when `~/corami/<name>` exists with something else in it (choose another folder with `--path`). A copy that fails, for a missing Mutagen or SSH, does not take the project away: the output says why and `corami sync add <name>` retries it. `--dry-run` shows the plan without touching anything, the server included.

On a client, `project ls` also reads the sessions of the sync engine and adds a `Local` column, in JSON `local_copy` for every project and `orphan_copies` for the sessions without a project on the server. A Mutagen that does not answer leaves the column empty and the text says it, without failing the command.

A name is taken by the `project add` or `project import` that registers it: a second one is refused, and nothing of the project already there is touched.

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
| `corami sync add [<project>] [--path <folder>] [--server-path <folder>] [--user <user>] [--no-git] [--dry-run]` | client | creates the local copy, starts the session and gives the copy its own `.git`, cloned from `origin` on the branch of the server; run again, it retries a clone that failed. On a client, the first project runs it from `project add` |
| `corami sync ls` | client | the copies of this machine, from the sessions of the engine: no daemon and no git. With the daemon reachable it marks the copies whose project is not on the server |
| `corami sync status [project]` | client | state, conflicts with their local and server paths, last error, last change and git state of the two sides towards `origin` |
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

```bash
corami help sync prune --json
```

```json
{
  "ok": true,
  "data": {
    "command": "sync prune",
    "summary": "Lists and removes the copies of this client unused for a while",
    "usage": "corami sync prune --unused <duration> [--dry-run] [--yes]",
    "actions": [],
    "flags": [
      { "name": "unused", "value": "duration", "description": "Only copies idle for longer than, e.g. 30d" },
      { "name": "dry-run", "description": "Show what it would do" },
      { "name": "yes", "description": "Confirm the removal" }
    ],
    "examples": ["corami sync prune --unused 30d", "corami sync prune --unused 30d --yes"],
    "global_flags": [
      { "name": "json", "description": "JSON output, the default without a terminal" },
      { "name": "help", "description": "This help, also corami help <command> [<action>]" },
      { "name": "version", "description": "Version of corami" }
    ]
  }
}
```
