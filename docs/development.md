# Development

How to prepare the Corami development environment and try a change on your own machine, on Linux, macOS and Windows.

Rule: the development version is tried by installing it in place of the official one, binary and services. There is no second parallel installation: `~/.corami`, the services and the daemon port are one per machine. After the try you go back to the release with `corami update --force`.

## Index

- [Requirements](#requirements)
- [First setup](#first-setup)
- [Work cycle](#work-cycle)
- [Installing the local build](#installing-the-local-build)
- [Trying the server from another computer](#trying-the-server-from-another-computer)
- [Going back to the release](#going-back-to-the-release)

## Requirements

- [Bun](https://bun.sh) 1.3 or later, the only runtime of the project. It builds the binary too.
- `git`.
- A `corami` installation already done with the release script (`docs/quickstart.md`), when the services are to be tried. It is needed because it creates `~/.corami`, the configuration and the services that the local build replaces.

## First setup

```bash
git clone git@github.com:tapeo/corami.git
cd corami
bun install
bun run verify        # biome, tsc, test
```

## Work cycle

For the tests and the commands that only read, there is no need to compile. The source is run with Bun, from any folder:

```bash
bun test
bun /path/to/corami/src/main.ts serve ls --json
```

Run this way, `corami` runs inside `bun`, and the commands that install services (`corami setup client`, `corami setup server`) would register `bun` as the program to start. Those commands, and everything that goes through the services, are tried only with the installed build, as described below.

## Installing the local build

From the repository folder, on Linux, macOS and Windows:

```bash
bun run dev:install
```

The command (`scripts/dev-install.ts`):

1. compiles `dist/corami` with `bun run bin`;
2. installs it in place of `~/.corami/bin/corami`, where both the `corami` command in the PATH and the services point;
3. restarts the services active on this machine, `corami-daemon` and `corami-git-watch`, in the systemd scope they are installed in (user or system);
4. lists the expected services that are not running, with the command to install them.

Example on a server:

```text
Installed /root/corami/projects/corami/dist/corami to /root/.corami/bin/corami (version dev)
Restarted corami-daemon (user)
Restarted corami-git-watch (user)
```

After, `corami --version` answers `dev`: that is the sign a local build is running. `corami doctor` checks the rest.

The previous binary is not kept. To go back to the release, `corami update --force` is used ([Going back to the release](#going-back-to-the-release)).

### Missing services

`dev:install` does not install services, it only restarts them. The services are installed by the Corami commands, run with the freshly installed build:

| Service | Where | Command |
|---|---|---|
| `corami-daemon` | server | `corami setup server --step daemon` |
| `corami-git-watch` | server | `corami setup server --step git-watch` |
| `corami-git-watch` | client | `corami setup client <server> --step git-watch` |
| Mutagen daemon | client | `corami setup client <server> --step mutagen-daemon` |

That way the installation of the services stays single, the one a user goes through, and it is tried together with the rest.

### By hand

When the steps are needed without the script. The binary is replaced with a rename, not by overwriting it: on Linux a running executable cannot be rewritten, and on macOS a signed binary rewritten in place is killed at the next launch. The services keep going with the old binary until they are restarted.

Linux:

```bash
bun run bin
cp dist/corami ~/.corami/bin/corami.new && mv -f ~/.corami/bin/corami.new ~/.corami/bin/corami
systemctl --user list-units 'corami*' 'git-watch*'   # which services are there
systemctl --user restart corami-daemon               # server
systemctl --user restart corami-git-watch            # when present
```

When the setup installed the system services because the user ones were not available, the commands are the same without `--user`.

macOS:

```bash
bun run bin
cp dist/corami ~/.corami/bin/corami.new && mv -f ~/.corami/bin/corami.new ~/.corami/bin/corami
launchctl kickstart -k gui/$(id -u)/dev.corami.git-watch
```

Windows, from PowerShell. A running executable is locked: first the scheduled task is stopped, then the copy, then the task starts again.

```powershell
bun run bin
Stop-ScheduledTask -TaskName corami-git-watch
Copy-Item dist\corami.exe "$env:USERPROFILE\.corami\bin\corami.exe" -Force
Start-ScheduledTask -TaskName corami-git-watch
```

## Trying the server from another computer

The server is tried on the test VPS (`docs/architecture.md`, "Test environment"). When the repository is cloned on the VPS too, with Bun installed, `bun run dev:install` there is enough. Otherwise the binary is compiled on the development machine for Linux and installed on the VPS with the same rename:

```bash
bun build src/main.ts --compile --target=bun-linux-x64 --outfile dist/corami-linux-x64
scp dist/corami-linux-x64 root@<vps>:.corami/bin/corami.new
ssh root@<vps> 'mv -f ~/.corami/bin/corami.new ~/.corami/bin/corami && corami setup server --step user'
```

The account that owns the projects has its own copy of the binary (`~corami/.corami/bin/corami`): the step `user` replaces it and restarts the daemon of the account, and the same step also works from a local build. As root, the commands that write the projects (`project add`, `serve`, `setup git`) are not run on the VPS: `ssh corami@<vps>` is.

On a freshly created VPS, instead of the restart you run `ssh -t root@<vps> corami setup server`, which is what `install.sh ... server` does after the download.

## Going back to the release

```bash
corami update --force
```

The local build declares `dev`, which cannot be compared with a version number: without `--force` `corami update` sees nothing newer. With `--force` it downloads the latest release, verifies the sum, replaces the binary and restarts the git alignment and, when it is a user service, the daemon. A daemon installed as a system service is restarted by hand: `systemctl restart corami-daemon`.
