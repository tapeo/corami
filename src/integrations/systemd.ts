import { join } from 'node:path';

import { run, runOrThrow } from '@/core/exec.ts';

export interface UnitSpec {
  name: string;
  description: string;
  execStart: string;
  workingDirectory?: string | undefined;
  environment?: Record<string, string> | undefined;
  user?: string | undefined;
  restart?: 'always' | 'on-failure' | 'no' | undefined;
}

export type UnitScope = 'system' | 'user';

// The target a unit starts with at boot. The user manager has no
// `multi-user.target` and no `network-online.target`: a user unit enabled
// there is linked to a target that never starts, and stays down after a
// reboot.
const BOOT_TARGET: Record<UnitScope, string> = {
  system: 'multi-user.target',
  user: 'default.target',
};

export async function enableLinger(user: string): Promise<boolean> {
  await run('loginctl', ['enable-linger', user]);
  return runtimeDirExists(user);
}

export async function runtimeDirExists(user: string): Promise<boolean> {
  const uid = await userId(user);

  if (uid === undefined) {
    return false;
  }

  return (await run('test', ['-d', `/run/user/${uid}`])).ok;
}

export async function userId(user: string): Promise<number | undefined> {
  const result = await run('id', ['-u', user]);

  if (!result.ok) {
    return undefined;
  }

  const parsed = Number(result.stdout.trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The home directory of an account, from the passwd database: the home of the
 * account a unit runs as, which is not the home of the process that installs
 * the unit when the setup runs as root.
 */
export async function homeDirectoryForUser(user: string): Promise<string | undefined> {
  const result = await run('getent', ['passwd', user]);

  if (!result.ok) {
    return undefined;
  }

  const home = result.stdout.trim().split(':')[5] ?? '';
  return home === '' ? undefined : home;
}

export function renderUnit(spec: UnitSpec, scope: UnitScope): string {
  const lines = ['[Unit]', `Description=${spec.description}`];

  if (scope === 'system') {
    lines.push('After=network-online.target', 'Wants=network-online.target');
  }

  lines.push('', '[Service]', 'Type=simple', `ExecStart=${spec.execStart}`);

  if (spec.user !== undefined) {
    lines.push(`User=${spec.user}`);
  }

  if (spec.workingDirectory !== undefined) {
    lines.push(`WorkingDirectory=${spec.workingDirectory}`);
  }

  for (const [key, value] of Object.entries(spec.environment ?? {})) {
    lines.push(`Environment=${key}=${value}`);
  }

  lines.push(`Restart=${spec.restart ?? 'on-failure'}`, 'RestartSec=5', '', '[Install]');
  lines.push(`WantedBy=${BOOT_TARGET[scope]}`);

  return `${lines.join('\n')}\n`;
}

export interface InstallUnitOptions {
  scope: UnitScope;
  spec: UnitSpec;
  unitDir?: string | undefined;
  /** The home of the account a user unit belongs to, when installing one. */
  home?: string | undefined;
}

export function scopeEnv(scope: InstallUnitOptions['scope']): Record<string, string | undefined> {
  if (scope !== 'user') {
    return {};
  }

  const uid = process.getuid?.();

  if (uid === undefined) {
    return {};
  }

  return { XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

export async function installUnit(
  options: InstallUnitOptions,
): Promise<{ path: string; scope: InstallUnitOptions['scope'] }> {
  const scopeArgs = options.scope === 'user' ? ['--user'] : [];
  const env = scopeEnv(options.scope);
  const dir = options.unitDir ?? unitDir(options.scope, options.home);
  const path = join(dir, `${options.spec.name}.service`);

  await run('mkdir', ['-p', dir]);
  await Bun.write(path, renderUnit(options.spec, options.scope));
  await runOrThrow('systemctl', [...scopeArgs, 'daemon-reload'], { env });
  // `reenable` drops the links of an older unit before making the new ones: a
  // unit that changed its target is not left linked to the old one too.
  await runOrThrow('systemctl', [...scopeArgs, 'reenable', `${options.spec.name}.service`], {
    env,
  });
  await runOrThrow('systemctl', [...scopeArgs, 'restart', `${options.spec.name}.service`], { env });

  return { path, scope: options.scope };
}

export async function isUnitActive(
  name: string,
  scope: InstallUnitOptions['scope'] = 'system',
): Promise<boolean> {
  const scopeArgs = scope === 'user' ? ['--user'] : [];
  const result = await run('systemctl', [...scopeArgs, 'is-active', `${name}.service`]);
  return result.ok && result.stdout.trim() === 'active';
}

/**
 * `systemctl --user` of another account, from a process that cannot run it in
 * its own name: `runuser` does not set the runtime directory, and that is
 * where the user manager of the account is found.
 */
export async function systemctlAsUser(
  user: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  const uid = await userId(user);

  if (uid === undefined) {
    return { ok: false, stdout: '' };
  }

  const result = await run('runuser', [
    '-u',
    user,
    '--',
    'env',
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    'systemctl',
    '--user',
    ...args,
  ]);

  return { ok: result.ok, stdout: result.stdout };
}

function unitDir(scope: InstallUnitOptions['scope'], home?: string): string {
  if (scope === 'user') {
    const base = home ?? process.env.HOME ?? '';
    return join(base, '.config', 'systemd', 'user');
  }

  return '/etc/systemd/system';
}
