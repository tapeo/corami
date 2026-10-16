# Architecture

Implementation details of v1.

## Index

- [Overview](#overview)
- [Principle: Corami does not manage project toolchains](#principle-corami-does-not-manage-project-toolchains)
  - [`corami doctor`](#corami-doctor)
- [Roles](#roles)
  - [Phone and tablet](#phone-and-tablet)
- [Components](#components)
- [Stack](#stack)
- [Repository structure](#repository-structure)
- [Paths and ports](#paths-and-ports)
- [Config](#config)
  - [Global (`~/.corami/config.json`)](#global-coramiconfigjson)
- [Network and security](#network-and-security)
  - [Remote access: always HTTPS](#remote-access-always-https)
  - [Authentication](#authentication)
  - [Other](#other)
- [Projects](#projects)
- [Previews](#previews)
  - [How the address is born](#how-the-address-is-born)
  - [Registration and reconciliation](#registration-and-reconciliation)
  - [Dev servers that check the Host header](#dev-servers-that-check-the-host-header)
  - [Local preview](#local-preview)
- [Builds and runs](#builds-and-runs)
- [Worktrees](#worktrees)
- [Verification for agents](#verification-for-agents)
  - [Instructions for the agent](#instructions-for-the-agent)
- [Sync](#sync)
  - [Mutagen session](#mutagen-session)
  - [Default exclusions](#default-exclusions)
  - [State and conflicts](#state-and-conflicts)
  - [Removing the local copy](#removing-the-local-copy)
  - [Git](#git)
- [Importing a local project](#importing-a-local-project)
  - [What is transferred](#what-is-transferred)
  - [Sequence](#sequence)
  - [Git on the server](#git-on-the-server)
- [Daemon API (v1)](#daemon-api-v1)
  - [SQLite tables](#sqlite-tables)
- [CLI output contract](#cli-output-contract)
- [Harness](#harness)
  - [Recipe](#recipe)
- [Install and updates](#install-and-updates)
  - [Distribution: GitHub only](#distribution-github-only)
  - [`install.sh`](#installsh)
  - [Setup per role](#setup-per-role)
  - [Server setup](#server-setup)
  - [Client setup](#client-setup)
  - [Updates](#updates)
- [Test environment](#test-environment)
  - [Test VPS](#test-vps)
  - [Binary](#binary)
  - [Fresh server](#fresh-server)
  - [Exposure](#exposure)

## Overview

```
                 ┌──────────────── Linux server (always on) ────────────────────┐
                 │ corami daemon · projects (source of truth) · previews        │
                 │ your agent, installed by you                                 │
                 └──────▲──────────────────▲────────────────────▲──────────────┘
                        │ Tailscale        │ Tailscale SSH       │
                        │ (HTTPS)          │ (Mutagen)           │
   iPhone/iPad ─────────┘      macOS ──────┘       Linux/Windows┘
   browser: harness,            synced copy,         synced copy,
   previews                     builds (Xcode)       builds
```

## Principle: Corami does not manage project toolchains

Corami takes care of server, network, sync, previews and verification. It **does not install and does not choose** Node, pnpm, Bun, Flutter, FVM, Java, Android SDK, Xcode or CocoaPods: the user (or the agent) installs them on every machine, as they prefer.

- Corami starts no project process and runs no build. Dev servers and builds are commands of the user or of the agent, run where the tools are: the server for most projects, a client over SSH when only that machine can do it (see [builds.md](builds.md)).
- There is no configuration file in the repository. A project is a folder on the server; the sync and the previews find it by its path.
- There is no stack specific code in Corami. The few rules a dev server must respect to be reachable are in [previews.md](previews.md).

### `corami doctor`

Checks with a remedy for each item, by area:

| Area | What |
|---|---|
| `net` | Tailscale up on both sides, daemon reachable, ports listening outside `127.0.0.1` or on `0.0.0.0` (Docker iptables included) |
| `tools` | Mutagen of the pinned version, `~/.corami/bin` in the PATH |
| `git` | Key of the server, `known_hosts`, access to the providers, commit identity |

## Roles

| Role | Machine | What it runs |
|---|---|---|
| `server` | Linux VPS (Ubuntu 22.04+, Debian 12+) | daemon, projects, previews. Dev servers, builds, the harness and the backup are the user's or the agent's |
| `client` | macOS, Linux, Windows | CLI, Mutagen sync, local builds and runs with the tools of the machine (e.g. Xcode and simulators on macOS) |
| browser only | phone, tablet | nothing: it is not a Corami client. It opens the web interfaces of the server over Tailscale |

A single binary for `server` and `client`. The role is written in the global config at setup.

### Phone and tablet

Nothing of Corami is installed on the phone and there is no local code. Only the Tailscale app and a browser are needed. Everything runs on the server:

| Interface | Use |
|---|---|
| Harness with a web interface (e.g. OpenChamber) | work with the agent, which reads and edits the code on the server |
| Previews | live web apps, at their stable addresses |

Editing files by hand from the phone would need a web editor on the server (e.g. code-server). It is not planned for v1.

## Components

| Component | Role | Notes |
|---|---|---|
| `corami` CLI | all | compiled Bun, one file per platform |
| `corami daemon` | server | API: project registry, previews, git state |
| git service | all | service unit that keeps `.git` aligned with `origin` on every side (launchd, user systemd, scheduled task), installed by `corami setup client` and by `corami setup server`. On Linux the output goes to the journal, on macOS to `~/.corami/logs/git-watch.log` |
| Tailscale | all | private network, MagicDNS, Tailscale SSH, HTTPS and identity headers with `tailscale serve` |
| Mutagen | client | two-way sync towards the server over SSH. Mutagen installs its agent on the server by itself. Its daemon runs as a service, installed by `corami setup client` |

## Stack

- TypeScript strict, Bun runtime.
- Binaries: `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`.
- No runtime dependencies.
- Argument parsing: `parseArgs` from `node:util`, no library.
- Server state: SQLite with `bun:sqlite`.
- HTTP: `Bun.serve`. Processes: `Bun.spawn`.
- Lint and format: Biome. Tests: `bun test`.

## Repository structure

```
corami/
  README.md
  package.json
  tsconfig.json
  biome.json
  src/
    main.ts
    cli/
      commands/           one file per group: setup, setup-client, doctor, project,
                          serve, sync, git, update
      output.ts           JSON envelope, TTY tables, exit codes
      server-client.ts    HTTP client towards the daemon
    daemon/
      server.ts           HTTP routing and authentication with the Tailscale headers
      api.ts              projects, previews, git state
      previews.ts         serve rules: apply, remove, reconcile
    core/
      config.ts           global config and paths
      previews.ts         pure functions: ports, names, serve plans, project from a path
      ports.ts            the Corami port range, TCP probes
      pinned-tools.ts     version and sha256 of Mutagen
      local-copy.ts       single list of regenerable paths, used by sync, import and sync rm
      git.ts, git-align.ts, git-follow.ts
      next-steps.ts       pure functions: the commands shown at the end of a first run
      paths and helper modules: doctor, errors, exec,
      last-change, release, state, transfer
    integrations/
      tailscale.ts  mutagen.ts  service.ts  ssh.ts  systemd.ts
  scripts/
    install.sh
    install.ps1
    dev-install.ts
  test/
```

## Paths and ports

| What | Server | Client |
|---|---|---|
| Managed binaries | `~/.corami/bin/` | `~/.corami/bin/` |
| Global config | `~/.corami/config.json` | `~/.corami/config.json` |
| State | `~/.corami/state.db` | |
| Service logs | `~/.corami/logs/` (git watch) | `~/.corami/logs/` |
| Projects | `~/projects/<project>` | `~/corami/<project>` (Windows: `%USERPROFILE%\corami\<project>`). For imported projects, the original path |

Every service listens on `127.0.0.1:<port>`. `tailscale serve` exposes the same port number over HTTPS on the tailnet (see "Network and security").

| Port | Use |
|---|---|
| 7420 | daemon |
| 4100-4999 | previews, assigned stably per (project, name) |
| all the others | free for the user, e.g. 4096 for opencode (see "Harness") |

## Config

### Global (`~/.corami/config.json`)

```json
{
  "role": "server",
  "server_host": "corami.tail1a2b3c.ts.net",
  "owner_login": "me@example.com"
}
```

## Network and security

### Remote access: always HTTPS

Every remote access goes over HTTPS. A preview in HTTP on a name that is not `localhost` is not a secure context, so service workers, camera, geolocation, clipboard and `crypto.subtle` would not work.

- Daemon and dev servers listen only on `127.0.0.1:<port>`, never on `0.0.0.0`. The harness recipe follows the same rule.
- The daemon exposes every port with `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` ([docs](https://tailscale.com/kb/1242/tailscale-serve)). Tailscale terminates TLS with a certificate valid for `<magicdns-fqdn>` and forwards to localhost. The public port on the tailnet matches the local one.
- `tailscale serve` forwards only to `127.0.0.1`. That is why the processes do not bind to the Tailscale IP.
- Rules are created by `corami serve` and removed by `corami serve rm` and by the reconciliation at daemon start. With `--bg` they survive a machine restart. The daemon manages only its own range (port 7420 and 4100-4999): rules added by the user, for the harness for example, are never touched.
- One-time prerequisite: HTTPS certificates enabled in the Tailscale admin console. The setup asks for it and verifies it.
- Public certificates end up in the Certificate Transparency logs: machine name and tailnet name become public. The setup warns about it when the machine name is chosen.

### Authentication

- `tailscale serve` adds the `Tailscale-User-Login` and `Tailscale-User-Name` headers to requests ([docs](https://tailscale.com/docs/features/tailscale-serve#identity-headers)).
- The daemon accepts a request only when `Tailscale-User-Login` matches `owner_login`. Requests without the header come from local processes of the server (agents, CLI) and are trusted, because they run as the same user.
- Previews and any user services exposed with `tailscale serve` are reachable by everyone in the tailnet. In a tailnet used only by the owner that is the intended behaviour. In a shared tailnet, access to the server must be limited with a Tailscale ACL rule, once, from the console: the setup reminds about it.
- A harness can run code: when it offers its own authentication (e.g. `OPENCODE_SERVER_PASSWORD` in opencode), the recipe turns it on.

### Other

- Optional firewall (ufw): inbound blocked on every interface except `tailscale0`. The setup applies it only after verifying that Tailscale SSH works, and only with explicit confirmation.
- Docker writes its own iptables rules and bypasses `ufw`: a port published by a container without `127.0.0.1:` in front is reachable from the public IP even with the firewall on. `corami doctor net` reports it, and [previews.md](previews.md) explains how to avoid it.
- The setup adds the line `<tailscale-ip> <magicdns-fqdn>` to `/etc/hosts`. That way the server reaches its own HTTPS URL even without local MagicDNS.

## Projects

A project is a folder on the server plus a row in `projects(name, path, repo_url, created_at)`. `corami project add` clones or registers a folder, `corami project import` moves one from a client, `corami project rm` removes it (folder, previews and row).

- **The name is the key.** `~/projects/<name>` on the server, `~/corami/<name>` on every client, `corami-<name>` for the Mutagen session.
- **No file in the repository.** `corami serve` finds the project with `projectForPath` (`src/core/previews.ts`): the longest registered path that contains the current folder. From a client, `corami sync` uses the sync sessions instead.
- **One instance per project,** in the main folder. Worktrees created by the harness are not registered.

## Previews

Corami starts no project process. The dev server is started by the user or the agent; `corami serve <port>` gives it a stable HTTPS address.

### How the address is born

- Domain: the MagicDNS name of the server, read from `tailscale status --json`. It is made of the machine name (chosen at setup with `tailscale up --hostname`, default `corami`) and the tailnet name (e.g. `tail1a2b3c.ts.net`, changeable from the Tailscale console).
- Public port: assigned by the daemon and stable per (project, name), saved in SQLite, in the range 4100-4999. Registering the same name again with another target port moves the rule and the address stays the same, so bookmarks and links do not break.
- URL: `https://<magicdns-fqdn>:<public-port>`, e.g. `https://corami.tail1a2b3c.ts.net:4101`. Reachable only from the devices of the tailnet. The links always use the full name: the short name would not have a valid certificate.
- Target: `http://127.0.0.1:<port>`, the port of the dev server. `responding` is a TCP connection on that port: a preview can be registered before the dev server is up.
- Several previews per project, one per name: a Next.js app and an API of the same project work at the same time, and so do different projects, because different ports are different origins for `localStorage` and service workers.
- **Known limit of v1:** cookies are separated per domain, not per port. Two projects with a cookie of the same name (e.g. the same authentication library) overwrite each other's session. A subdomain per preview, which would fix it, is an idea for the [v2](v2/README.md).

### Registration and reconciliation

- `corami serve <port>` on the server calls `PUT /v1/projects/<p>/previews/<name>`: the daemon validates the port (1-65535, not 7420 and not in the preview range), allocates the public port and runs `tailscale serve --bg --https=<public> http://127.0.0.1:<target>`.
- Changing the target needs `off` first, which `applyPreview` does.
- At startup the daemon reconciles (`reconcileServeRules`): `planServeRules(desired, current)` is a pure function (`src/core/previews.ts`, covered by tests) that says which rules to create and which to remove, considering only the Corami range. Rules without a record are removed, so leftovers of an older version disappear by themselves. Rules outside the range are the user's.
- `corami serve rm <name>` turns the rule off and deletes the record. Removing a project does the same for all its previews.

### Dev servers that check the Host header

Behind `tailscale serve` the browser uses the Tailscale name, while the dev server answers on `127.0.0.1`. Frameworks that block cross-origin requests to development assets need the name in their list, once per project:

```js
const nextConfig = {
  allowedDevOrigins: ['*.ts.net'],
};
```

- `*.ts.net` is a wildcard, supported by Next.js ([docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins)), so the tailnet name stays out of the repository. Corami does not edit `next.config` and does not check it.
- Symptom when it is missing: the page loads half styled, hot reload does not work, and the dev server logs warn about blocked cross-origin requests.
- Other frameworks have the same setting under a different name (e.g. `server.allowedHosts` in Vite).

### Local preview

On a client the dev server can always be started on the synced copy (e.g. `pnpm dev`) and opened at `http://localhost:<port>`. Browsers treat `localhost` as a secure context even in HTTP. That preview has no managed address: it is local to the machine.

To open the server preview from a client, the same HTTPS address is used, without forwarding ports.

## Builds and runs

Nothing in Corami runs a build or a project command. The details, including builds on a client over SSH and the rules for keys, are in [builds.md](builds.md).

- **Dependencies:** each machine installs them with the command of the project (`pnpm install`, `flutter pub get`). Lockfiles are synced, the dependency folders are not, because they contain native binaries and absolute paths of the machine.
- **Advice, not obligations:** pnpm with its global store (same file system as `~/corami`, for hard links), FVM with `.fvmrc` for Flutter. Corami does not check them.
- **A long build on the server** competes with the previews for CPU: run it with `nice` and close the toolchain daemons at the end (`gradlew --stop`).

## Worktrees

In v1 Corami does not manage worktrees. Harnesses can create them on the server as they prefer; a worktree is not a project and has no preview. If needed, they can enter the backup the user sets up (see [backup.md](backup.md)). Parallel previews per worktree or branch: an idea for the [v2](v2/README.md).

## Verification for agents

Corami ships no checker: the preview is a normal HTTPS page, and the agent opens it with the browser of its harness, or with a browser tool the harness offers (a Playwright or chrome-devtools MCP, for example). There it sees the console, the network, the screenshot, and it can click, fill forms and log in, which a one-shot screenshot command could not do. The address to open is `url` in the output of `corami serve` and of `corami serve ls`.

### Instructions for the agent

The instructions to give the agents are a block to copy into `AGENTS.md`, in the [quick start](quickstart.md#tell-the-agent-about-corami). Corami no longer writes the file by itself.

## Sync

### Mutagen session

One session per project, created by the client with `corami sync <project>`:

```bash
mutagen sync create \
  --name corami-<project> \
  --mode two-way-safe \
  --ignore-vcs \
  --ignore <list> \
  corami@<server>:~/projects/<project> \
  ~/corami/<project>
```

- Alpha is the server, beta is the client. The server path is the folder the daemon has for the project, so a project registered with `project add --path` syncs from where it is.
- `two-way-safe`: conflicts that cannot be solved without losing data stay pending and are reported ([docs](https://mutagen.io/documentation/synchronization/)).
- SSH goes through Tailscale SSH, so no keys to distribute.
- Mutagen daemon persistence: `mutagen daemon register` on macOS and Windows, user systemd unit `corami-mutagen` on Linux. The `mutagen-daemon` step of `corami setup client` installs it, and `corami doctor` checks it.

### Default exclusions

```
.git/                       never synced: every side has its own
node_modules/  .next/  .turbo/  dist/  build/  coverage/
.dart_tool/  .flutter-plugins  .flutter-plugins-dependencies  .fvm/
ios/Pods/  ios/.symlinks/  ios/Flutter/Generated.xcconfig
ios/Flutter/flutter_export_environment.sh
android/.gradle/  android/local.properties  android/key.properties
macos/Flutter/ephemeral/  linux/flutter/ephemeral/  windows/flutter/ephemeral/
*.jks  *.keystore  *.p8  *.p12  *service-account*.json
.env  .env.*
```

Files generated with absolute paths of the machine (`Generated.xcconfig`, `local.properties`) stay excluded, otherwise they would break the build on the other machine. Lockfiles (`pubspec.lock`, `Podfile.lock`, JS lockfiles) are synced. The list lives in `local-copy.ts`, with the secret and env entries.

### State and conflicts

- `corami sync status --json` reads `mutagen sync list --template '{{ json . }}'` and returns state, last cycle, conflicts and the last change.
- `corami sync status` shows the local and the server path of each conflict. To resolve one, delete the copy that should lose, on this machine or on the server: Mutagen then syncs the other one to both sides, which is the resolution method documented by Mutagen ([docs](https://mutagen.io/documentation/synchronization/)). No dedicated command: it would only wrap one deletion. The `sync_conflict` error of `sync rm` gives the same fix.
- Sync hides behind a `SyncEngine` interface, so it can move to Syncthing if needed.

### Removing the local copy

`corami sync rm <project>` frees space on a client: it deletes **only** the local copy of that client. Project, git and previews on the server stay untouched. `corami sync <project>` recreates it at any time.

Sequence, in order:

1. **Flush:** `mutagen sync flush`, so every local change reaches the server.
2. **Conflicts:** when the session has open conflicts, it stops with `sync_conflict`. The local side of a conflict would be lost.
3. **Sync problems:** when Mutagen reports unreadable or untransferred files, it stops with the list of files.
4. **Local-only files:** it looks for files excluded from the sync that are not in `local-copy.ts`. For example `.env.local`, `*.jks`, `*.p8`. When there are any, it stops with `local_only_files` and the list; `--force` deletes them anyway.
5. **Local git:** when the `.git` of the copy has commits or stashes that exist in no remote (typically work done on the copy without a push), it stops with `local_only_files`. Commits already elsewhere do not block.
6. **Closing the sync:** `mutagen sync terminate`. It must be done **before** deleting: with the session active, Mutagen would propagate the deletions to the server.
7. **Deletion** of the local folder.
8. **State cleanup:** a record in `~/.corami/sync-state.json` (removal date, freed space).

When the deletion is interrupted (e.g. an open file on Windows), the server is not at risk because the session is already closed. The state becomes `removal_incomplete` and running the command again completes the work.

Caches outside the project folder (pnpm store, `~/.pub-cache`, Gradle caches, Xcode DerivedData) are not touched.

#### Projects not used recently

- Last activity of a project on a client: the newest value between the last `corami` command run on that project from this machine and the last change of a synced file, excluding the regenerable folders.
- It is a heuristic: the changes of the agent on the server count as activity too, because they arrive through the sync. A project the agent works on is not proposed for removal.
- `corami sync status` shows for every local copy the space it takes, the last activity and the git state of the two sides.
- `corami sync prune --unused <duration>` acts only on the local copies of the client it is run from, never on the server. It lists the candidates with the space that would be freed, asks for confirmation, then runs `sync rm` on each. A project whose removal checks block is skipped and reported, without stopping the others. `--dry-run` shows only the list, `--yes` skips the confirmation; without `--yes` it removes nothing.

### Git

Every side has its own `.git`: the client in the local copy, the server in the project folder. The sync ignores `.git`, so the two repositories never exchange their internal files. Commits are made where the work is happening, with git commands on the right side: on the server the agents do it, on the client the IDE or the shell.

The two sides are **peers** and have **only `origin`**: no remote towards the other side, no added refs in the repositories. Each follows `origin` on its own, and what keeps them together is the sync, which carries the files from one to the other. Corami does one thing only: **it moves the HEAD of the side that is behind**. It never touches the files.

The rule is the same on both sides and is a pure function, `originRelation` in `src/core/git-align.ts`:

- the side is on the same commit as `origin/<branch>`: `aligned`, nothing is touched;
- the local commit is an **ancestor** of the one of `origin`: the side is behind. It moves with a mixed reset, which leaves the files alone;
- the commit of `origin` is an **ancestor** of the local one: the side is ahead, and has **something to publish**. The cycle does nothing: the push is a manual act of whoever made the commit;
- neither commit is an ancestor of the other: `diverged`, nothing is touched and it stays to be decided by hand;
- detached HEAD, no upstream, something staged, a git operation in progress: it does not align, and the state says why.

**Waiting for the files.** A commit that arrives from outside, a merged PR on GitHub for example, does not have its files on either side until someone runs `git pull`. Before moving the HEAD the cycle checks that the incoming changes **have arrived**: for every file changed between the HEAD and the destination the disk must differ from what it was before. An added file must be there, a deleted one must be gone. That way even a file the agent kept editing after the commit does not block the alignment, while a commit not yet delivered by the sync keeps it waiting.

The HEAD move cannot jump over a just-made commit: `git update-ref refs/heads/<branch> <new> <old>` moves the ref only when the expected value still holds, and then `git reset -q` fixes the index. When a commit arrived in the meantime, nothing happens and the next cycle retries. On sides with something staged it waits: the reset is mixed and that work would be lost.

Who does what:

- **The same cycle runs on both sides:** `corami git watch`, as a service installed by `corami setup client` on the client and by `corami setup server` on the server. On every side it runs one cycle right at startup and then one **every minute**: `git fetch origin`, the decision, the file check and, when needed, the move. The client works on the local copies (`session.beta`), the server on the projects of `listProjects()`. No file watchers, no event streams, no coordination between the sides: every side decides on its own, and only the sync ties them together. Every state change of a project produces a **JSON line** (`project`, `status`, `reason`, `from`, `to`, `upstream_commit`, `fetched`), and one also when the fetch towards `origin` stops succeeding or succeeds again: on the server it goes to the journal, on the Mac to `~/.corami/logs/git-watch.log`, and with `--json` the line goes to stderr, so stdout stays the only envelope of the command.
- **The daemon never moves anything.** It answers with the state of the server (`GET /v1/projects/<p>/git/state`, which includes the relation with `origin` read without a fetch) and that is it.
- **Passing outcomes retry by themselves.** When `origin` does not answer, when the network is not ready, when the files are not here yet, the next minute's cycle retries. A failed fetch does not block: the decision uses the refs of the last successful fetch.

What does not enter the alignment:

- **The push is done by whoever makes the commit,** by hand: a commit that sits on one side only reaches the other **after** the push. Until then, on the other side the files are uncommitted changes. That goes for the agents on the server too: whoever commits there must `git push`.
- **`origin` is the only place where things are published.** For a commit that arrived from outside (a merged PR on GitHub, another machine) a `git pull` is needed on any side: the other follows on the next cycle, once the sync has delivered the files. The alignment alone never `pull`s the files.
- **Work in progress does not block the alignment.** On the side that moves, the uncommitted changes stay where they are. It waits only with something staged, on both sides, or with a git operation in progress.
- **Branch change.** When a side moves to another branch, the other stays on its own and the files of the new branch reach it as changes: the state says so. To follow it without touching the files:

  ```bash
  git fetch origin && git branch <branch> origin/<branch> && git symbolic-ref HEAD refs/heads/<branch> && git reset
  ```

Manual commands:

```bash
corami sync status               # the two sides and their relation with origin, per local copy
corami git watch [proj]          # the cycle of the service, in the foreground: useful to understand
corami git watch [proj] --once   # one cycle only, without staying in listen mode
```

- **The `.git` of a new local copy:** `corami sync <project>` gives the copy its own repository. It reads the url of `origin` and the branch of the server from `GET /v1/projects/<p>/git/state`, clones without checkout into a temporary folder next to the copy and moves the `.git` in. When the branch of the server exists on `origin` the copy goes on it, otherwise it stays on the default branch and the command says so. `git reset` then rebuilds the index from `HEAD` without touching the files, which are the ones of the sync. The clone uses the git credentials of the client, never prompts, and when it fails the files are synced anyway: `corami sync <project>` run again retries, and does nothing on a copy that already has its `.git`. `--no-git` skips it. From there the git watch service works on its own.
- **Removing the local copy:** `corami sync rm` stops when the local `.git` has commits or stashes that exist in no remote. With a single remote, `origin`, git counts by itself: a commit the side has already pushed does not block, one never pushed does.
- The alignment arrives at the next cycle, within a minute, not at the instant of the commit.

## Importing a local project

`corami project import [path]` moves to the server a project that today lives on a client, with all the git history and the necessary files that git ignores. At the end the local folder becomes a synced copy, at the same path.

### What is transferred

| What | Destination | How |
|---|---|---|
| Working tree and complete `.git` (local branches, unpushed commits, uncommitted changes, untracked files, stashes, hooks, LFS, submodules) | `~/projects/<project>`, and a copy of the `.git` in the local copy | tar streamed over Tailscale SSH, then the `.git` copied from the old local folder into the new copy |
| `.env*` files | project folder on the server, permissions 0600 | inside the same archive |
| Files that look like keys or credentials (e.g. `*.jks`, `*.keystore`, `*.p8`, `*.p12`, service account JSON) | none: they stay on the client | excluded from the archive, listed in the summary |
| Other files ignored by git and not regenerable | the project folder on the server, when selected with `--include <glob>` | inside the archive |
| Paths in `local-copy.ts` (`node_modules`, `.next`, `build`, `.dart_tool`, `ios/Pods`...) | none | excluded, the server regenerates them |

### Sequence

1. **Preliminary checks:** no project with the same name on the server (`project_exists`), server reachable, git credentials of the server configured.
2. **Inventory:** `git ls-files --others --ignored --exclude-standard` lists the ignored files. Corami drops the regenerable ones and classifies the rest: env, possible keys, other. The content of the files is never printed nor written to the logs.
3. **Selection:** env files are included, other files only with `--include <glob>`, repeatable. Files that look like keys are never uploaded and the summary says where they stay.
4. **Transfer:** local `tar` streamed to `tar` on the server over SSH. On macOS with `COPYFILE_DISABLE=1`, to leave out the `._*` files. Windows uses the system `tar.exe`.
5. **Verification:** `corami` computes a sha256 manifest of the transferred files on both sides and compares the output of `git for-each-ref` and `git stash list`. When something does not match, it stops with an error and the local folder stays intact.
6. **Git cleanup on the server:** `git worktree prune` (local worktrees are not imported and are listed in the summary). A warning when `.git/config` contains absolute paths or a credential helper of the local machine.
7. **Registration:** the project is added to the registry, like `corami project add`.
8. **Converting the local folder:** renamed to `<dir>.corami-backup-<date>`, then `corami sync <project> --path <dir>` creates the synced copy at the same path, so IDE and habits do not change. After the sync, the `.git` of the renamed folder (which is never moved: it stays complete) is copied into the new local copy, so the local side and the server side each have their own repository. Right after, the local copy runs `git fetch` on `origin` and aligns with a mixed reset, when needed.
9. **Summary:** files moved per category, the key files left on the client, worktrees not imported, path of the renamed folder. It is never deleted automatically.

### Git on the server

The import and the agents work only when the server can fetch and push on its own, even with the laptop closed. That is why the server has an SSH key of its own: the SSH agent forwarding of the client would not be enough. Only `git` over SSH is used, without provider CLIs.

Step `corami setup git` (re-runnable):

1. It generates `~/.ssh/id_ed25519_corami` with `ssh-keygen -t ed25519 -N "" -C corami@<machine-name>` when missing. Without a passphrase, because the agents use it with nobody in front.
2. It writes into `~/.ssh/config` an entry for every chosen provider (`github.com`, `gitlab.com`, `bitbucket.org`, custom hosts) with `IdentityFile` and `IdentitiesOnly yes`.
3. `known_hosts`: for GitHub, GitLab and Bitbucket it uses the host keys pinned in `pinned-tools`, checked against the fingerprints published by the providers. For custom hosts it runs `ssh-keyscan` and asks to confirm the fingerprint.
4. It shows the public key and the direct link to the page to add it (e.g. `https://github.com/settings/ssh/new`), then waits.
5. It verifies with `ssh -T git@<provider>` and repeats step 4 until the key is accepted.
6. It rewrites HTTPS remotes to SSH for the chosen providers, with a global `url."git@github.com:".insteadOf "https://github.com/"`. That way repositories cloned over HTTPS, and git dependencies over HTTPS, use the same key.

More:

- After the import the `.git` lives in the local copy too, managed separately with git commands (see "Git" under "Sync"). The server has its own, with its own key.
- The key has access to all the repositories of the account, like any user key. It is revoked from the provider settings. Per-repository keys are an idea for the [v2](v2/README.md).
- Commit identity (`user.name`, `user.email`): proposed by copying the global git config of the client at the first client setup.
- Before the import, `git ls-remote` on the remote of the project, run from the server, confirms the access. When it fails, the remedy is `corami setup git`.
- `corami doctor git` checks key, `known_hosts`, access to every provider and identity.
- No provider CLIs in v1. The integration with PRs and issues (e.g. `gh`) is an idea for the [v2](v2/README.md).

## Backup

Corami has no backup of its own: restic with a timer, or a snapshot of the provider, is the user's choice. What to save (`~/projects`, `~/.corami/config.json`, `~/.ssh`), what to leave out (the regenerable folders of `local-copy.ts`) and how to restore on a new server are in [backup.md](backup.md).

Two notes for the code:

- `~/.corami/state.db` holds the project registry and the preview addresses, nothing else: the registry is recreated with `corami project add`, the addresses with `corami serve`, so the file is optional in a backup.
- After a restore the daemon reconciles the `tailscale serve` rules of the preview range at its next start (`planServeRules`), so no rule has to be copied by hand.

## Daemon API (v1)

All routes are under `/v1`, authenticated with the Tailscale identity headers and answered in the standard envelope.

| Method | Route | Use |
|---|---|---|
| GET | `/health` | name, version, uptime, Tailscale state |
| GET | `/projects` | list, with the previews of each project |
| POST | `/projects` | add: clone from a url or register a folder |
| GET | `/projects/:project` | detail: path, repo url, previews |
| DELETE | `/projects/:project` | remove the project, its previews and its folder |
| GET | `/projects/:project/git/state` | git state of the project on the server, read at the moment, and the url of its `origin` |
| GET | `/projects/:project/previews` | previews of the project |
| PUT | `/projects/:project/previews/:name` | register or move a preview: `{ "target_port": 3000 }` |
| DELETE | `/projects/:project/previews/:name` | remove the preview and its serve rule |
| GET | `/previews` | every preview with `url` and `responding` |

### SQLite tables

```
projects(name, path, repo_url, created_at)
previews(project, name, public_port, target_port, created_at)
```

## CLI output contract

- With a TTY stdout: tables and text. Without a TTY or with `--json`: JSON.
- The text of the commands of a first run (`setup`, `project add`, `project import`, `sync`, `corami` alone) ends with the commands to run next, chosen by the pure functions of `src/core/next-steps.ts` from the role of the machine and the projects of the server. The JSON does not carry them.
- Envelope:

```json
{ "ok": false, "error": { "code": "server_unreachable", "message": "Cannot reach the Corami daemon at https://corami.tail1a2b3c.ts.net:7420/v1/projects", "fix": "On the server: systemctl status corami-daemon" } }
```

| Exit code | Meaning |
|---|---|
| 0 | ok |
| 1 | generic error |
| 2 | wrong usage |
| 3 | missing capability: a command the tool needs (Mutagen) is not there |
| 4 | sync conflict |
| 5 | server unreachable |

Stable error codes: `capability_missing`, `server_unreachable`, `sync_conflict`, `local_only_files`, `project_exists`, `config_invalid`, `usage`, `generic`.

## Harness

Corami does not install, configure or start the harness, and it has no code dedicated to any harness. The user picks whatever they prefer. Corami offers only what any harness needs:

- projects on the server and previews, all usable from the CLI with JSON output;
- the instructions for the agent in the [quick start](quickstart.md#tell-the-agent-about-corami), to copy into `AGENTS.md`;
- HTTPS on the tailnet through `tailscale serve`, which the user uses directly;
- a place where the harness data lives, that the user's backup can include.

**Run the harness on the server.** The sessions then live on the always-on machine: a client closes, another opens, and the work is there, half way through a task. The clients are windows on the server (`opencode attach`, a web UI), not a second place where agents run. A harness on a client keeps its sessions only on that client.

### Recipe

The recipe for opencode, ready to copy, is in the [quick start](quickstart.md#4-your-agent-always-on): a user systemd service that runs `opencode serve --hostname 127.0.0.1 --port 4096` with `OPENCODE_SERVER_PASSWORD` set, a `tailscale serve` rule, `opencode attach https://<fqdn>:4096` from a client ([docs](https://opencode.ai/docs/cli/#attach)). OpenChamber takes the same steps with its port, and `~/.local/share/opencode` goes in the backup when the session history matters (see [backup.md](backup.md)).

Other harnesses: same shape. A service on `127.0.0.1`, a `tailscale serve` rule, any paths to save. Terminal-only harnesses (e.g. Claude Code) are used over SSH on the server, in a persistent session like tmux.

## Install and updates

### Distribution: GitHub only

No domain is needed. Binaries, `checksums.txt`, `install.sh` and `install.ps1` are assets of the GitHub release, reachable at the stable URL `https://github.com/tapeo/corami/releases/latest/download/<file>`. `corami update` reads the GitHub releases too. Previews go through Tailscale and never used a domain.

corami.dev is only the site, with a landing page and the documentation. The binary, the installer and the updates never contact it.

### `install.sh`

```bash
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh -s -- server --owner me@example.com
curl -fsSL https://github.com/tapeo/corami/releases/latest/download/install.sh | sh -s -- client <server>
```

1. It detects OS and architecture.
2. It downloads `corami-<os>-<arch>` from the same release (the latest, or the one given by `CORAMI_VERSION`).
3. It verifies the sha256 with `checksums.txt`.
4. It installs to `~/.corami/bin/corami` and adds that folder to the PATH, once, in the profile of the login shell (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` for bash on macOS). With another shell it says what to add.
5. It runs `corami setup` with its arguments and the terminal as stdin (with `curl | sh` stdin is the script itself): without a role the setup asks for it. Without a terminal it runs only `client <server>`, otherwise it installs the binary and prints both commands. `CORAMI_SKIP_SETUP=1` skips the setup.

`install.ps1` does the same on Windows and always updates the user PATH; it runs the client setup, with `-Client <server>` or asking for the server.

### Setup per role

One binary, two setups. In a terminal they ask what the flags leave out (role, owner, firewall, server) and offer to run a failed step again; without one, or with `--json`, they ask nothing. The questions rest on the pure decisions of `src/core/setup-choices.ts`. Each one is idempotent: every step checks the state before acting, so the setup can be re-run, and `--step <name>` runs a single step, which is also the way to install one service again. Both answer with the envelope (`steps`, each with `step`, `status`, `summary`, `detail`).

| Service | Role | Manager | Installed by |
|---|---|---|---|
| `corami-daemon` | server | systemd: user unit with linger, system unit with `User=` when user services are not available | `setup server`, step `daemon` |
| HTTPS rule on port 7420 | server | `tailscale serve --bg` | `setup server`, step `serve` |
| `corami-git-watch` | server and client | systemd (same scope as the daemon on the server, user on a Linux client), launchd agent `dev.corami.git-watch` on macOS, scheduled task `corami-git-watch` on Windows | both setups, step `git-watch` |
| Mutagen daemon | client | user systemd unit `corami-mutagen` (`mutagen daemon run`) on Linux; `mutagen daemon register` on macOS (launchd agent `io.mutagen.mutagen`) and on Windows | `setup client`, step `mutagen-daemon` |

`corami doctor` checks the git alignment service on every side and the Mutagen daemon service on the clients, with the step that installs them again as the remedy. `corami update` restarts the daemon and the git alignment service after replacing the binary. The Mutagen daemon runs the Mutagen binary, which only changes with the pinned version.

### Server setup

`corami setup server [--owner <login>] [--hostname <name>] [--user <user>] [--firewall]`, Linux only. It runs as root: the account that owns the projects is created by the setup.

1. `preflight`: OS and architecture, root or not.
2. `packages`: minimal apt packages for Corami: `git`, `curl`, `unzip`, `ca-certificates`.
3. `tailscale`: official script, then `tailscale up --ssh --hostname <name>` (default `corami`; the name ends up in the public certificate logs). Without `--auth-key` it prints the login link: in a terminal the setup waits for the approval and goes on, otherwise it stops with `waiting` and is run again after the approval. In a terminal, without `--owner` and without one saved, it then proposes the login that signed the server in as the owner.
4. `hosts`: a line in `/etc/hosts` for its own FQDN.
5. `user`: the account that owns the projects, `corami` by default, `--user` for another name. It is created with `useradd`, the `authorized_keys` of root are copied into it with the right permissions, linger is enabled and its runtime directory awaited, the binary of the setup is copied into its `~/.corami/bin`, the folder is added to its PATH, and it becomes the operator of Tailscale (`tailscale set --operator`), so that it can run `tailscale serve` for the previews without root. The steps that need the machine are run by root, the steps of the account are run again as the account itself with `runuser`, which is what puts their homes, their user services and the paths of `paths()` in the right place. Root never runs the binary of the account, and the account never runs the one of root.
6. `firewall`, with `--firewall`, or with a yes in a terminal when Tailscale SSH is on and the firewall is not in place yet: inbound blocked except on `tailscale0`.
7. `daemon`: `loginctl enable-linger`, then the `corami-daemon` unit as a systemd user service of the account, with the owner login and the FQDN in its environment. It writes the global config with `role: server` and `server_user` in the home of the account. Without user services it falls back to a system unit with `User=` and the home of the account.
8. `git-watch`: the git alignment service, in the same scope as the daemon.
9. `serve`: `tailscale serve` for port 7420, run as the account. It fails, with the remedy, when the HTTPS certificates are not enabled in the Tailscale console.
10. `summary`: the daemon is running. The text then gives its address and the next steps: entering as the account, `corami setup client <fqdn>` on the laptop, the first project. Without `--owner` it warns that every tailnet member can reach the daemon.

Root keeps its own configuration with `server_user`, the account that owns the projects. A command that would write under the home of root on such a server (`project add`, `serve`, `setup git`) stops and says to run it as that account; `setup` and `update` run the steps of the account again as the account, and `doctor` reads.

Separate commands, not steps of the setup: `corami setup git` (SSH key of the server and remotes). Harness, toolchains and backup are the user's.

Without a terminal the setup takes its options as flags. A non-interactive mode for cloud-init is an idea for the [v2](v2/README.md).

### Client setup

`corami setup client [server] [--user <user>] [--no-mutagen]`. It stops at the first failed step. In a terminal the server can be left out: after the `tailscale` step the setup proposes the server already configured, then the online Linux peers of the tailnet where `/v1/health` answers, then asks for the name.

1. `tailscale`: Tailscale installed and online. Corami does not install it on a client: the step fails with the remedy.
2. `daemon`: `GET https://<server>:7420/v1/health`: certificate, reachability, version and owner login.
3. `ssh`: `ssh <user>@<server> true` over Tailscale SSH, in batch mode. The user is `--user`, then the one the daemon announces in `user` (the account that owns the projects on the server), then `root`.
4. `mutagen`: Mutagen from `pinned-tools` in `~/.corami/bin`, unless already present. On Windows it must already be in the PATH.
5. `mutagen-daemon`: the Mutagen daemon as a service (see the table), so that the sync sessions start again after a reboot without a mutagen command. A daemon started on demand is stopped first, because it holds the lock; on macOS a registration that points to another Mutagen binary is replaced.
6. `config`: global config with `role: client`, `server_host`, `server_user` and the owner login.
7. `git-watch`: the git alignment service.

### Updates

`corami update` downloads the new release from GitHub and verifies the sha256 before replacing the binary. On the server it restarts the daemon: as the account when the update runs as the account, through `runuser` when it runs as root, which also replaces the binary of the account. From source the command exits with an error: the binary to replace would be bun. `corami update --check` stays available.

The binaries of the release declare the tag (`--define` in the workflow); every other execution declares `dev`, or the value of `CORAMI_VERSION` when it is in the execution environment.

## Test environment

The server is tested on a real VPS with a public IP, the same one for all phases. The development Mac acts as the client. No local Docker containers. Rule: on the test VPS exactly what a user would do is done, without variables, flags or code paths dedicated to tests.

### Test VPS

- Ubuntu 24.04 x86_64, 4 vCPU, 8 GB RAM, 100 GB SSD. Corami installs everything else.
- Public IPv4 needed: GitHub (releases, `git`, Mutagen) does not answer over IPv6.
- The address of the VPS does not enter the repository.
- Access: root over SSH with a key on the public IP, until the firewall step of the setup closes it. From there Tailscale SSH is used. When both are lost, the provider console.
- Tailscale with the normal interactive login, from an SSH session with a terminal (`ssh -t`).

### Binary

Two ways, neither needs dedicated code:

- Development: `bun run bin`, then `bun run dev:install` installs the local build in place of the official binary and restarts the active services. The complete steps, also to try a build on your own machine, are in `docs/development.md`.
- Installer: on the VPS the real `curl | sh` command is run against a GitHub release (a pre-release works too).

### Fresh server

Reinstallation of the system from the provider panel, after removing the old node from the tailnet (`tailscale logout`, or from the Tailscale console). At the first access after the reinstallation the SSH host key changes: the old line must be removed from the `known_hosts` of the Mac.

### Exposure

The "no port reachable" checks are done from the Mac towards the public IP (e.g. `nc -z <ip> <port>`), not from the server itself: only that way firewall and Docker iptables rules count.
