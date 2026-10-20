import { join } from 'node:path';

import { run, runOrThrow } from '@/core/exec.ts';

export const CORAMI_KEY_NAME = 'id_ed25519_corami';

export const EXEC_KEY_NAME = 'id_ed25519_corami_exec';

export interface ProviderSpec {
  id: string;
  host: string;
  sshUrl: string;
  newKeyUrl: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  github: {
    id: 'github',
    host: 'github.com',
    sshUrl: 'git@github.com',
    newKeyUrl: 'https://github.com/settings/ssh/new',
  },
  gitlab: {
    id: 'gitlab',
    host: 'gitlab.com',
    sshUrl: 'git@gitlab.com',
    newKeyUrl: 'https://gitlab.com/-/user_settings/ssh_keys',
  },
  bitbucket: {
    id: 'bitbucket',
    host: 'bitbucket.org',
    sshUrl: 'git@bitbucket.org',
    newKeyUrl: 'https://bitbucket.org/account/settings/ssh-keys/',
  },
};

export function sshDir(): string {
  const home = process.env.HOME ?? '/root';
  return join(home, '.ssh');
}

export function keyPath(): string {
  return join(sshDir(), CORAMI_KEY_NAME);
}

export function publicKeyPath(): string {
  return `${keyPath()}.pub`;
}

export function execKeyPath(): string {
  return join(sshDir(), EXEC_KEY_NAME);
}

export function execPublicKeyPath(): string {
  return `${execKeyPath()}.pub`;
}

export async function keyExists(): Promise<boolean> {
  return Bun.file(keyPath()).exists();
}

export async function generateKey(comment: string): Promise<void> {
  if (await keyExists()) {
    return;
  }

  await run('mkdir', ['-p', sshDir(), '-m', '700']);
  await runOrThrow('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath()]);
}

export async function readPublicKey(): Promise<string> {
  return (await Bun.file(publicKeyPath()).text()).trim();
}

export async function ensureExecKey(): Promise<string> {
  const publicPath = execPublicKeyPath();

  if (await Bun.file(publicPath).exists()) {
    return (await Bun.file(publicPath).text()).trim();
  }

  await run('mkdir', ['-p', sshDir(), '-m', '700']);
  await runOrThrow('ssh-keygen', [
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'corami-exec',
    '-f',
    execKeyPath(),
  ]);

  return (await Bun.file(publicPath).text()).trim();
}

export async function readExecPublicKey(): Promise<string | undefined> {
  try {
    const text = (await Bun.file(execPublicKeyPath()).text()).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

export async function addSshConfig(provider: ProviderSpec): Promise<boolean> {
  const path = join(sshDir(), 'config');
  const marker = `Host ${provider.host}`;
  const existing = (await Bun.file(path).exists()) ? await Bun.file(path).text() : '';

  if (existing.includes(marker)) {
    return false;
  }

  const block = [
    `Host ${provider.host}`,
    `  HostName ${provider.host}`,
    '  User git',
    `  IdentityFile ${keyPath()}`,
    '  IdentitiesOnly yes',
    '',
  ].join('\n');

  await run('mkdir', ['-p', sshDir(), '-m', '700']);
  await Bun.write(path, `${existing}${block}`);
  await run('chmod', ['600', path]);

  return true;
}

export async function rewriteHttpsRemotes(provider: ProviderSpec): Promise<void> {
  await run('git', ['config', '--global', '--unset-all', `url."${provider.sshUrl}:".insteadOf`]);
  await run('git', [
    'config',
    '--global',
    `url.${provider.sshUrl}:.insteadOf`,
    `https://${provider.host}/`,
  ]);
}

export async function testProvider(
  provider: ProviderSpec,
): Promise<{ ok: boolean; detail: string }> {
  const result = await run('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    '-T',
    provider.sshUrl,
  ]);

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const rejected = /permission denied|access denied/i.test(output);

  return { ok: !rejected, detail: output.split('\n').slice(0, 2).join(' ') };
}
