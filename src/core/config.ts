import { homedir } from 'node:os';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { fileExists } from '@/core/exec.ts';

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
  };
}

export function projectRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return join(home, 'corami', 'projects');
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
