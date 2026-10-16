# Previews: a dev server with an HTTPS address

Corami starts no project process. The agent, or you, starts the dev server; then `corami serve` gives it a stable HTTPS address reachable from every device of the tailnet, phone included.

```bash
# on the server, from ~/projects/<project>
pnpm exec next dev -H 127.0.0.1 -p 3000 &
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

- The project comes from the folder, no configuration file. `--project` overrides it.
- The preview name is `web` unless `--name` says otherwise. One project can have several previews, one per name.
- `corami serve ls [project]` lists them with `responding`, `corami serve rm <name>` removes one.
- The public port is stable per preview: if the dev server moves to another port, `corami serve <new-port>` moves the rule and the URL stays the same. So bookmarks and links shared with the agents keep working.
- `responding` is a TCP connection on the target port: the preview is registered even before the dev server starts.

## Start the app so it survives the harness

A background command of the harness shell dies with the session or with the tool timeout, and nobody restarts it. Start the dev server as a user service of the server instead:

```bash
# on the server, from the project folder
systemd-run --user --unit myapp-web --collect \
  pnpm exec next dev -H 127.0.0.1 -p 3000
```

- Logs: `journalctl --user -u myapp-web -f`.
- Stop: `systemctl --user stop myapp-web`.
- The daemon enables `loginctl enable-linger`, so user services keep running with no session open. When the server has no user services, `setsid nohup <command> >~/.corami/logs/app.log 2>&1 &` is the fallback.
- Do not use the `corami-` prefix for unit names: it is reserved for Corami services.

With Docker Compose the containers already run in the background:

```bash
docker compose up -d
corami serve 3000
```

```yaml
services:
  app:
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
```

## Rules

| Rule | Why |
|---|---|
| The dev server listens on `127.0.0.1` | Corami publishes with `tailscale serve`, which forwards to localhost only. A server reachable on `0.0.0.0` is reachable from the public IP of the server |
| With Docker, publish ports as `127.0.0.1:<port>:<port>` | Docker writes its own iptables rules and bypasses `ufw` |
| No fixed volume `name:` in compose | Compose prefixes volumes with the project name: every project gets its own data |
| The address is on the tailnet, never public | A dev server is not a public service. `corami doctor net` reports what listens outside localhost |

## Dev servers that check the Host header

Behind `tailscale serve` the browser uses the Tailscale name, while the dev server answers on `127.0.0.1`. Frameworks that block cross-origin requests to development assets need the name in their list.

Next.js, in `next.config`:

```js
const nextConfig = {
  allowedDevOrigins: ['*.ts.net'],
};
```

Symptom when it is missing: the page loads half styled, hot reload does nothing and the dev server logs blocked cross-origin requests. Other stacks have the same setting under a different name (e.g. `server.allowedHosts` in Vite).

## Things to know

- **Cookies are shared between previews.** They are the same host on different ports, so two projects using the same cookie name overwrite each other's session. Known limit of v1.
- **One instance per project.** Worktrees created by the harness have no preview registered with Corami.
- **Rebooting the server:** the serve rules survive, the dev server does not restart by itself unless it is a container with `restart: unless-stopped` or a service. The preview shows `responding: false` until it is up again.

## Instructions for the agent

Copy this into the `AGENTS.md` of the project, with the project name in place of `<project>`:

```markdown
## Corami environment

- The project lives on the server, synced with every client. The dev server runs on the server, not on this machine: `systemd-run --user --unit <project>-web --collect pnpm exec next dev -H 127.0.0.1 -p 3000`.
- Give the preview an address: `corami serve 3000` (from `~/projects/<project>`), then read `url` from the JSON. `corami serve ls` lists the addresses.
- After every UI change, open that URL with the browser of this harness (or a browser tool it offers) and read the console and the failed requests there, then take the screenshot. The page is in a secure context because the address is HTTPS.
- Builds run where the tools are: on the server, or on a client over SSH. See docs/builds.md in the Corami repository.
```
