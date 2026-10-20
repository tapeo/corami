# Ideas for v2

Topics postponed after v1. They are ideas, not decisions: they will be analysed when v1 is complete, and they must not be implemented in v1. For each one the reason, what has emerged so far and what remains to be clarified are collected, so the analyses already done are not lost.

| Idea | In short |
|---|---|
| [Custom domain](#custom-domain) | A subdomain per process on a domain of the user, in place of the port |
| [Parallel previews](#parallel-previews) | One preview per worktree or branch |
| [Remote runs](#remote-runs) | A command of the project run on another connected machine |
| [Automatic pause](#automatic-pause) | Idle dev servers stopped and started again at the first request |
| [Team](#team) | Several people on the same server |
| [Non-interactive setup](#non-interactive-setup) | Server prepared with nobody in front |
| [Headscale](#headscale) | Self-hosted alternative to Tailscale |
| [Git provider](#git-provider) | PRs, issues and per-repository keys |
| [Sync extensions](#sync-extensions) | Worktrees and dependencies on the client |
| [New guides and recipes](#new-guides-and-recipes) | More platforms, harnesses and tools |

## Custom domain

**Why:** in v1 the previews are `https://<server>:<port>`. Cookies are separated per domain and not per port, so two projects with a cookie of the same name overwrite each other's session. On top of that, URLs with the port are not easy to read.

**What has emerged:**
- Shape of the addresses: a single level under a domain of the user, with the parts separated by `--`. Examples: `shop-app.dev.example.com`, `shop-app--api.dev.example.com`, and with parallel previews `shop-app--feat-cart.dev.example.com`.
- One wildcard DNS record towards the Tailscale IP of the server: outside the tailnet the address leads nowhere.
- A proxy on the server (Caddy was the hypothesis) with a wildcard certificate obtained through the API of the DNS provider. Only the wildcard would end up in the public certificate logs, not the names of projects and branches.
- Access would stay limited to the owner, asking the daemon for every request.
- For Next.js nothing would change in the project: the `allowedDevOrigins` line already reads the name from `CORAMI_DEV_ORIGINS`.
- **Dedicated paths** (`/shop-app/`) discarded: they need changes in the projects (`basePath` in Next.js, `--base-href` in Flutter) and make all projects share the same origin.
- **Tailscale Services** discarded: they need a server with a tagged identity, ACL rules, host approval, and they make the names of projects and branches public in the certificate logs.

**To clarify:**
- Which DNS provider to support first (Cloudflare was the hypothesis).
- Routers and DNS filters that block answers with private IPs.
- Whether to keep the v1 ports too or only the subdomains.

## Parallel previews

**Why:** the agents work in parallel, each in its own worktree created by the harness. In v1 a preview belongs to the project folder, so the work of a worktree is not visible until it reaches the main branch.

**What has emerged:**
- Corami should not manage worktrees, which are already the job of git and the harnesses. It should know only folders: every folder could register its own previews, with its own ports.
- Two instances of the same project would both appear under the project name, and would need distinct preview names (`corami serve 3001 --name web-cart`).
- An identifier per instance would be needed (it was called `CORAMI_INSTANCE_ID`) to give distinct names to external resources, Docker Compose projects for example, so every instance has its own containers and its own database.
- When a folder is deleted, its processes should be stopped and the ports freed.
- No automatic start: an agent that creates ten worktrees should not start ten dev servers.
- For a backup, the list of worktrees of every project can be read from git, so the uncommitted work of the agents is saved wherever the harness keeps the folders.
- Discarded: `corami worktree add|rm` commands and an automatic search for worktrees, because they duplicate git and the harnesses.

**To clarify:**
- The RAM with many instances, which probably needs the [automatic pause](#automatic-pause).
- The cookies between instances of the same project, solved only by the [custom domain](#custom-domain).
- The cleanup of ports and Docker volumes of the instances no longer used.

## Remote runs

**Why:** in v1 `corami exec` already runs a command of the server on a client. The key is restricted to the gate, the rules and the approval are on the client, the sync is flushed before the command and the outcome comes back. What remains are the parts around it.

**What has emerged:**
- Returning the artifact (an `.ipa`, an `.apk`) to the server, where it is published.
- Choosing the machine when several clients can run the command: today `--on` is required.
- Resuming when a client goes offline halfway through: today the processes are closed and the error is clear.
- A preview registered on the client, for a dev server that runs there.
- Checking that the command exists on the client before asking for the permission.
- External services discussed for iOS builds:
  - Codemagic, with free macOS minutes in the individual plan and automatic iOS signing;
  - Xcode Cloud, with hours included in the Apple Developer Program, startable from `asc`;
  - GitHub Actions on macOS.
  Prices and limits must be checked again at analysis time.
- For the external services a guide with the right command might be enough, without code in Corami.

**To clarify:**
- Which client runs a command when several are online, and by which rule.
- How an artifact comes back, and where it is published.
- Whether the simulator on a remote Mac fits here too, with screenshots for the agent.

## Automatic pause

**Why:** in v1 the user starts the dev servers, and they stay up until they are stopped. With many projects, or with parallel previews, the server can run out of RAM.

**What has emerged:**
- **Idle:** no connection on the target port of the preview and no file changed for a certain time. An open tab keeps the hot reload connection alive, so the project stays up as long as it is watched.
- **Pause:** stop the dev server and put a "Starting" page in its place on the same port, without touching the HTTPS rule.
- **Wake up:** at the first request the page starts the real process and reloads when it is ready.
- With the dev servers started by the user, Corami would have to know how to start them again: the command to stop and to start would be part of the preview registration.

**To clarify:**
- Whether `tailscale serve` keeps connections open towards the dev server, which would make it look always active.
- How to pause a Docker Compose stack.
- Whether support processes (a watcher for example) follow the dev server.

## Team

**Why:** v1 is for a single user. The daemon accepts only the owner and the previews live in one person's tailnet. The project description points at teams as a future direction.

**What has emerged:**
- Possible ingredients: several authorized users, per-project permissions, previews shareable even with people outside the tailnet.
- Sync conflicts would also happen between people, not only between a person and an agent.
- Already in v1, a tailnet shared with others needs a Tailscale ACL rule to limit access to the server.

**To clarify:**
- One server per team, or one server per person with shared projects.
- Identity based on the users of the tailnet or on a system of its own.
- One Linux user per person on the server, or a single one.

## Non-interactive setup

**Why:** in v1 `corami setup server` is interactive only. A server cannot be prepared with cloud-init or with a script.

**What has emerged:**
- It was planned at the start (`--yes` flag, environment variables, cloud-init templates for the providers) and was removed from v1 for simplicity.
- Tailscale accepts an authentication key. An **untagged** key leaves the node with the user, so Tailscale SSH and the identity headers work as today. A **tagged** key changes the identity of the node and needs ACL rules for SSH.
- The HTTPS certificates must be enabled once in the Tailscale console anyway.

**To clarify:**
- The SSH key of the server for git, which today needs the public key to be added to the provider by hand.
- Nothing on the Corami side: the backup is the user's, so a server prepared with cloud-init would also need the backup of its choice configured (see `docs/backup.md`).

## Headscale

**Why:** Corami depends on a single network provider, Tailscale.

**What has emerged:**
- Headscale is an open source coordination server compatible with the Tailscale client. The commands (`tailscale up`, `tailscale serve`, Tailscale SSH) would stay the same.
- The identity headers of `tailscale serve` turn out identical with Headscale, according to the documentation of projects that use it.

**To clarify:**
- HTTPS certificates for the names of the network with Headscale. Without HTTPS the previews are not a secure context, and services like camera and service workers do not work.
- Tailscale SSH with Headscale.
- What changes in the setup and in the test environment.

## Git provider

**Why:** in v1 the server uses only `git` with an SSH key. The agent can commit and push, but it cannot open PRs or manage issues, and the key has access to all the repositories of the account.

**What has emerged:**
- `gh` was considered for authentication and excluded: git over SSH is enough for fetch and push, and it works with any provider.
- `gh` stays useful only for PRs and issues.
- Per-repository keys (deploy keys) are more restrictive, but they must be added repository by repository.

**To clarify:**
- Whether PRs and issues are the job of Corami or of the harness.
- Providers other than GitHub (e.g. GitLab).

## Sync extensions

**Why:** the v1 sync has two accepted limits:
- worktrees are not synced;
- when the agent adds a package on the server, the local dependencies stay behind until an install or a local command is run.

**What has emerged:**
- Sync of worktrees, together with the [parallel previews](#parallel-previews).
- `.git` lives on both sides with its own git commands, and the two repositories align by hand (done in v1). Syncing the same `.git` between two machines, instead, stays risky: without a lock two git commands together can corrupt the repository.
- A watcher on the client that reinstalls the dependencies when the lockfile changes would need an always-on service on the client, which does not exist in v1. The same service would avoid Remote Login for the [remote runs](#remote-runs) and let a command survive a lost connection.

**To clarify:**
- Whether a reliable lock for git is feasible on top of Mutagen, to keep a single `.git` synced instead of one per side.
- How often, in real use, the local dependencies stay behind.

## New guides and recipes

**Why:** v1 has the recipe for opencode and OpenChamber and the rules for a preview in `docs/previews.md`.

**What has emerged:**
- The rule stays the v1 one: a recipe is "tested" when it is tried on a test project.
- Ideas collected:
  - per-stack pages with the exact dev server command and the allowed origins setting, now that `docs/stacks/` is gone;
  - iOS signing with `asc signing`, useful without an Apple account configured in Xcode;
  - recipes for other harnesses, tried the same way;
  - a web editor on the server (e.g. code-server), to edit files by hand from the phone;
  - a command that creates a systemd service and an HTTPS rule for the harness (it was called `corami service`), only when creating services on the server turns out to be frequent in real use.

**To clarify:**
- Which stacks and harnesses have priority, based on real use.
