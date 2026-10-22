# Internals

Short notes on the invariants the code relies on: rules whose reason a name cannot show. User-facing behavior is in the other pages.

## Project names and folders

- An existing project accepts `[A-Za-z0-9][A-Za-z0-9._-]*`. A new one must match `[A-Za-z][A-Za-z0-9-]*`: the Mutagen session is named after the project, and Mutagen accepts letters, digits and dashes, starting with a letter. A dot or an underscore would pass every other check and fail at `mutagen sync create`, after the project is already on the server.
- The name is one path segment, under `~/projects` by default. `.`, `..`, a separator and an empty name are refused in the client and again in the daemon.
- Project folders may not overlap: the same folder, or one inside the other. Two projects would sync the same files.
- The local copy is never derived from the name. The session's folder wins, and a different folder asked for it is a move, refused. Without a session, a folder inside or around another copy is refused, because the sync would write into that project, and a non-empty folder is refused. The one exception is the folder of an import: it is not empty, and it becomes the copy. Nothing writes into it but the sync, in `two-way-safe` mode.
- `syncName` turns a folder into a session name: dots, underscores and spaces become dashes, runs collapse, leading and trailing dashes go.
- The deepest containing path wins when copies are nested.
- `~/projects` sits directly in the owner's home: the account exists for the projects, and `~/corami/projects` would repeat the name. The path stays POSIX even on a Windows client.

## Paths and the import

- In the path rules the first match wins. A folder rule matches a folder, or a path through the folder, never a file with that name.
- `.git` is the exception: the sync keeps it out with `/.git/*` and `*/**/.git`, and lets through only `.git/corami/`, the folder where each machine publishes its unpushed commits and its branch (see "Git" in architecture.md). The import carries the whole `.git`, because the project on the server is a clone with history and uncommitted work. A root `.git` that is a file, as a worktree writes it, is not matched by those rules, so that project keeps `--ignore-vcs` and gets no peer exchange. A `.git` deeper down is a submodule gitlink and travels.
- Only regular files and links are content: a FIFO, a socket and a device are not carried, and Mutagen leaves them untracked.
- A link travels only when `symlinkPortable` accepts it: a relative target of safe characters that stays inside the folder. An absolute link, an unreadable one, or one that leaves the folder stays on this machine. Its size is the length of the target, never the content it points at.
- A manifest line starts with the type (`f`, `d`, `l`), so a link and a file of the same name cannot pass for each other.
- The staging folder of an import is next to the project, so the rename stays on one filesystem and the name of the project stays free until the registration. A stopped import leaves the staging, never a folder that no project names.
- `sameRepository` compares URLs by host (lower case) and path (case sensitive), ignoring the user, the port and a trailing `.git`. The scp and the ssh/https forms of one repository are the same.
- The local folder of an import is read with the rules of its platform: on Windows `C:\Users\me` is not a POSIX path. The home folder itself is refused, a folder inside it is a project.
- An import writes nothing into the local folder: it sends an archive to the server, verifies the two sides, and the folder becomes the copy as it is. When the session cannot be created the project goes off the server again, and there is no local restore to do. Do not bring back a rename, a backup folder or a copy of the files: the two copies the import already has (the folder and the verified staging folder) are the whole safety net.
- The first cycle of a session created on an existing folder has no ancestor, so `two-way-safe` writes a file that exists on one side only and records a conflict for a file that differs on both, keeping both versions. That is why the folder of an import can be the copy.
- `._*` is out of the archive (macOS writes AppleDouble files next to the real ones) and out of the sync: the server is Linux and would keep them as debris of one machine.

## Sync

- `successfulCycles` alone is not the end of the first cycle: it counts before every file is written. The session is done only when it is back to `watching`.
- A Mutagen daemon started on demand does not come back after a reboot. On Linux it has no `daemon register`, so a user unit runs `daemon run`; on macOS and Windows Mutagen registers itself. A registration left by another binary is replaced.
- Paths are compared in canonical form: absolute, with the symbolic links of the existing part resolved, and lower case on macOS and Windows. Two folders that differ only in case are one, so the checks refuse more, never less.

## Daemon

- The project name keys the folder on the server and is validated before any route.
- A clone URL that starts with `-` is refused: `git clone` would read it as an option, and one of its options runs a command.
- `~/` is expanded against the home of the account that owns the projects. Without that home the path could land in the folder the daemon runs in.
- A removal deletes the folder first and the registry row after: a failure leaves a project that can be removed again, never a folder that no project names.
- The bearer token is compared in constant time. Credentials in a URL are removed before the URL reaches a summary or a log.

## Setup and updates

- The setup runs as root, then runs the steps of the owner account as that account: otherwise their homes, user services and paths would be those of root. Root steps: `preflight`, `packages`, `tailscale`, `hosts`, `user`, `firewall`. Owner steps: `daemon`, `git-watch`, `serve`, `summary`.
- A setup that stopped at a step is an error, not a run that went through: a script reading the exit code would take a machine with a broken service for a ready one. The steps travel in `details.steps`.
- A name for the owner account must match `[a-z_][a-z0-9_-]{0,31}` and not be reserved: the check is stricter than `useradd`, so a name never carries a shell character or a leading `-` into a command line.
- Accounts that can become root: `sudo`, `wheel`, `docker`, `lxd`, `adm`. Login accounts from `/etc/passwd`: uid 1000-65533 and a shell that opens a session; root and nobody stay out.
- A user systemd unit is enabled in `default.target`, not `multi-user.target` or `network-online.target`: the user manager has neither, and a unit linked there stays down after a reboot.
- A single `--step summary`, where the daemon step did not run, checks both scopes: the daemon runs as a user unit unless the account has no user services, and a summary that looks at one scope only lies.
- `corami update` as root replaces both binaries: the one of root and the one of the account, when it exists. The account binary is written next to it, given back to the account and then renamed into place, so it is never owned by root. The daemon restarts as the account through `runuser`; the restart of a system unit fallback succeeds only from root.
- Semver: a part that is not a number counts as zero, so a `dev` build is older than any release. A release comes after its prereleases; two prereleases compare as text.
- The Mutagen checksums are written into `pinned-tools.ts`, not read from the release: a missing or changed `SHA256SUMS` cannot take the check away.

## CLI

- Arguments are read once, before the command is known: a flag takes the next word as its value only when some command or action declares it with one.
- After `--` every word is an argument. In a group of short flags only the last can take a value (`-yp folder`). `--no-<flag>` sets it false.
- Only a bare `--version` is the global flag: in `corami update --version v0.3.0` it belongs to the command, and a command that declares it with no value is a usage error.
- Questions are asked only to a person: stdin and stdout are terminals and `--json` is not set.
