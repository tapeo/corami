# CLI reference

Commands of v1. A command that does several things has actions, as in `corami sync prune`, and each action has its own flags. Every command accepts the global flags `--json`, `--help` and `--version`. Without a TTY the output is JSON by default, the help included; `corami exec --on` is the one exception, with the passthrough explained in [Exec](#exec). A flag the command or the action does not know, a flag without its value, or an argument beyond the ones it takes, is a `usage` error. Envelope and exit codes are in `architecture.md`.

`corami help [command [action]]` is the same as `--help` on the command or the action: `corami help sync prune` shows the flags of `sync prune` only.

## Index

- [Setup](#setup)
- [Projects](#projects)
- [Previews](#previews)
- [Sync](#sync)
- [Exec](#exec)
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
| `corami doctor` | all | checks with remedies, in one list |
| `corami update [--check] [--version vX.Y.Z] [--force]` | all | updates the binary from the GitHub release, with a sum check, or installs the version named with `--version` (an older one included); `--force` installs the same version again; on the server it restarts the daemon, and as root it also replaces the binary of the account |

In a terminal the setups ask what the flags do not say, and only that:

- `corami setup` without a role asks for it. Outside Linux the machine can only be a client.
- `corami setup server` waits for the approval of the Tailscale login link instead of stopping, proposes the Tailscale login of the server as the owner when `--owner` is missing and none is saved, and offers to close public SSH when Tailscale SSH is on and the firewall is not in place yet.
- `corami setup client` without a server proposes the one already configured, then the machines of the tailnet where a Corami daemon answers, then asks for the name. The account of the server is the one the daemon announces, `--user` an override.
- A client that moves to a server with another name stops its sessions first: the steps are in [backup.md](backup.md#moving-the-clients-to-another-server).
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

`corami doctor` reports a service that is not running and the step that installs it again. On the server it also reports the folders of the projects root that no project names, and the ones an import that stopped left behind. It reports how Tailscale SSH treats `root` and the other accounts of the machine, whether the tailnet holds people besides the owner, and on a client whether sshd, the exec channel and its approval dialog are in order: the remedies are in [security.md](security.md).

## Projects

Every project lives on the server **and** on the machines that work on it, with a sync session between the two: `corami project add` creates both, whatever the source. On a client, the project goes on the server and the copy of this machine follows; the folder of the copy is always the argument you give. The [quick start](quickstart.md#3-your-first-project) shows the three sources.

| Command | Description |
|---|---|
| `corami project add <folder> [--server-path <folder>] [--name <name>] [--dry-run]` | copies a folder of this machine to the server, git history included, which becomes the source of truth; the folder stays here and becomes the copy, its files untouched. This is what `project add` does with no source flag |
| `corami project add <folder> --from-git <url> [--server-path <folder>] [--name <name>] [--dry-run]` | clones the repository on the server, then creates the copy here |
| `corami project add <folder> --from-server (--server-path <folder> \| --name <name>) [--dry-run]` | the folder is already on the server: it is registered if it was not, then the copy is created here. This is also how a second client takes its copy |
| `corami project ls` | list with the previews of each project |
| `corami project show <name>` | project detail: path, git, previews |
| `corami project rm <name> --on client --yes [--force] [--dry-run]` | removes only the copy of this machine, folder of its session, after the checks. The project on the server stays |
| `corami project rm <name> --on server --yes` | removes the project from the server, previews included; the folder only if Corami made it. The copies of the clients stay, their sessions stop |

At most one `--from-*`: without one the project comes from this machine, the only source that carries no value of its own. The folder is always the argument, in every source: it is where the copy lives, so it is neither asked nor defaulted. Everything runs from a client: the server has no copies. A missing `--name` or `--server-path` is asked in a terminal with a value already written, and the defaults are:

| Flag | Default |
|---|---|
| `--name` | from the url, the server folder or the local folder |
| `--server-path` | `~/projects/<name>` of the account that owns the projects |

With `--from-server --name` of a registered project the server path is the one the project already has: it is not asked, and `--server-path` with another folder is refused.

Without a source flag the folder must exist: a path that is not here is a `usage` error, because there is nothing to copy. The fix names `--from-server` when the server already has a project with that name, and `--from-git <url>` otherwise.

`--from-git` stops when the command runs inside a clone of the same repository: give that folder as the argument and it is copied instead of cloning a second one. `--from-server --name <name>` takes a registered project, wherever its folder is, and refuses a `--server-path` that says otherwise. A folder of this machine that is the home itself, or contains it, is not a project: the command refuses it rather than copying keys and personal files to the server. The import writes into a folder next to the project, `.corami-import-<name>-<time>`, and the registration moves it into place: a command that stops leaves that folder at most, never the name of the project, and `corami doctor` reports it. A step that fails after the server was given the project takes the project away again: a project with no copy on any machine is what this command never leaves behind. `--dry-run` shows both steps, server and client, without touching anything.

In a terminal `project add` shows a line for each phase that takes time, erased when the phase ends. The bar with a percentage appears only where a real counter knows the total: the bytes of the import upload, the bytes the sync writes in the copy (the files when the size is not known), the objects of a clone. Everything else, the clone on the server included, is a line with the seconds elapsed. At the end the command waits for the first cycle of the sync, which is what fills the copy: Ctrl+C stops the wait and leaves the sync running, and `corami sync status` follows it. With `--json`, or without a terminal, there is no line and no wait: the command answers as soon as the session exists.

A name is taken by the `project add` that registers it: a second one is refused, and nothing of the project already there is touched. Two projects whose folders contain each other are refused too: they would sync the same files.

On a client, `project ls` also reads the sessions of the sync engine and adds a `Local` column, in JSON `local_copy` for every project and `orphan_copies` for the sessions without a project on the server, the copies `sync stop` closes. A Mutagen that does not answer leaves the column empty and the text says it, without failing the command.

There is no configuration file in the repository: Corami knows a project by its folder.

## Previews

Corami starts no project process. Start the dev server yourself (a user service, a container), then give it an address. The rules are in [previews.md](previews.md).

| Command | Where | Description |
|---|---|---|
| `corami serve <port> [--name <name>] [--project <project>]` | server | stable HTTPS address for `127.0.0.1:<port>`. The project comes from the folder. The name is `web` by default |
| `corami serve ls [project]` | all | registered addresses, with `responding` |
| `corami serve rm <name> [--project <project>]` | all | removes the address and the record |

The public port is stable per preview and comes from the daemon, in the range 4100-4999. Registering the same name again with another port moves the rule and keeps the URL.

On a client the folder is not the one of the server: `corami serve rm <name>` there needs `--project <name>`, because the copy of this machine has another path.

## Sync

| Command | Where | Description |
|---|---|---|
| `corami sync status [project]` | client | state, conflicts with their local and server paths, last error, last change and git state of the two sides towards `origin` |
| `corami sync flush [project]` | client | flushes the session queue |
| `corami project rm <name> --on client --yes [--force] [--dry-run]` | client | removes only the local copy, the folder of its session, after the checks. The project is always named, never taken from the current folder |
| `corami sync stop [<project>]` | client | stops the sync of this copy and keeps the files. The way out of a copy whose project is gone from the server, where `corami project rm --on client` would be deleting the last copy of the work |
| `corami sync prune --unused <duration> [--dry-run] [--yes]` | client | lists and removes the unused copies of this client; without `--yes` it touches nothing |
| `corami git watch [project] [--once]` | all | the alignment cycle in the foreground: it runs as a service on the server and on every client |

`corami project ls` is the list to read for the copies of this machine: no daemon and no git, just the sessions of the engine, with the copies whose project is not on the server marked.

Inside a synced copy the project name is not needed, except for `project rm --on client`: the commands find it from the sync sessions. A Mutagen that does not answer stops every command that picks a copy, `project add` and `project rm --on client` included: without its sessions no command can tell which folder belongs to which project.

The folder of a copy is never guessed. `project add` needs it as the argument, and a session already there keeps its folder: another folder is a `usage` error, the copy moves with `project rm --on client` then `project add` again. The folder cannot be inside the copy of another project, or contain it. A path that still starts with `~` is refused, because only a shell expands it: give it in full or relative to the current folder. The removal deletes only the folder of a session: a folder whose sync was stopped is not a copy any more, and Corami leaves it to you.

`project rm --on client` flushes first and then reads the session: when Mutagen does not answer, the flush fails, or the session is not `watching`, it stops with `sync_pending` and deletes nothing. That is the safe answer when a laptop was offline or the server did not answer: run the removal again when the session is back, or `corami sync status` to see what it is waiting for.

The account of the server for the sync and the import is `server_user` of the configuration, saved by `corami setup client`, then `user` of the health answer of the daemon, then `root`. `--user` overrides it for one command.

Every side is a peer and follows only `origin`: `corami git watch` runs one cycle at startup and then one every minute, downloads the refs of `origin` and, when it is behind and the files have already arrived with the sync, moves its HEAD without touching the files. The push is done by whoever makes the commit: `git push` from the side that has the commits, and the other aligns after the push. A merged PR on GitHub enters with a `git pull` on any side, and the other follows when the files arrive with the sync.

## Exec

`corami exec` runs a command of the server on a client, inside the synced copy of a project. The agent works on the server; a simulator, `xcodebuild` or a device plugged into a Mac need the Mac. The channel is off until the client turns it on in its terminal.

| Command | Where | Description |
|---|---|---|
| `corami exec --on <client> [--project <name>] -- <command>` | server | runs the command on the client, in the copy of the project. The project comes from the current folder |
| `corami exec status` | all | on the client: channel, sshd, rules, waiting and running commands. On the server: the registered clients, allowed and online |
| `corami exec allow` | client, terminal | turns the channel on: sshd to keys only, the key of the server in `authorized_keys`, the registration and a check from the server |
| `corami exec deny` | client | removes the key line, stops the running commands, cancels the waiting ones and informs the server |
| `corami exec approve` | client, terminal | stays open and answers the requests of the server as they arrive: once, always on the subcommand or on the program, or deny. Also over ssh, from a phone |
| `corami exec rule allow\|deny\|rm [--project <name>] -- <command>` | client | adds or removes a rule |
| `corami exec rules` | client | lists the rules |

A rule is a list of tokens compared with `argv`, token by token. `*` is only the last token and covers any rest, even empty. `deny` wins over `allow`, and a command with no rule asks. `--project` limits a rule to one project. A rule limits the command, not what it does: `flutter run` runs project code and `allow npx *` allows everything, so `exec rule allow` warns when it covers a program that runs arbitrary code.

A command with no rule asks on the client. A dialog opens on the screen of the client with *Allow once*, two *Always allow* and *Deny*; a terminal that runs `corami exec approve` asks the same question, and the first answer wins. The narrow *Always allow* adds the rule of the program, its first argument and `*`, such as `flutter build *`; the wide one adds the program and `*`, such as `flutter *` or `adb *`. A program that runs arbitrary code (`npx`, `node`, `bash`...) gets one *Always allow*, on the exact command. The command sits in a read-only field and no button answers Enter, so keys typed elsewhere when the dialog opens answer nothing. The wait is 60 seconds, shorter than the timeout of the bash tool of a harness: without an answer the server sees a Corami error and the agent can run the command again. When the connection closes while it waits, or while the command runs, the gate cancels the request or stops the command.

```bash
# on the client, once
corami exec allow

# on the client, the rules of a simulator and of a build
corami exec rule allow -- xcrun simctl '*'
corami exec rule allow --project myapp -- flutter build '*'

# from the server, inside the project
corami exec --on macbook -- flutter devices
corami exec --on macbook --project myapp -- flutter run -d "iPhone 16"
corami exec --on macbook -- xcrun simctl boot "iPhone 16"
```

Output is the exception to the contract above: without `--json` it is the stdout and stderr of the command, even without a TTY, and the exit code of the command is the exit code of `corami`. With `--json` the output is collected:

```json
{
  "ok": true,
  "data": {
    "client": "macbook",
    "project": "myapp",
    "exit_code": 0,
    "stdout": "2 connected devices:\n...",
    "stderr": "",
    "duration_ms": 1840
  }
}
```

The errors of Corami before the command starts use the usual envelope: `macbook is offline in the tailnet`, `macbook does not allow commands from this server`, `macbook denies this command: rm -rf build (rule: deny rm *)`, `macbook has no copy of myapp`, or `the sync of myapp on macbook is not up to date: the command did not start`.

An MCP server can run on the client through the same channel. The first run asks for the exact command of the server:

```json
{
  "mcp": {
    "mobile": {
      "type": "local",
      "command": [
        "corami", "exec", "--on", "macbook", "--project", "myapp", "--",
        "npx", "-y", "@mobilenext/mobile-mcp@latest"
      ]
    }
  }
}
```

For `npx` and the other programs that run arbitrary code, *Always allow* allows exactly that command, not `npx *`. When the harness closes the MCP server, the connection ends and the gate closes the processes of the command on the client.

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
