# Backup

Corami does not back anything up: it is yours to choose. The server is the source of truth, and a lost server must not mean lost work, so a backup of it is worth the ten minutes it takes to set up. This page says what to save and how, with the tools you already use.

## What the sync already protects

- **Committed work** is on `origin`.
- **Uncommitted work** is on every client that synced the project: `corami sync add <project>` keeps a real copy on the disk of each machine, both ways.
- **What is not protected:** a project that no client ever synced. Its files exist only on the server. Sync it once from your laptop, or include the server in a backup.

## What to save

| What | Path | Why |
|---|---|---|
| Projects, with their `.git` | `~/projects/` | code, branches, unpushed commits, uncommitted changes, stashes |
| Corami configuration | `~/.corami/config.json` | role, server name, owner login |
| Server git key | `~/.ssh/id_ed25519_corami`, `~/.ssh/config`, `~/.ssh/known_hosts` | after a restore the key does not have to be added to the providers again |
| Harness sessions | e.g. `~/.local/share/opencode` | the history of the agents, if you want it |
| Container data | the Docker volumes | databases and services of the projects, if the data matters |

What not to save, because every machine rebuilds it: `node_modules`, `.next`, `.turbo`, `dist`, `build`, `coverage`, `.dart_tool`, `.fvm`, `Pods`, `.gradle`, `ephemeral`, `.venv`, `__pycache__` and the other folders of `REGENERABLE_DIRS` in `src/core/local-copy.ts`. `~/.corami/state.db` holds the project registry and the preview addresses: both are recreated by `corami project add` and `corami serve`, so saving it is optional.

Files that look like secrets (`.env`, `*.jks`, `*.keystore`, `*.p8`, `service-account*.json`) are not synced, so they are found only on the machine that has them: on the server, back them up too if they live there.

## How

### Snapshot of the provider

Every VPS provider (Hetzner, DigitalOcean, Scaleway...) takes a snapshot or an image of the whole disk with a click, often with a schedule. It is the shortest path: nothing to install, everything included, and a new server from the image has Tailscale and the projects already in place. Remember that the image stays inside the provider.

### restic, with a timer

restic encrypts on the server, uploads only the differences and deduplicates. The setup is a script and a timer, both yours:

```bash
# on the server, once
sudo apt install restic                    # or the pinned version you prefer
export RESTIC_REPOSITORY=s3:s3.example.com/bucket/corami
export RESTIC_PASSWORD_FILE=~/.corami/restic-password
printf '%s\n' "$(openssl rand -base64 24)" > "$RESTIC_PASSWORD_FILE"
chmod 600 "$RESTIC_PASSWORD_FILE"
restic init
```

```bash
# ~/.corami/backup.sh, on the server, chmod +x
#!/bin/sh
set -e
export RESTIC_REPOSITORY=s3:s3.example.com/bucket/corami
export RESTIC_PASSWORD_FILE="$HOME/.corami/restic-password"
restic backup \
  --exclude node_modules --exclude .next --exclude build --exclude Pods \
  --exclude '.dart_tool' --exclude '.fvm' \
  "$HOME/projects" "$HOME/.corami/config.json" "$HOME/.ssh"
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

A user timer runs it every night, keeping the environment of the script:

```bash
# ~/.config/systemd/user/corami-backup.{service,timer}
systemctl --user enable --now corami-backup.timer
```

```ini
# corami-backup.service
[Unit]
Description=Backup of the Corami folders

[Service]
Type=oneshot
ExecStart=%h/.corami/backup.sh
```

```ini
# corami-backup.timer
[Unit]
Description=Nightly backup

[Timer]
OnCalendar=*-*-* 03:00
Persistent=true
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
```

With `loginctl enable-linger` (the Corami setup does it) the timer runs with no session open. `systemctl --user list-timers corami-backup.timer` shows when it goes next, `journalctl --user -u corami-backup` its output.

`corami doctor` checks the network, the tools and the services. It does not check your backup: add the check you prefer, or watch the timer output.

## Restore on a new server

1. Install Corami and run `corami setup server` (`docs/quickstart.md`).
2. Restore the folders: `~/projects` from the snapshot or with `restic restore --target /`, then `~/.ssh` and `~/.corami/config.json`.
3. Add the projects back to the registry if you restored `state.db` and it is from an older version, or when you did not restore it: `corami project add --path ~/projects/<project>`.
4. On the server, restart the dev servers (a user service, `docker compose up -d`) and register their addresses: `corami serve <port>`.
5. On every client, `corami sync add <project>` and `corami update`.

The projects are folders: the clients of a restored server find the sync sessions again by running `corami sync add <project>`, and git realigns itself through `corami-git-watch`. That holds when the new server keeps the name of the old one in the tailnet. With another name, follow the next section.

## Moving the clients to another server

Corami knows a copy by the name of its project, not by the server it syncs with. After a change of server name the sessions of a client still point at the old one: `corami sync add <project>` would resume them, and `corami sync rm <project>` would act on their copies. On every client, before anything else:

1. `corami sync ls` lists the copies and their folders: note them.
2. `corami sync stop <project>` for each copy: the session goes, the files stay where they are.
3. `corami setup client <new-server>`.
4. For each project, move the old folder away and create the copy in its place: `mv ~/dev/myapp ~/dev/myapp.old`, then `corami sync add myapp --path ~/dev/myapp`. `sync add` refuses a folder that is not empty, so the old copy never mixes with the new one.
5. Compare the two folders. Work that is only in the old one goes into the new copy by hand, then delete the old folder yourself: it has no session, and `sync rm` does not touch it.
