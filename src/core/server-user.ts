import { join } from 'node:path';

export const DEFAULT_SERVER_USER = 'corami';

export function ownerBinary(home: string): string {
  return join(home, '.corami', 'bin', 'corami');
}

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

export function isValidServerUser(name: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(name) && !RESERVED_USERS.has(name);
}

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
  flag?: string | undefined;
  configured?: string | undefined;
  announced?: string | undefined;
}

export function serverUser(sources: ServerUserSources): string | undefined {
  for (const candidate of [sources.flag, sources.configured, sources.announced]) {
    if (candidate !== undefined && candidate !== '') {
      return candidate;
    }
  }

  return undefined;
}

const PRIVILEGED_GROUPS = ['sudo', 'wheel', 'docker', 'lxd', 'adm'];

export function privilegedGroups(groupNames: string): string[] {
  const groups = groupNames.split(/\s+/).filter((group) => group !== '');

  return groups.filter((group) => PRIVILEGED_GROUPS.includes(group));
}

const NO_LOGIN_SHELLS = new Set([
  '/sbin/nologin',
  '/usr/sbin/nologin',
  '/bin/false',
  '/usr/bin/false',
  '/bin/sync',
  '/sbin/shutdown',
  '/sbin/halt',
]);

export function loginAccounts(passwd: string): string[] {
  const names: string[] = [];

  for (const line of passwd.split('\n')) {
    const fields = line.split(':');
    const [name, , uid, , , , shell] = fields;

    if (name === undefined || uid === undefined || shell === undefined) {
      continue;
    }

    const id = Number(uid);

    if (!Number.isInteger(id) || id < 1000 || id > 65533) {
      continue;
    }

    if (shell === '' || NO_LOGIN_SHELLS.has(shell)) {
      continue;
    }

    names.push(name);
  }

  return names;
}

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

export function ownerOfServer(
  config: { role: string; server_user?: string | undefined } | undefined,
): string | undefined {
  const user = config?.role === 'server' ? config.server_user : undefined;

  return user === undefined || user === 'root' ? undefined : user;
}

export function canSudo(sudoListOutput: string): boolean {
  if (/not allowed to run sudo/i.test(sudoListOutput) || /may not run sudo/i.test(sudoListOutput)) {
    return false;
  }

  return /^[ \t]*\(.*\)[ \t]+\S/m.test(sudoListOutput);
}
