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
  wantedBy?: string | undefined;
}

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

export function renderUnit(spec: UnitSpec): string {
  const lines = [
    '[Unit]',
    `Description=${spec.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${spec.execStart}`,
  ];

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
  lines.push(`WantedBy=${spec.wantedBy ?? 'multi-user.target'}`);

  return `${lines.join('\n')}\n`;
}

export interface InstallUnitOptions {
  scope: 'system' | 'user';
  spec: UnitSpec;
  unitDir?: string | undefined;
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
  const dir = options.unitDir ?? unitDir(options.scope);
  const path = join(dir, `${options.spec.name}.service`);

  await run('mkdir', ['-p', dir]);
  await Bun.write(path, renderUnit(options.spec));
  await runOrThrow('systemctl', [...scopeArgs, 'daemon-reload'], { env });
  await runOrThrow('systemctl', [...scopeArgs, 'enable', `${options.spec.name}.service`], { env });
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

function unitDir(scope: InstallUnitOptions['scope']): string {
  if (scope === 'user') {
    const home = process.env.HOME ?? '';
    return join(home, '.config', 'systemd', 'user');
  }

  return '/etc/systemd/system';
}
