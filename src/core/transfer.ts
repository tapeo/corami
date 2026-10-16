import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { run } from '@/core/exec.ts';

export const TAR_EXCLUDES = [
  './node_modules',
  './.next',
  './.turbo',
  './.expo',
  './dist',
  './build',
  './coverage',
  './.dart_tool',
  './.fvm',
  './ios/Pods',
  './android/.gradle',
  './.venv',
  './__pycache__',
  './.DS_Store',
];

export function tarExcludeArgs(excludes = TAR_EXCLUDES): string[] {
  return excludes.flatMap((path) => [`--exclude=${path}`]);
}

export interface Manifest {
  files: number;
  bytes: number;
  hash: string;
}

export function localManifest(root: string, excludes = TAR_EXCLUDES): Manifest {
  const entries: string[] = [];
  let bytes = 0;
  const skip = excludes.map((path) => path.replace(/^\.\//, ''));

  walkManifest(root, root, skip, entries);

  for (const entry of entries) {
    const size = entry.split('\t')[1];
    bytes += Number(size ?? '0');
  }

  const hash = createHash('sha256').update(entries.sort().join('\n')).digest('hex');

  return { files: entries.length, bytes, hash };
}

function isAppleDouble(name: string): boolean {
  return name.startsWith('._');
}

function walkManifest(root: string, current: string, skip: string[], entries: string[]): void {
  let names: string[];

  try {
    names = readdirSync(current);
  } catch {
    return;
  }

  for (const name of names) {
    const full = join(current, name);
    const relativePath = relative(root, full);

    if (relativePath === '.git' || skip.includes(relativePath) || isAppleDouble(name)) {
      continue;
    }

    try {
      const stats = statSync(full);

      if (stats.isDirectory()) {
        walkManifest(root, full, skip, entries);
        continue;
      }

      entries.push(`${relativePath}\t${stats.size}`);
    } catch {}
  }
}

export async function remoteManifest(
  host: string,
  user: string,
  path: string,
  excludes = TAR_EXCLUDES,
): Promise<Manifest | undefined> {
  const skipArgs = excludes
    .map((entry) => entry.replace(/^\.\//, ''))
    .map((entry) => `-not -path './${entry}/*'`)
    .join(' ');

  const script = [
    `cd ${shellQuote(path)} || exit 1`,
    `find . -type f -not -path './.git/*' -not -name '._*' ${skipArgs} -printf '%P\\t%s\\n' 2>/dev/null || find . -type f -not -path './.git/*' -not -name '._*' ${skipArgs} -exec stat -f '%N\\t%z' {} +`,
  ].join('; ');

  const result = await run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, script],
    {
      timeoutMs: 120_000,
    },
  );

  if (!result.ok && result.stdout.trim() === '') {
    return undefined;
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.includes('\t'));

  let bytes = 0;

  for (const line of lines) {
    bytes += Number(line.split('\t')[1] ?? '0');
  }

  return {
    files: lines.length,
    bytes,
    hash: createHash('sha256')
      .update([...lines].sort().join('\n'))
      .digest('hex'),
  };
}

export interface GitFacts {
  head: string;
  refs: number;
  stashes: number;
  dirty: number;
}

export async function localGitFacts(root: string): Promise<GitFacts | undefined> {
  return gitFacts(['git', '-C', root]);
}

export async function remoteGitFacts(
  host: string,
  user: string,
  path: string,
): Promise<GitFacts | undefined> {
  const script = [
    `cd ${shellQuote(path)} || exit 1`,
    'git rev-parse HEAD 2>/dev/null',
    'git for-each-ref --count=10000 | wc -l',
    'git stash list | wc -l',
    'git status --porcelain | wc -l',
  ].join('; ');

  const result = await run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, script],
    {
      timeoutMs: 120_000,
    },
  );

  if (!result.ok) {
    return undefined;
  }

  const lines = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim());

  if (lines.length < 4) {
    return undefined;
  }

  return {
    head: lines[0] ?? '',
    refs: Number(lines[1] ?? '0'),
    stashes: Number(lines[2] ?? '0'),
    dirty: Number(lines[3] ?? '0'),
  };
}

async function gitFacts(prefix: string[]): Promise<GitFacts | undefined> {
  const head = await run(prefix[0] ?? 'git', [...prefix.slice(1), 'rev-parse', 'HEAD']);

  if (!head.ok) {
    return undefined;
  }

  const refs = await run(prefix[0] ?? 'git', [...prefix.slice(1), 'for-each-ref', '--count=10000']);
  const stashes = await run(prefix[0] ?? 'git', [...prefix.slice(1), 'stash', 'list']);
  const status = await run(prefix[0] ?? 'git', [...prefix.slice(1), 'status', '--porcelain']);

  return {
    head: head.stdout.trim(),
    refs: refs.stdout.trim() === '' ? 0 : refs.stdout.trim().split('\n').length,
    stashes: stashes.stdout.trim() === '' ? 0 : stashes.stdout.trim().split('\n').length,
    dirty: status.stdout.trim() === '' ? 0 : status.stdout.trim().split('\n').length,
  };
}

export function manifestsMatch(left: Manifest, right: Manifest): boolean {
  return left.hash === right.hash && left.files === right.files;
}

export function factsMatch(left: GitFacts, right: GitFacts): boolean {
  return left.head === right.head && left.refs === right.refs && left.stashes === right.stashes;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
