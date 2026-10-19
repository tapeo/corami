# Builds

Corami does not build projects. It does not know how a project compiles and does not install toolchains. A build is a command the agent, or you, runs on the machine that has the tools; Corami takes care of keeping the code aligned between the server and the clients.

## On the server

The server is where the agent lives, so it is also where most builds run:

```bash
# on the server, from ~/projects/<project>
pnpm install --frozen-lockfile
pnpm build
```

- A long build competes with the previews of the other projects for CPU. On a small VPS run it with `nice -n 10` and stop the toolchain daemons at the end (e.g. `cd android && ./gradlew --stop`).
- The build output travels nowhere: the regenerable folders (`node_modules`, `build`, `.next`, `Pods`...) are excluded from the sync and rebuilt on every machine.
- A build on the server has what the build of the laptop has: keys and keystores (`.env`, `*.jks`, `*.keystore`, `*.p8`, `android/key.properties`...) are files of the project, so an import puts them there and the sync keeps them in step on every machine. If a key must not travel, keep it out of the project folder: a path outside it read through an environment variable (`KEYSTORE_FILE=~/.config/keys/release.jks`), or a secret manager that injects it into the command.

## On a client, over SSH

Some builds only work on a certain machine: an iOS build needs macOS and Xcode. The agent works on the server, so it reaches the Mac over SSH on the tailnet and builds the synced copy there:

```bash
# from the server
ssh macbook 'cd ~/dev/myapp && corami sync flush myapp && flutter build ios --release --no-codesign'
```

Setup, once:

1. On the Mac: System Settings > General > Sharing > Remote Login.
2. The server's SSH key in the `authorized_keys` of the Mac user.
3. From the server: `ssh macbook echo ok`.

Make it safe:

- Restrict the key to the single script it needs, with `command="..."` in `authorized_keys`, or use a dedicated macOS user. A server key without limits lets anything on the server run anything on your Mac, with your credentials. See [security.md](security.md#builds-on-the-mac).
- The Mac must be awake, otherwise SSH fails: the agent sees the error and can say so.
- An SSH session reads neither `.zshrc` nor `.bashrc`: put `PATH` in `~/.zshenv`, or run the command as `zsh -lc '...'`.
- Over SSH the login keychain can be locked and `codesign` fails. For builds without signing (`--no-codesign`) nothing is needed; for a signed build run `security unlock-keychain` before it.
- The artifact stays on the Mac, because build outputs are not synced. Publish from there, or copy the file with `scp`.

## What Corami does not do

- It does not install or update Node, pnpm, Bun, Flutter, FVM, Java, the Android SDK, Xcode or CocoaPods: install them where you need them.
- It does not publish to the stores. Publishing tools (e.g. `gplay`, `asc`) are yours; run them where the artifact is.
- It does not remember how a project is built: there is no build section in `corami.yaml`, because there is no `corami.yaml`.
