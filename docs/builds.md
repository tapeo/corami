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

## On a client, with corami exec

Some builds only work on a certain machine: an iOS build needs macOS and Xcode. The agent works on the server, so it runs the command on the Mac with `corami exec`, inside the synced copy:

```bash
# from the server, inside the project
corami exec --on macbook -- flutter build ios --release --no-codesign
```

The output, the exit code included, comes back as it is. The build output stays on the Mac, because build outputs are not synced.

Setup, once:

1. On the Mac: System Settings > General > Sharing > Remote Login.
2. On the Mac: `corami setup client <server>`, then `corami exec setup`.
3. On the server: `corami exec status` lists the client as online.

`exec setup` adds the key of the server to `authorized_keys`, limited to the gate, registers the host key of the Mac on the server and checks the path from the server. It asks nothing: the client runs what the server sends, and the harness on the server decides which `corami exec` the agent may run.

The rest of the notes stay:

- The Mac must be awake, otherwise the command fails: the agent sees the error and can say so.
- The login shell of an SSH session reads `.zshenv`, `.zprofile` and `.zlogin`, not `.zshrc`: a `PATH` the commands need goes in `.zprofile`. On Linux the same rule holds for `.profile`.
- Over SSH the login keychain can be locked and `codesign` fails. For builds without signing (`--no-codesign`) nothing is needed; for a signed build run `security unlock-keychain` before it.
- The artifact stays on the Mac: publish from there, or copy the file with `scp`. Bringing it back to the server is still in the [v2](v2/README.md#remote-runs).

## Simulators and devices from the agent

A simulator, an emulator or a phone plugged into the Mac is driven by an MCP server that runs on the Mac, through `corami exec`. In the harness configuration on the server:

```json
{
  "mcp": {
    "mobile": {
      "type": "local",
      "command": [
        "corami", "exec", "--on", "macbook", "--project", "myapp", "--",
        "npx", "-y", "@mobilenext/mobile-mcp@latest"
      ]
    },
    "xcode": {
      "type": "local",
      "command": [
        "corami", "exec", "--on", "macbook", "--project", "myapp", "--",
        "npx", "-y", "xcodebuildmcp@latest", "mcp"
      ]
    }
  }
}
```

`mobile-mcp` drives Android and iOS simulators and devices, with screenshots. `xcodebuildmcp` runs `xcodebuild` and `simctl` ([docs](https://www.xcodebuildmcp.com/docs/clients)). The project names the copy the tools work in, and the gate sends the server's stdio to them.

When the harness closes the MCP server, the gate closes the processes on the Mac.

## What Corami does not do

- It does not install or update Node, pnpm, Bun, Flutter, FVM, Java, the Android SDK, Xcode or CocoaPods: install them where you need them.
- It does not publish to the stores. Publishing tools (e.g. `gplay`, `asc`) are yours; run them where the artifact is.
- It does not remember how a project is built: there is no build section in `corami.yaml`, because there is no `corami.yaml`.
