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
- The build output travels nowhere: the regenerable folders (`node_modules`, `build`, `.next`, `Pods`, `.build`, `DerivedData`...) are excluded from the sync and rebuilt on every machine.
- A build on the server has what the build of the laptop has: keys and keystores (`.env`, `*.jks`, `*.keystore`, `*.p8`, `android/key.properties`...) are files of the project, so an import puts them there and the sync keeps them in step on every machine. If a key must not travel, keep it out of the project folder: a path outside it read through an environment variable (`KEYSTORE_FILE=~/.config/keys/release.jks`), or a secret manager that injects it into the command.

## On a client, over SSH

Some builds only work on a certain machine: an iOS build needs macOS and Xcode. The agent works on the server, so it runs the command on the Mac with `ssh`, inside the synced copy of the project. Corami adds no command for it: it gives the folder of the copy and the flush of the sync, and the rest is plain SSH.

Setup, once:

1. On the Mac: System Settings > General > Sharing > Remote Login.
2. On the server, as the account that owns the projects: a key for the Mac, `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_macbook`, and its public key in `~/.ssh/authorized_keys` on the Mac.
3. On the server, in `~/.ssh/config`:

   ```
   Host macbook
     HostName macbook.<your-tailnet>.ts.net
     User <your user on the Mac>
     IdentityFile ~/.ssh/id_ed25519_macbook
     IdentitiesOnly yes
   ```

4. On the server: `ssh macbook true` once, to check the path and accept the host key of the Mac.

What the key opens is in [security.md](security.md#commands-on-a-client).

A command on the Mac, from the server:

```bash
ssh macbook '~/.corami/bin/corami sync status myapp --json'
ssh macbook '$SHELL -lc "cd /Users/me/dev/myapp && ~/.corami/bin/corami sync flush myapp && flutter build ios --release --no-codesign"'
```

- The first command gives the folder of the copy, `beta` in `data.sessions`, which is not the path of the server. The build goes on only when `status` is `watching` and `conflicts` is empty; otherwise the same answer says what the sync is waiting for, and `heavy` names the entries too large to sync.
- `corami sync flush` waits until the Mac has the files the agent just wrote, so the build does not run on an older copy. Files the command changes in the project reach the server with the sync; another `corami sync flush myapp` waits for them.
- `$SHELL -lc` runs the command in a login shell. A plain `ssh macbook <command>` does not read `.zprofile`, so the `PATH` of Homebrew and of the toolchains can be missing. The login shell reads `.zshenv`, `.zprofile` and `.zlogin`, not `.zshrc`: a `PATH` the commands need goes in `.zprofile`, and on Linux in `.profile`. The installer of Corami writes its `PATH` in `.zshrc`, so the commands above name `~/.corami/bin/corami` in full.
- The exit code of the command is the exit code of `ssh`; 255 is ssh itself failing, a Mac asleep or a key refused.
- The Mac must be awake, otherwise the command fails: the agent sees the error and can say so.
- When the connection drops (a timeout of the harness, a network break), the command keeps running on the Mac. `ssh -tt` gives it a terminal, and then it stops with the connection, but stdout and stderr arrive mixed.
- Over SSH the login keychain is locked and `codesign` fails. For builds without signing (`--no-codesign`) nothing is needed. For a signed build, see [Commands that ask for input](#commands-that-ask-for-input).
- The artifact stays on the Mac, because build outputs are not synced: publish from there, or copy the file with `scp`.

Versions up to 0.25 had `corami exec` for this. Its key line stays in `~/.ssh/authorized_keys` on the Mac, the one that ends with `corami-exec:<server>`, and opens nothing now: remove it. On the server `~/.ssh/id_ed25519_corami_exec` and `~/.corami/exec/` can go too.

### Commands that ask for input

A command that asks for a password, a confirmation or any typed answer needs a terminal. The agent has none, so this is for you, in a terminal on the server: `ssh -t` opens a terminal on the Mac, the question reaches you and what you type goes back without being shown.

```bash
ssh -t macbook '$SHELL -lc "cd /Users/me/dev/myapp && security unlock-keychain ~/Library/Keychains/login.keychain-db && sh deploy.sh"'
```

The unlock lasts as long as that connection, so a signed build runs in the same command. Another `ssh` finds the keychain locked again.

## Simulators and devices from the agent

A simulator, an emulator or a phone plugged into the Mac is driven by an MCP server that runs on the Mac, over SSH. In the harness configuration on the server:

```json
{
  "mcp": {
    "mobile": {
      "type": "local",
      "command": [
        "ssh", "macbook",
        "$SHELL -lc \"cd /Users/me/dev/myapp && npx -y @mobilenext/mobile-mcp@latest\""
      ]
    },
    "xcode": {
      "type": "local",
      "command": [
        "ssh", "macbook",
        "$SHELL -lc \"cd /Users/me/dev/myapp && npx -y xcodebuildmcp@latest mcp\""
      ]
    }
  }
}
```

`mobile-mcp` drives Android and iOS simulators and devices, with screenshots. `xcodebuildmcp` runs `xcodebuild` and `simctl` ([docs](https://www.xcodebuildmcp.com/docs/clients)). The folder is the copy of the project on the Mac, and ssh carries the stdio of the server.

When the harness closes the MCP server, ssh closes its input. A server that keeps running after that stays on the Mac until you stop it.

## What Corami does not do

- It does not install or update Node, pnpm, Bun, Flutter, FVM, Java, the Android SDK, Xcode or CocoaPods: install them where you need them.
- It does not publish to the stores. Publishing tools (e.g. `gplay`, `asc`) are yours; run them where the artifact is.
- It does not remember how a project is built: there is no build section in `corami.yaml`, because there is no `corami.yaml`.
