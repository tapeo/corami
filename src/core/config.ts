import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, posix } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { fileExists } from '@/core/exec.ts';
import { accountToLeaveTo } from '@/core/server-user.ts';

export type Role = 'server' | 'client';

export interface GlobalConfig {
  role: Role;
  server_host?: string | undefined;
  owner_login?: string | undefined;
  // On a server, the account that owns the projects and runs the services. On
  // a client, the account to use on the server for SSH and the sync.
  server_user?: string | undefined;
}

export interface CoramiPaths {
  root: string;
  config: string;
  bin: string;
  state: string;
  logs: string;
  syncState: string;
  /** The token local processes present to the daemon of this machine. */
  daemonToken: string;
}

export function homeDirectory(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return home;
}

export function paths(): CoramiPaths {
  const home = homeDirectory();

  if (home === '') {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'Cannot determine the home directory',
      fix: 'Set HOME, or run corami from a normal user session',
    });
  }

  const root = join(home, '.corami');

  return {
    root,
    config: join(root, 'config.json'),
    bin: join(root, 'bin'),
    state: join(root, 'state.db'),
    logs: join(root, 'logs'),
    syncState: join(root, 'sync-state.json'),
    daemonToken: join(root, 'daemon-token'),
  };
}

/**
 * The folder of the projects of a server: directly in the home of the account
 * that owns them. That account exists for the projects, and `~/corami/projects`
 * under `/home/corami` would repeat the name. The path is the one of the
 * server, so it stays POSIX even when the command runs on a Windows client.
 */
export function projectsRootFor(home: string): string {
  return posix.join(home, 'projects');
}

/** A project on the server: `/home/corami/projects/<name>`, `~/projects/<name>`. */
export function serverProjectPath(home: string, name: string): string {
  return posix.join(projectsRootFor(home), name);
}

export function projectRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return projectsRootFor(home);
}

export function parseConfig(text: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object');
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Invalid JSON in ${source}`,
    });
  }
}

export async function readGlobalConfig(): Promise<GlobalConfig | undefined> {
  const { config } = paths();

  if (!(await fileExists(config))) {
    return undefined;
  }

  const parsed = parseConfig(await Bun.file(config).text(), config);
  const role = parsed.role;

  if (role !== 'server' && role !== 'client') {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Missing or invalid "role" in ${config}`,
      fix: 'Set "role" to "server" or "client"',
    });
  }

  return parsed as unknown as GlobalConfig;
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  const { config: path } = paths();
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The token local processes of this machine present to the daemon, generated
 * by the daemon at its first start. The file is readable only by the account
 * that owns `~/.corami`: another account of the server cannot open the door.
 */
export async function readDaemonToken(): Promise<string | undefined> {
  const { daemonToken } = paths();

  try {
    const token = (await Bun.file(daemonToken).text()).trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

export async function ensureDaemonToken(): Promise<string> {
  const { daemonToken } = paths();
  const existing = await readDaemonToken();

  if (existing !== undefined) {
    return existing;
  }

  const token = randomBytes(32).toString('hex');

  mkdirSync(paths().root, { recursive: true, mode: 0o700 });
  await Bun.write(daemonToken, `${token}\n`);
  chmodSync(daemonToken, 0o600);

  return token;
}

export async function requireServerRole(): Promise<GlobalConfig> {
  const config = await readGlobalConfig();

  if (config === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'No Corami configuration on this machine',
      fix: 'Run corami setup server, or corami setup client <server> to connect a client',
    });
  }

  if (config.role !== 'server') {
    throw new CoramiError({
      code: 'config_invalid',
      message: `This command runs on the server, but this machine is a ${config.role}`,
      fix: 'Run the command on the server',
    });
  }

  return config;
}

/**
 * The account a command run as root has to leave to: the one that owns the
 * projects on this server. Undefined when the command may run where it is.
 * The decision is in `src/core/server-user.ts`, the reading of the
 * configuration here, next to the other ones.
 */
export async function ownerToSwitchTo(): Promise<string | undefined> {
  const config = await readGlobalConfig().catch(() => undefined);

  return accountToLeaveTo({
    platform: process.platform,
    user: userInfo().username,
    config,
  });
}
