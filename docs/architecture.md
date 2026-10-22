# Architecture

Implementation details of v1. The invariants of the code, the reasons a name cannot show, are in [internals.md](internals.md).

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
  - [Commands on a client](#commands-on-a-client)
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

- Corami starts no project process and runs no build. Dev servers and builds are commands of the user or of the agent, run where the tools are: the server for most projects, a client with `corami exec` when only that machine can do it (see [builds.md](builds.md)).
- There is no configuration file in the repository. A project is a folder on the server; the sync and the previews find it by its path.
- There is no stack specific code in Corami. The few rules a dev server must respect to be reachable are in [previews.md](previews.md).

### `corami doctor`

Checks with a remedy for each item. One command: there are no areas.

| Check | What |
|---|---|
| `tailscale.installed`, `tailscale.connected` | Tailscale installed and online on both sides |
| `tailscale.ssh_policy` | how Tailscale SSH treats the account of the projects |
| `serve.rules` | the endpoints published with `tailscale serve` |
| `net.exposed_ports` | ports listening outside `127.0.0.1` or on `0.0.0.0` (Docker iptables included) |
| `mutagen.installed`, `mutagen.service` | Mutagen of the pinned version, `~/.corami/bin` in the PATH, the daemon service |
| `mutagen.ignores` | on a client, the sessions whose ignores differ from `DEFAULT_IGNORES` plus `.coramiignore`, with `corami sync refresh` as the fix |
| `git.service` | the git alignment service |
| `server.*` | daemon reachable, account of the projects and its privileges, folders of the projects root that no project names, free space of the projects filesystem (under 10% is a failure) |

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
| `corami daemon` | server | API: project registry, previews, git state, registered clients and the exec key |
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
                          serve, sync, git, update, exec
      output.ts           JSON envelope, TTY tables, exit codes
      server-client.ts    HTTP client towards the daemon
    daemon/
      server.ts           HTTP routing and authentication with the Tailscale headers
      api.ts              projects, previews, git state
      exec-api.ts         exec key, registered clients, probe
      previews.ts         serve rules: apply, remove, reconcile
    core/
      config.ts           global config and paths
      previews.ts         pure functions: ports, names, serve plans, project from a path
      ports.ts            the Corami port range, TCP probes
      pinned-tools.ts     version and sha256 of Mutagen
      local-copy.ts       path rules: what the sync, the import and the copy removal never carry
      git.ts, git-align.ts, git-follow.ts
      exec-rules.ts, exec-gate.ts, exec-ssh-keys.ts, exec-sshd.ts, exec-errors.ts
      paths and helper modules: doctor, errors, exec,
      last-change, release, state, transfer
    integrations/
      tailscale.ts  mutagen.ts  service.ts  ssh.ts  ssh-exec.ts  systemd.ts
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
| Daemon token | `~/.corami/daemon-token` (0600) | |
| Service logs | `~/.corami/logs/` (git watch) | `~/.corami/logs/` |
| Exec channel | `~/.corami/exec/` (`known_hosts`) | |
| Exec key | `~/.ssh/id_ed25519_corami_exec` | |
| Projects | `~/projects/<project>`, or the folder chosen with `--server-path` | the folder given as the argument of `project add` and kept by the session. Never guessed |

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

What the user has to keep in place, in order of weight, is in [security.md](security.md).

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
- Every request must be the owner: the login of the header must match `owner_login`, otherwise it is refused with 403. Requests that carry no header at all are refused too, because on a shared tailnet and for tagged devices they arrive through serve without one. See `authorize` in `src/core/daemon-auth.ts`, covered by tests.
- The commands of the server itself, and the agents, have no login header: they present the token of `~/.corami/daemon-token`, written by the daemon with permissions 0600 in the home of the account that owns the projects. The token is never configured and never travels: it is a file of that account.
- Without `owner_login` no login can be checked: every header is refused, with a message that says how to set the owner. The setup asks for it (`--owner`, or the Tailscale login of the server).
- A request that carries `Origin`, or a `sec-fetch-site` other than `none`, comes from a browser and is refused: the API is not called from a page. A body is only read when its `content-type` is `application/json`, so a page cannot reach the API with a form or a plain-text POST.
- Previews and any user services exposed with `tailscale serve` are reachable by everyone in the tailnet. In a tailnet used only by the owner that is the intended behaviour. In a shared tailnet, access to the server must be limited with a Tailscale ACL rule, once, from the console: the setup reminds about it.
- A harness can run code: when it offers its own authentication (e.g. `OPENCODE_SERVER_PASSWORD` in opencode), the recipe turns it on.

### Other

- Optional firewall (ufw): inbound blocked on every interface except `tailscale0`. The setup applies it only after verifying that Tailscale SSH works, and only with explicit confirmation.
- Docker writes its own iptables rules and bypasses `ufw`: a port published by a container without `127.0.0.1:` in front is reachable from the public IP even with the firewall on. `corami doctor` reports it, and [previews.md](previews.md) explains how to avoid it.
- The setup adds the line `<tailscale-ip> <magicdns-fqdn>` to `/etc/hosts`. That way the server reaches its own HTTPS URL even without local MagicDNS.
- The default SSH policy of a tailnet is `check`: every 12 hours Tailscale asks the user to authenticate in a browser before an ssh connection goes through. Corami runs ssh in batch mode, so the import, the sync and `setup client --step ssh` stop at each expiry. The server reads the policy from `tailscale debug netmap` and the daemon reports it in `/health` (`tailscale.ssh_policy`, `tailscale.ssh_root`, `tailscale.ssh_accounts`); `corami doctor` and the setup warn when the account of the projects is on `check`. The remedy is in [security.md](security.md#the-ssh-rules-of-the-tailnet).

## Projects

A project is a folder on the server plus a row in `projects(name, path, repo_url, created_at, owned)`. `corami project add` takes it from a repository, from a folder of this machine or from a folder already on the server: whatever the source, it registers the project, creates the copy of the client with its session, and rolls the registration back when the copy fails. `owned` says whether Corami made the folder: `corami project rm --on server` deletes only the ones it made, and a folder registered where it was stays on disk.

- **The name is the key.** `~/projects/<name>` on the server unless `--server-path` says otherwise, `corami-<name>` for the Mutagen session. The folder of a client is chosen there and kept by the session: Corami never derives it from the name.
- **No file in the repository.** `corami serve` finds the project with `projectForPath` (`src/core/previews.ts`): the longest registered path that contains the current folder. From a client, the sync commands use the sync sessions instead.
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
- The record is written before the rule is created: two registrations arriving together cannot pick the same public port, and a rule that cannot be created leaves no record behind. Changing the target is another `tailscale serve` on the same port, which moves the proxy: no `off` first.
- `tailscale serve` holds the whole serve configuration, so two runs at the same time fail one of them ("another client is changing the serve config"). The daemon serializes every change of a rule and tries the transient failure once more.
- At startup the daemon reconciles (`reconcileServeRules`): `planServeRules(desired, current)` is a pure function (`src/core/previews.ts`, covered by tests) that says which rules to apply and which to remove, comparing port and target, and considering only the Corami range. Rules without a record are removed, so leftovers of an older version disappear by themselves; a rule pointing at the wrong port is applied again. Rules outside the range are the user's.
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

Nothing in Corami runs a build or a project command. The details, including builds on a client with `corami exec` and the rules for keys, are in [builds.md](builds.md).

- **Dependencies:** each machine installs them with the command of the project (`pnpm install`, `flutter pub get`). Lockfiles are synced, the dependency folders are not, because they contain native binaries and absolute paths of the machine.
- **Advice, not obligations:** pnpm with its global store (same file system as the local copies, for hard links), FVM with `.fvmrc` for Flutter. Corami does not check them.
- **A long build on the server** competes with the previews for CPU: run it with `nice` and close the toolchain daemons at the end (`gradlew --stop`).

### Commands on a client

`corami exec` runs a command of the server inside the synced copy of a client. The agent lives on the server; a simulator, `xcodebuild` or a device plugged into a Mac need the Mac.

- `corami exec setup`, run once on the client, writes a line of `~/.ssh/authorized_keys`: `command="<corami> exec gate"`. The key of the server opens nothing but the gate. It is idempotent and writes the line again when the binary of the client moves.
- The gate takes no decision on the command. It finds the copy of the project, flushes the sync, runs the command and streams the result back. The control is in the harness on the server, which decides which `corami exec` it allows.
- The server sends a base64url JSON in `SSH_ORIGINAL_COMMAND`: `{ "v": 1, "project": "myapp", "argv": [...] }`. The gate flushes the sync, runs `[$SHELL, "-lc", "exec \"$@\"", ...argv]` in the copy, and streams stdout, stderr and the exit code back.
- An ssh session without a pty sends no signal to the gate when the connection closes: the gate watches its parent process, and when it changes it stops the process group of the command.
- Output is the exception to the CLI contract: without `--json` it is the stdout and stderr of the command, even without a TTY. `--json` collects them in the envelope with `client`, `project`, `exit_code`, `stdout`, `stderr`, `duration_ms`.
- The server keeps `clients(name, ssh_host, ssh_user, os, host_key, updated_at)`, the dedicated key `~/.ssh/id_ed25519_corami_exec` and `~/.corami/exec/known_hosts`, with `StrictHostKeyChecking=yes`: no trust on first use.
- `GET /v1/exec/key` gives the public key; `PUT /v1/clients/<name>` registers the client with its host key; `POST /v1/clients/<name>/probe` enters with a probe payload, which executes nothing.

## Worktrees

In v1 Corami does not manage worktrees. Harnesses can create them on the server as they prefer; a worktree is not a project and has no preview. If needed, they can enter the backup the user sets up (see [backup.md](backup.md)). Parallel previews per worktree or branch: an idea for the [v2](v2/README.md).

## Verification for agents

Corami ships no checker: the preview is a normal HTTPS page, and the agent opens it with the browser of its harness, or with a browser tool the harness offers (a Playwright or chrome-devtools MCP, for example). There it sees the console, the network, the screenshot, and it can click, fill forms and log in, which a one-shot screenshot command could not do. The address to open is `url` in the output of `corami serve` and of `corami serve ls`.

### Instructions for the agent

The instructions to give the agents are a block to copy into `AGENTS.md`, in the [quick start](quickstart.md#tell-the-agent-about-corami). Corami no longer writes the file by itself.

## Sync

### Mutagen session

One session per project, created by `corami project add` on a client, whatever the source:

```bash
mutagen sync create \
  --name corami-<project> \
  --mode two-way-safe \
  --ignore-vcs \
  --ignore <list> \
  corami@<server>:~/projects/<project> \
  <folder>
```

- Alpha is the server, beta is the client: the folder of the copy, the only record of where it is. The server path is the folder the daemon has for the project, so a project registered with `--from-server` syncs from where it is.
- `two-way-safe`: conflicts that cannot be solved without losing data stay pending and are reported ([docs](https://mutagen.io/documentation/synchronization/)).
- SSH goes through Tailscale SSH, so no keys to distribute.
- Mutagen daemon persistence: `mutagen daemon register` on macOS and Windows, user systemd unit `corami-mutagen` on Linux. The `mutagen-daemon` step of `corami setup client` installs it, and `corami doctor` checks it.

### Default exclusions

One table of rules in `local-copy.ts` (`PATH_RULES`) is the only source of the paths the sync treats in a special way. Every rule is a pattern and one of two classes:

| Class | Meaning | Example |
|---|---|---|
| `regenerable` | rebuilt by every machine, never carried | `node_modules/`, `dist/`, `.build/`, `DerivedData/`, `xcuserdata/`, `._*`, `.DS_Store` |
| `local_only` | generated for one machine, with paths that would break the build of another | `android/local.properties`, `ios/Flutter/Generated.xcconfig`, `ios/.symlinks/` |

A pattern without `/` matches the name at any level, one with `/` at any level too, exactly as in a gitignore: `ios/.symlinks` covers the app at the root and the one under `apps/demo`. A folder rule matches a folder only, so a file named `build` travels.

One walk of the folder, `copyInventory` in `local-copy.ts`, reads the table once with `lstat`, never follows a link, and returns two lists: the entries that travel and the entries of this machine. The manifest, the archive of the import and the removal checks all read that one result, so they cannot count different things. The archive is a list `tar` writes with `--no-recursion`, never a pattern; the remote manifest counts every entry of the folder but `.git`, which the server folder of an import holds alone. `DEFAULT_IGNORES` in `mutagen.ts` derives the sync ignores from the same table through `mutagenPattern`, which gives a rule with `/` the doublestar prefix so it matches at any depth, and `corami project rm --on client` reports the `local_only` entries through `findLocalOnlyFiles`. `test/path-rules.test.ts` packs a fixture with the real archive list, unpacks it, runs the remote manifest script locally and compares the two manifests.

**Symbolic links.** A link is one entry with its target, never a way into another folder. The import carries the links Mutagen carries in its `portable` mode, a rule copied from Mutagen v0.18.1 into `symlinkPortable`: a relative target of safe characters that never leaves the folder. The others, absolute or pointing outside, are entries of this machine: they are neither in the archive nor in the sync, the folder keeps them where they are, and `corami sync status` says `symlinks of this machine, not synced: <path>`. Mutagen reports them as scan problems but keeps syncing, so they are not an error of the session and do not block a removal as a broken sync: they block it as files of this machine, like the other `local_only` entries.

**Everything else travels, a key included.** A file of the project folder is a file of the project: it is in the archive of an import, and the sync keeps it in step on every machine, keys and env files included. Corami does not know what is secret and does not guess from the name: keeping a key off the machines is the user's decision, made by keeping it out of the folder or by injecting it from an external store (a secret manager, a variable of the machine, a file outside the project synced by other means). `AGENTS.md` says the same to the agents: read what is there, and never print a secret in a log.

Files generated with absolute paths of the machine (`Generated.xcconfig`, `local.properties`) stay excluded, otherwise they would break the build on the other machine. Lockfiles (`pubspec.lock`, `Podfile.lock`, JS lockfiles) are synced.

**`.coramiignore` in the project.** A pattern the table does not know but the project does goes in `.coramiignore` at the root of the folder: one Mutagen pattern per line, `#` starts a comment, no negation, no absolute path, no `..`. The file travels with the project, so every machine reads the same rules, and the agent on the server can add one when a build writes a new cache. A bad line is a `config_invalid` error with its line number.

**A session keeps the ignores it was created with.** `DEFAULT_IGNORES` and `.coramiignore` are read when the session is created. `corami sync status` compares the ignores of the session with the two lists and says `ignores out of date` when they differ, `corami doctor` reports the same as `mutagen.ignores`, and `corami sync refresh` terminates the session and creates it again with the current lists. Nothing is lost: the first cycle of a recreated session compares the two trees with no ancestor, so a file edited on both sides becomes a conflict, not a deletion. A session that leaves out paths this Corami would carry (typically `.env` and keys, from a version that excluded them) is not refreshed without `--force`, because those files would start traveling.

### State and conflicts

- `corami sync status --json` reads `mutagen sync list --template '{{ json . }}'` and returns state, last cycle, conflicts, the ignores of the session, the heavy entries and the last change.
- **Heavy entries.** A file of 500 MB or more, or a folder of 2 GB or more among the ones the sync carries, is reported with its apparent size (the one Mutagen hashes and writes). A build cache no rule covers is the usual case: the sync stays in `Scanning files` on every change, and a sparse file of the client becomes a full one on the server. `corami sync status <project>` looks at the folder, and so does the `sync_pending` error of `corami exec`, which names the heaviest path and the ignore to add.
- `corami sync status` shows the local and the server path of each conflict. To resolve one, delete the copy that should lose, on this machine or on the server: Mutagen then syncs the other one to both sides, which is the resolution method documented by Mutagen ([docs](https://mutagen.io/documentation/synchronization/)). No dedicated command: it would only wrap one deletion. The `sync_conflict` error of `corami project rm --on client` gives the same fix.
- Sync hides behind a `SyncEngine` interface, so it can move to Syncthing if needed.

### Removing the local copy

`corami project rm <project> --on client` frees space on a client: it deletes **only** the local copy of that client. Project, git and previews on the server stay untouched. `corami project add <folder> --from-server --name <project>` recreates it at any time. It acts only on the folder of the session: without one there is no copy to remove, and no other folder to point it somewhere else.

`corami sync stop <project>` is the other way out: the session of this machine goes, the files stay as a plain folder. It is what a copy whose project is gone from the server needs, because `project rm --on client` would be deleting the last copy of the work. Mutagen reports the missing folder on one side as a conflict on the root itself, with an empty path, so `sync status` shows it as the folder of the project and no file inside; `corami project add <folder>` puts that folder back on the server when the name is free.

Sequence, in order:

1. **Flush:** `mutagen sync flush`, so every local change reaches the server. When it fails, the removal stops with `sync_pending`: nothing of the copy may go before its work is on the server.
2. **State:** the session must be `watching`, with no last error and no conflicts. Any other state (`connecting`, `scanning`, `staging`, `disconnected`) is a `sync_pending`: the changes may still be on the way.
3. **Conflicts:** when the session has open conflicts, it stops with `sync_conflict`. The local side of a conflict would be lost.
4. **Sync problems:** when Mutagen reports unreadable or untransferred files, it stops with the list of files.
5. **Local-only files:** it looks for the entries the sync never carries because they belong to this machine, from the inventory of `local-copy.ts`: the paths of the rules (`android/local.properties`, `ios/Flutter/Generated.xcconfig`, `ios/Flutter/flutter_export_environment.sh`, `ios/.symlinks/`, at any depth) and the links that point outside the folder, shown with their target (`pub-cache -> /Users/me/.pub-cache`). No other machine has them, so deleting the copy deletes the only copy. When there are any, it stops with `local_only_files` and the list; `--force` deletes them anyway.
6. **Local git:** when the `.git` of the copy has commits or stashes that exist in no remote (typically work done on the copy without a push), it stops with `local_only_files`. Commits already elsewhere do not block.
7. **Closing the sync:** `mutagen sync terminate`. It must be done **before** deleting: with the session active, Mutagen would propagate the deletions to the server.
8. **Deletion** of the local folder.
9. **State cleanup:** a record in `~/.corami/sync-state.json` (removal date, freed space).

When the deletion is interrupted (e.g. an open file on Windows), the server is not at risk because the session is already closed. The state becomes `removal_incomplete` and running the command again completes the work.

Caches outside the project folder (pnpm store, `~/.pub-cache`, Gradle caches, Xcode DerivedData) are not touched.

#### Projects not used recently

- Last activity of a project on a client: the newest value between the last `corami` command run on that project from this machine and the last change of a synced file, excluding the regenerable folders.
- It is a heuristic: the changes of the agent on the server count as activity too, because they arrive through the sync. A project the agent works on is not proposed for removal.
- `corami sync status` shows for every local copy the space it takes, the last activity and the git state of the two sides.
- `corami sync prune --unused <duration>` acts only on the local copies of the client it is run from, never on the server. It lists the candidates with the space that would be freed, asks for confirmation, then removes each copy. A project whose removal checks block is skipped and reported, without stopping the others. `--dry-run` shows only the list, `--yes` skips the confirmation; without `--yes` it removes nothing.

### Git

Every side has its own `.git`: the client in the local copy, the server in the project folder. The sync keeps the internals of `.git` out and carries one folder only, `.git/corami/`, where each machine publishes the commits `origin` does not have and the branch it is on. The two repositories never exchange their internal files, and a commit reaches the other sides even before a push.

**What each side publishes.** Per machine, two files in `.git/corami/`, with one writer each: `<machine>.json` with `branch`, `commit` and `branch_epoch`, and `<machine>.bundle`, made with `git bundle create <file> <branch> --not --remotes=origin`, so it holds the commits `origin` is missing and is absent when there are none. The machine name is the short tailnet name. Every file is written in `.git/`, which is ignored, and then renamed into `.git/corami/`, so a half-written file never travels. The rules are `/.git/*`, `!/.git/corami/` and `*/**/.git` (`GIT_IGNORES` in `src/integrations/mutagen.ts`). Mutagen scans an ignored folder only if the folder is there when the session is created, so `project add` and `sync refresh` publish the head of this machine before creating the session, and reset the session once when the folder appeared after it. A project whose root `.git` is a file, as a worktree writes it, keeps `--ignore-vcs` and gets no peer exchange.

**The move.** The same rule on both sides, still a pure function: the candidates are `origin/<branch>` and the bundles of the other machines on the same branch. The side moves only to the furthest candidate on a single line, the one that descends from HEAD and from every other candidate; when the candidates diverge among themselves it moves nowhere. The bundle is fetched into `FETCH_HEAD`, without a remote and without a ref. A bundle that needs a commit of `origin` this side does not have waits for the next fetch.

**Waiting for the files.** Before moving the HEAD the cycle checks that the incoming changes **have arrived**: a file added between the two commits must be on disk, a deleted one must be gone, a modified one must no longer carry the old content. An empty `.git/corami/` folder on a side is not a repository: `hasGitRepository` in `src/core/git.ts` asks for `.git/HEAD`.

The HEAD move cannot jump over a just-made commit: `git update-ref refs/heads/<branch> <new> <old>` moves the ref only when the expected value still holds, and then `git reset -q` fixes the index. When a commit arrived in the meantime, nothing happens and the next cycle retries. On sides with something staged it waits: the reset is mixed and that work would be lost.

**Branch switch: the last one wins.** The json of each machine carries a `branch_epoch`. A switch made by hand sets it to the highest value seen among the machines plus one; a machine that follows a switch adopts the epoch of the winner without raising it, so nothing bounces. The highest epoch wins, ties go to the machine name first in alphabetical order. A side follows only when the files of the target commit are here, nothing is staged, no operation is in progress, and its local ref is missing or an ancestor of the target. Then `git update-ref`, `git symbolic-ref` and a mixed reset, which leave the files alone, and the upstream when `origin` has that branch.

**Divergence.** Two sides that commit from the same base with the shared working tree end with diverged histories. Nothing moves: the state says so and `corami sync status` suggests, on the side with fewer commits, `git reset <commit>` and a new commit of what remains. The mixed reset leaves the files alone and the history becomes linear.

Who does what:

- **The same cycle runs on both sides:** `corami git watch`, as a service installed by `corami setup client` on the client and by `corami setup server` on the server. On every side it checks the local refs of the project and the files of `.git/corami/` every **two seconds**, and every **minute** it runs `git fetch origin` and the move towards the refs of `origin`. The client works on the local copies (`session.beta`), the server on the projects of `listProjects()`. Every state change of a project produces a **JSON line** (`project`, `status`, `reason`, `from`, `to`, `upstream_commit`, `fetched`), plus a line when a commit of another machine is taken and when the branch changes: on the server it goes to the journal, on the Mac to `~/.corami/logs/git-watch.log`, and with `--json` the line goes to stderr, so stdout stays the only envelope of the command.
- **The daemon never moves anything.** It answers with the state of the server (`GET /v1/projects/<p>/git/state`, which includes the relation with `origin` read without a fetch) and that is it.
- **Passing outcomes retry by themselves.** When `origin` does not answer, when the network is not ready, when the files are not here yet, the next cycle retries. A failed fetch does not block: the decision uses the refs of the last successful fetch.

What does not enter the alignment:

- **A commit does not need a push to reach the other sides.** The bundle in `.git/corami/` carries it, so the other sides align on it within seconds. The push stays an act of whoever makes the commit, and it is what publishes the commit on `origin`: until then `git status` on the other sides says ahead of `origin`.
- **`origin` stays the place where things are published.** For a commit that arrived from outside (a merged PR on GitHub, another machine) a `git pull` is needed on any side: the others follow once the sync has delivered the files. The alignment alone never `pull`s the files.
- **Work in progress does not block the alignment.** On the side that moves, the uncommitted changes stay where they are. It waits only with something staged, on both sides, or with a git operation in progress.

Manual commands:

```bash
corami sync status               # the two sides towards origin and the heads of the other machines, per local copy
corami git watch [proj]          # the cycle of the service, in the foreground: useful to understand
corami git watch [proj] --once   # one cycle only, without staying in listen mode
```

- **The `.git` of a new local copy:** `corami project add` gives the copy its own repository. It reads the url of `origin` and the branch of the server from `GET /v1/projects/<p>/git/state`, clones without checkout into a temporary folder next to the copy and moves the `.git` in. When the branch of the server exists on `origin` the copy goes on it, otherwise it stays on the default branch and the command says so. `git reset` then rebuilds the index from `HEAD` without touching the files, which are the ones of the sync. The clone uses the git credentials of the client, never prompts, and when it fails the files are synced anyway: the command run again retries, and does nothing on a copy that already has its `.git`. `--no-git` skips it. From there the git watch service works on its own, and the sync of `.git/corami/` does not pass for a repository, so the clone still happens.
- **Removing the local copy:** `corami project rm --on client` stops when the local `.git` has commits or stashes that exist in no remote and in no other machine, counted from `.git/corami/`. A commit pushed, or published by another side, does not block the removal.
- The alignment arrives within seconds for the commits of a machine, within a minute for the refs of `origin`.

## Importing a local project

`corami project add <path>` copies to the server a project that today lives on a client, with all the git history and the necessary files that git ignores. The server becomes the source of truth, and the folder of this machine stays where it is and becomes its synced copy: its files are never moved, and from then on only the sync writes into it.

### What is transferred

| What | Destination | How |
|---|---|---|
| Working tree, keys and env files included (`.env*`, `*.jks`, `*.keystore`, `*.p8`, `*.p12`, service account JSON, `android/key.properties`) | `~/projects/<project>`; stays in the folder of this machine | tar streamed over Tailscale SSH; the folder becomes the synced copy, and the first cycle finds the same files on both sides |
| Complete `.git` (local branches, unpushed commits, uncommitted changes, untracked files, stashes, hooks, LFS, submodules) | `~/projects/<project>`; stays in the folder of this machine, not synced | inside the same archive; the sync leaves the local `.git` alone |
| Paths in `local-copy.ts` (`node_modules`, `.next`, `build`, `.dart_tool`, `ios/Pods`..., and the files of one machine: `android/local.properties`, `Generated.xcconfig` at any depth) | none | excluded: the server regenerates them and this machine keeps its own |
| Links to another folder (absolute, or relative and leaving the folder) | this machine only | neither in the archive nor in the sync: they stay where they are |

### Sequence

1. **Preliminary checks:** no project with the same name on the server (`project_exists`), server reachable, git credentials of the server configured, and a daemon that announces the `import_staging` capability: a server that is not updated stops the command before anything is written.
2. **Inventory:** one walk of the folder, `copyInventory`, lists the entries that travel and the entries of this machine, links included, and says how many links point outside the folder. The content of the files is never printed nor written to the logs.
3. **Transfer:** the entries of the inventory, keys included, and the whole `.git`, enter the archive. The summary names the entries of this machine that stay here, because they are the only ones the server will not have.
4. **Transfer:** local `tar` streamed to `tar` on the server over SSH, both started with their arguments and never through a shell. The archive lands in the staging folder of the import, `.corami-import-<project>-<time>`, next to `~/projects/<project>`: the name of the project stays free until the registration gives it to the copy. The list of the inventory goes to `tar` on stdin (`--null --no-recursion -T -`), so no pattern decides what the archive holds. On macOS with `COPYFILE_DISABLE=1`, to leave out the `._*` files. Windows uses the system `tar.exe`. The archive leaves `tar` uncompressed: corami counts its bytes for the progress line, compresses them with gzip and gives them to `ssh`, so the server runs the same `tar -xzf` whatever the transport accepts for compression.
5. **Verification:** `corami` computes a sha256 manifest of the entries of the staging folder and of the folder of this machine, one line per file, link and folder, and compares the output of `git for-each-ref` and `git stash list`. When something does not match, it stops with an error that names the paths present on one side only, removes the staging folder, and the local folder stays intact.
6. **Git cleanup on the server:** `git worktree prune` (local worktrees are not imported and are listed in the summary). A warning when `.git/config` contains absolute paths or a credential helper of the local machine.
7. **Registration:** the daemon renames the staging folder to the name of the project and writes the registry in the same call. A registration that fails puts the folder back to staging. A client that stops in the middle leaves the staging folder or a registered project, never a folder that no project names, and `corami doctor` reports the staging folders that are left.
8. **Converting the local folder:** the folder is not renamed and is not copied: it becomes the synced copy at the same path, so the IDE, the build outputs and the folders of this machine (`node_modules`, `build`, `Pods`..., links that point outside) stay as they are. The session is created on the folder that already holds the files that were just verified, and `two-way-safe` does not touch a file that is the same on both sides. A file that changes here between the verification and the first cycle becomes a conflict, with both versions kept, never an overwrite. When the session cannot be created, the project is taken off the server again; the folder of this machine was never written by the command. In a terminal, `project add` then waits for the first cycle: Ctrl+C stops the wait and leaves the session running. Without a terminal, or with `--json`, the command answers as soon as the session exists, as it always did.
9. **Summary:** files copied, the entries of this machine left here, worktrees not imported, and the conflicts of the first cycle when there are any, with the command that resolves them.

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
- The key and the access to every provider are checked by `corami setup git` and by the import; `corami doctor` checks the git alignment service (`git.service`).
- No provider CLIs in v1. The integration with PRs and issues (e.g. `gh`) is an idea for the [v2](v2/README.md).

## Backup

Corami has no backup of its own: restic with a timer, or a snapshot of the provider, is the user's choice. What to save (`~/projects`, `~/.corami/config.json`, `~/.ssh`), what to leave out (the regenerable folders of `local-copy.ts`) and how to restore on a new server are in [backup.md](backup.md).

Two notes for the code:

- `~/.corami/state.db` holds the project registry and the preview addresses, nothing else: the registry is recreated with `corami project add`, the addresses with `corami serve`, so the file is optional in a backup.
- After a restore the daemon reconciles the `tailscale serve` rules of the preview range at its next start (`planServeRules`), so no rule has to be copied by hand.

## Daemon API (v1)

All routes are under `/v1`, authenticated with the Tailscale identity headers and answered in the standard envelope. The HTTP status follows the error: 400 for a wrong request, 404 for what is not there, 409 for a name already taken, 502 when the daemon could not reach something else, 500 for everything else. The clients read the envelope, not the status.

| Method | Route | Use |
|---|---|---|
| GET | `/health` | name, version, capabilities, uptime, Tailscale state, SSH policy for the account of the projects (`accept`, `check`, `denied`, or null) |
| GET | `/projects` | list, with the previews of each project |
| POST | `/projects` | add: `{ "name": ..., "url": ... }` clones into the folder of `"path"` or `~/projects/<name>`, `{ "name": ..., "path": ... }` registers a folder that is there; `"owned": true` says Corami made the folder; `"staging"` is the folder of an import next to `"path"`, which the daemon moves into place while it registers the project |
| GET | `/projects/:project` | detail: path, repo url, previews |
| DELETE | `/projects/:project` | remove the project and its previews; the folder only when the registry says Corami made it |
| GET | `/projects/:project/git/state` | git state of the project on the server, read at the moment, and the url of its `origin` |
| GET | `/projects/:project/previews` | previews of the project |
| PUT | `/projects/:project/previews/:name` | register or move a preview: `{ "target_port": 3000 }` |
| DELETE | `/projects/:project/previews/:name` | remove the preview and its serve rule |
| GET | `/previews` | every preview with `url` and `responding` |
| GET | `/exec/key` | public key of the dedicated exec key |
| GET | `/clients` | registered clients |
| PUT | `/clients/:name` | register a client: `{ "ssh_host": ..., "ssh_user": ..., "os": ..., "host_key": ... }`; the host key goes into `known_hosts` |
| POST | `/clients/:name/probe` | enters the client with a probe payload, which executes nothing |

### SQLite tables

```
projects(name, path, repo_url, created_at, owned)
previews(project, name, public_port, target_port, created_at)
clients(name, ssh_host, ssh_user, os, host_key, updated_at)
```

`owned` tells a folder Corami made (a clone, an import) from one registered where it was. A database written before the column existed fills it with the rule of the day, "inside the projects root". A database written before `clients` lost `allowed` keeps the column, with its default, and Corami ignores it: the truth of the connection is the key line on the client.

## CLI output contract

- With a TTY stdout: tables and text. Without a TTY or with `--json`: JSON.
- In a terminal, `project add` and the setup show the phase they are running on one line, erased when the phase ends. A bar with a percentage appears only where a real counter knows the total: the bytes of the upload, the bytes of the sync (the files when the size is not known), the objects of a clone. With `--json`, or without a terminal, that line is not drawn and the output does not change.
- The text of `setup server` and `setup client` ends with the commands to run next, on the other machine or for the first project. The JSON does not carry them.
- `corami exec --on` is the exception: without `--json` it passes stdout, stderr and the exit code of the command through, even without a TTY. `--json` collects them in the envelope.
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

Stable error codes: `capability_missing`, `server_unreachable`, `sync_conflict`, `sync_pending`, `local_only_files`, `project_exists`, `config_invalid`, `usage`, `generic`. `sync_pending` is a copy whose last changes have not reached the server: it exits with 4, like a conflict.

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

`corami doctor` checks the git alignment service on every side and the Mutagen daemon service, with the command that installs them again as the remedy. It asks launchd whether the agent runs, not only whether it is loaded: an agent that cannot start is reported with its last exit code.

`corami update` restarts the daemon and the git alignment service after replacing the binary. On macOS the launch agent is registered again, not restarted: `launchctl kickstart` reuses the launch constraint that Background Task Management attached to the previous binary, so an agent that changes binary can fail to start with `EX_CONFIG` (78). The update writes the plist again and runs `bootout` and `bootstrap`, as the setup does, then waits until the agent runs and reports the failure with its exit code and the command that repairs it. The Mutagen daemon runs the Mutagen binary, which only changes with the pinned version.

### Server setup

`corami setup server [--owner <login>] [--hostname <name>] [--user <user>] [--firewall]`, Linux only. It runs as root: the account that owns the projects is created by the setup.

1. `preflight`: OS and architecture, root or not.
2. `packages`: minimal apt packages for Corami: `git`, `curl`, `unzip`, `ca-certificates`.
3. `tailscale`: official script, then `tailscale up --ssh --hostname <name>` (default `corami`; the name ends up in the public certificate logs). Without `--auth-key` it prints the login link: in a terminal the setup waits for the approval and goes on, otherwise it stops with `waiting` and is run again after the approval. In a terminal, without `--owner` and without one saved, it then proposes the login that signed the server in as the owner.
4. `hosts`: a line in `/etc/hosts` for its own FQDN.
5. `user`: the account that owns the projects, `corami` by default, `--user` for another name. It is created with `useradd`, the `authorized_keys` of root are copied into it with the right permissions, linger is enabled and its runtime directory awaited, the binary of the setup is copied into its `~/.corami/bin`, the folder is added to its PATH, and it becomes the operator of Tailscale (`tailscale set --operator`), so that it can run `tailscale serve` for the previews without root. The steps that need the machine are run by root, the steps of the account are run again as the account itself with `runuser`, which is what puts their homes, their user services and the paths of `paths()` in the right place. Root never runs the binary of the account, and the account never runs the one of root.
6. `firewall`, with `--firewall`, or with a yes in a terminal when Tailscale SSH is on and the firewall is not in place yet: inbound blocked except on `tailscale0`.
7. `daemon`: `loginctl enable-linger`, then the `corami-daemon` unit as a systemd user service of the account, enabled in `default.target` (the user manager has no `multi-user.target`, and a unit linked there does not start after a reboot), with the owner login and the FQDN in its environment. It writes the global config with `role: server` and `server_user` in the home of the account. Without user services it falls back to a system unit with `User=` and the home of the account.
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

`corami update` downloads the new release from GitHub and verifies the sha256 before replacing the binary. The replacement renames the old binary aside and puts the previous one back when the move fails, so a machine never stays without a binary. `--version vX.Y.Z` fetches that tag's release, not the latest: an older version named on purpose is installed. On the server it restarts the daemon: as the account when the update runs as the account, through `runuser` when it runs as root, which also replaces the binary of the account keeping its ownership (copy, `chown`, rename). The restart covers the user unit and the system one, the fallback of a server without user services. On macOS it registers the launch agents again, see the table above. Every service that is installed is taken care of, also one that was left not running: the answer has `service_failures` with the exit code and the command that repairs it. From source the command exits with an error: the binary to replace would be bun. `corami update --check` stays available.

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
