// The decisions behind the owner account of a server: the account that owns
// the projects and runs the daemon, the git alignment service and the agents.
// Its setup runs as root, the steps that belong to the account are run again
// as it. The decisions are pure; the commands live in the steps.

import { join } from 'node:path';

export const DEFAULT_SERVER_USER = 'corami';

/**
 * The binary of the account: the setup copies the one of root here, and the
 * account runs this one, because it cannot read the binary of root, which
 * lives under the home of root.
 */
export function ownerBinary(home: string): string {
  return join(home, '.corami', 'bin', 'corami');
}

// The steps of `corami setup server` that need root, the others run as the
// owner account. `user` creates the account itself. `firewall` and `serve`
// touch the machine, `preflight` and `packages` check it, `tailscale` installs
// it: all of them run as root. `daemon` and `git-watch` install user services
// and write the account configuration, `summary` reads them back. `hosts`
// writes /etc/hosts.
export type StepIdentity = 'root' | 'owner';

export type ServerStep =
  | 'preflight'
  | 'packages'
  | 'tailscale'
  | 'hosts'
  | 'user'
  | 'firewall'
  | 'daemon'
  | 'git-watch'
  | 'serve'
  | 'summary';

const STEP_IDENTITIES: Record<ServerStep, StepIdentity> = {
  preflight: 'root',
  packages: 'root',
  tailscale: 'root',
  hosts: 'root',
  user: 'root',
  firewall: 'root',
  daemon: 'owner',
  'git-watch': 'owner',
  serve: 'owner',
  summary: 'owner',
};

export function stepIdentity(step: ServerStep): StepIdentity {
  return STEP_IDENTITIES[step];
}

/**
 * True when the name can be created with `useradd`. The check is stricter
 * than what Linux accepts, so that a name never carries a shell character or
 * a leading `-` into a command line.
 */
export function isValidServerUser(name: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(name) && !RESERVED_USERS.has(name);
}

// Accounts that already exist, or that Corami must never take over.
const RESERVED_USERS = new Set([
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'games',
  'man',
  'lp',
  'mail',
  'news',
  'uucp',
  'proxy',
  'www-data',
  'backup',
  'list',
  'irc',
  'gnats',
  'nobody',
  'systemd-network',
  'systemd-resolve',
  'messagebus',
  'sshd',
  'corami-daemon',
]);

export interface ServerUserSources {
  /** The `--user` flag of the setup. */
  flag?: string | undefined;
  /** `server_user` of the global configuration, saved by an earlier setup. */
  configured?: string | undefined;
  /** `user` of the `/v1/health` answer of the server, on a client. */
  announced?: string | undefined;
}

/**
 * The account to work with, from the most explicit source: the flag, the
 * configuration, then what the server announces. Undefined when no source has
 * one, and the caller picks the default or asks.
 */
export function serverUser(sources: ServerUserSources): string | undefined {
  for (const candidate of [sources.flag, sources.configured, sources.announced]) {
    if (candidate !== undefined && candidate !== '') {
      return candidate;
    }
  }

  return undefined;
}

// The groups that let an account become root without a password: `sudo` and
// `wheel` through sudo, `docker` through a container that mounts the host.
const PRIVILEGED_GROUPS = ['sudo', 'wheel', 'docker', 'lxd', 'adm'];

/**
 * The groups of `id -nG` that give the account root in practice, if any. An
 * empty answer means the account is not privileged.
 */
export function privilegedGroups(groupNames: string): string[] {
  const groups = groupNames.split(/\s+/).filter((group) => group !== '');

  return groups.filter((group) => PRIVILEGED_GROUPS.includes(group));
}

/**
 * The account a command run as root has to leave to: the one that owns the
 * projects on this server. Undefined when the command may run where it is.
 */
export function accountToLeaveTo(options: {
  platform: string;
  user: string;
  config: { role: string; server_user?: string | undefined } | undefined;
}): string | undefined {
  if (options.platform !== 'linux' || options.user !== 'root') {
    return undefined;
  }

  const owner = options.config?.role === 'server' ? options.config.server_user : undefined;

  return owner === undefined || owner === options.user ? undefined : owner;
}

/**
 * True when `sudo -l -U <user>` lists at least one command, so the account can
 * use sudo. A denied account prints "not allowed" instead.
 */
export function canSudo(sudoListOutput: string): boolean {
  if (/not allowed to run sudo/i.test(sudoListOutput) || /may not run sudo/i.test(sudoListOutput)) {
    return false;
  }

  return /^[ \t]*\(.*\)[ \t]+\S/m.test(sudoListOutput);
}
