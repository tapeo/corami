import { cpSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '@/core/git.ts';

export interface Scene {
  origin: string;
  server: string;
  client: string;
}

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `corami-${prefix}-`));
  await git(root, ['init', '--quiet', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  return root;
}

export async function cloneAs(origin: string, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `corami-${name}-`));
  await git(root, ['clone', '--quiet', origin, '.']);
  await git(root, ['config', 'user.email', `${name}@example.com`]);
  await git(root, ['config', 'user.name', name]);
  return root;
}

export async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout;
}

export async function scene(): Promise<Scene> {
  const origin = await mkdtemp(join(tmpdir(), 'corami-origin-'));
  await git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);

  const seed = await repository('seed');
  await Bun.write(join(seed, 'app.ts'), 'first\n');
  await commit(seed, 'first');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '--quiet', 'origin', 'main']);
  rmSync(seed, { recursive: true, force: true });

  return {
    origin,
    server: await cloneAs(origin, 'server'),
    client: await cloneAs(origin, 'client'),
  };
}

export function removeScene(paths: Scene): void {
  for (const path of [paths.origin, paths.server, paths.client]) {
    rmSync(path, { recursive: true, force: true });
  }
}

export function syncFiles(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: (path) => !path.includes('/.git') });
}

export function copyPeerFiles(from: string, to: string): void {
  cpSync(join(from, '.git', 'corami'), join(to, '.git', 'corami'), { recursive: true });
}

export function copyPeerHeads(from: string, to: string): void {
  cpSync(join(from, '.git', 'corami'), join(to, '.git', 'corami'), {
    recursive: true,
    filter: (path) => !path.endsWith('.bundle'),
  });
}
