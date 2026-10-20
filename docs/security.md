# Security

The tailnet is the boundary. Everything Corami publishes, the daemon, the previews and the agents, listens on a Tailscale address, and nothing listens on the public interface. The server is the machine that matters: it holds the projects, the keys and env files the sync carries, and a shell where the agent runs code.

The list below is in order of weight. Each item says what to do, why, and the line of `corami doctor` that follows it.

## The SSH rules of the tailnet

Corami runs ssh in batch mode: `corami project add`, the sync and `corami setup client --step ssh` cannot stop to open a browser. With the default `check` action of a tailnet they stop at every expiry, 12 hours by default. The rule for the account of the projects has to say `accept`.

In the Tailscale admin console (Access controls), the `ssh` section holds:

```json
"ssh": [
  {
    "action": "accept",
    "src": ["autogroup:member"],
    "dst": ["autogroup:self"],
    "users": ["corami"]
  },
  {
    "action": "check",
    "src": ["autogroup:member"],
    "dst": ["autogroup:self"],
    "users": ["root"]
  }
]
```

- `corami` is the account that owns the projects, `corami` by default: `--user` at setup gives another name. Name that account instead of `autogroup:nonroot`. `autogroup:nonroot` lets in any account of the machine that is not root, the account the provider created included ([policy syntax](https://tailscale.com/kb/1337/policy-syntax)).
- `root` keeps the check. The account of the projects is the one the commands use, so the sync does not pass through root.
- `src` and `dst` leave the rule inside the devices of the owner: nobody else in the tailnet reaches this machine through it.

With `accept` the device becomes the credential: anyone on a device already signed in to the tailnet enters without a second factor at the moment of the connection. That is the trade: the sync works while the laptop is closed, and the protection moves to the devices themselves. Keep the screen lock and the disk encryption on, and see [Your Tailscale account](#your-tailscale-account).

Checks: `tailscale.ssh_policy` for the account of the projects, `tailscale.ssh_root` for root, `tailscale.ssh_accounts` for the other accounts.

## Other accounts on the server

A server from a provider usually comes with an account such as `ubuntu` or `debian`, in the `sudo` group. With the rule above it does not enter over Tailscale SSH, and its password never reaches the sync. If nothing uses it, remove it or disable its login. If it stays, it is one more way to root on the machine, and the agent does not need it.

Checks: `tailscale.ssh_accounts` names every account the policy lets in without a check, with the groups that make it root. `server.privileges` says whether the account of the projects itself can become root: keep it that way, so a wrong dependency or a wrong agent stays inside the home of that account.

## People in your tailnet

Every port published with `tailscale serve` is reachable by everyone in the tailnet: the daemon checks the owner login, the previews and the agents do not. They are protected by the tailnet being yours and, for the agents, by their password.

With other people in the tailnet, restrict the server with an access rule that grants its ports to the owner only, from the same console. Grants and ACLs are in the [Tailscale documentation](https://tailscale.com/kb/1337/policy-syntax).

Check: `tailscale.people`.

## Your Tailscale account

With `accept` nothing asks for a second factor when a connection starts. The MFA of the identity provider that signs the tailnet in is the second factor that remains, and so is the list of devices allowed to sign in. Turn it on if it is not already.

## A device you lose

Remove the device from the tailnet in the [Tailscale console](https://login.tailscale.com/admin/machines). Once it is out, it no longer has an address in the tailnet, and the server refuses the connections the policy does not allow.

## Commands on a client

`corami exec` runs a command of the server on a client, inside the synced copy. The client turns the channel on in its terminal with `corami exec allow`, and turns it off with `corami exec deny`. The server reaches the client through a key line in `~/.ssh/authorized_keys` limited with `restrict,from=...,command="... exec gate"`, and sshd must accept keys only: `exec allow` writes `/etc/ssh/sshd_config.d/100-corami.conf` with sudo when passwords are on.

The rules and the approval are on the client. `ask` is the default, `deny` wins, and the agent on the server cannot read or change them: every payload passes through the gate, and the file of the rules is not reachable from the server. A rule limits the command, not what it does: `flutter run` runs code of the project, and `allow npx *` allows everything. `exec rule allow` says so when a rule covers a program that runs arbitrary code.

Checks: `exec.remote_login`, `exec.sshd` and `exec.allowed` on a client; `exec.clients` on the server.

## Keys and env files

The sync carries the project folder as it is, keys and env files included, so that a build or a preview on the server has what the laptop has. Keeping a key off the machines is a decision made outside Corami: keep the key out of the folder, or inject it from a secret manager. See [quickstart.md](quickstart.md#3-your-first-project).

## Ports outside localhost

Corami starts no project process and publishes every preview with `tailscale serve` towards `127.0.0.1`. A service that listens on `0.0.0.0` or on the public interface of the server is reachable from outside the tailnet, and Docker publishes on `0.0.0.0` by default. The rules a dev server must follow are in [previews.md](previews.md#rules).

Check: `net.exposed_ports`.

## Everything at once

```bash
corami doctor
```

The list has no areas: it checks the machine and reports every item above with the remedy for each one.
