import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { paths } from '@/core/config.ts';
import { run } from '@/core/exec.ts';

export const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '*.jks',
  '*.keystore',
  '*.p8',
  '*.p12',
  '*service-account*.json',
];

export const REGENERABLE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.dart_tool',
  '.fvm',
  'Pods',
  '.gradle',
  'ephemeral',
  '.venv',
  '__pycache__',
]);

const SENSITIVE_MATCHERS = SENSITIVE_PATTERNS.map((pattern) => globToRegExp(pattern));

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function isSensitiveName(name: string, extraPatterns: string[] = []): boolean {
  const matchers = [...SENSITIVE_MATCHERS, ...extraPatterns.map(globToRegExp)];
  return matchers.some((matcher) => matcher.test(name));
}

export interface LocalOnlyFile {
  path: string;
  bytes: number;
}

export function findLocalOnlyFiles(
  root: string,
  extraPatterns: string[] = [],
  limit = 200,
): LocalOnlyFile[] {
  const found: LocalOnlyFile[] = [];

  walk(root, root, extraPatterns, found, limit);

  return found;
}

function walk(
  root: string,
  current: string,
  extraPatterns: string[],
  found: LocalOnlyFile[],
  limit: number,
): void {
  if (found.length >= limit) {
    return;
  }

  let entries: string[];

  try {
    entries = readdirSync(current);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (found.length >= limit) {
      return;
    }

    const full = join(current, entry);
    let stats: ReturnType<typeof statSync>;

    try {
      stats = statSync(full);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      if (REGENERABLE_DIRS.has(entry)) {
        continue;
      }

      walk(root, full, extraPatterns, found, limit);
      continue;
    }

    if (isSensitiveName(entry, extraPatterns)) {
      found.push({ path: relative(root, full), bytes: stats.size });
    }
  }
}

export function directorySize(root: string): number {
  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined) {
      break;
    }

    let entries: string[];

    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry);

      try {
        const stats = statSync(full);

        if (stats.isDirectory()) {
          if (REGENERABLE_DIRS.has(entry)) {
            continue;
          }

          stack.push(full);
          continue;
        }

        total += stats.size;
      } catch {}
    }
  }

  return total;
}

export interface SyncStateEntry {
  project: string;
  localPath: string;
  removedAt: string;
  freedBytes: number;
}

export interface SyncState {
  [project: string]: SyncStateEntry;
}

export async function readSyncState(): Promise<SyncState> {
  const { syncState } = paths();

  if (!existsSync(syncState)) {
    return {};
  }

  try {
    return JSON.parse(await Bun.file(syncState).text()) as SyncState;
  } catch {
    return {};
  }
}

export async function rememberRemoval(entry: SyncStateEntry): Promise<void> {
  const { syncState } = paths();
  const state = await readSyncState();
  state[entry.project] = entry;
  await Bun.write(syncState, `${JSON.stringify(state, null, 2)}\n`);
}

export interface LocalGit {
  branch: string;
  onlyLocal: number;
}

export async function localGit(root: string): Promise<LocalGit | undefined> {
  if (!existsSync(join(root, '.git'))) {
    return undefined;
  }

  const branch = await run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);

  if (!branch.ok) {
    return { branch: 'no commits', onlyLocal: 0 };
  }

  const commits = await run('git', [
    '-C',
    root,
    'rev-list',
    '--count',
    '--branches',
    '--tags',
    '--not',
    '--remotes',
  ]);
  const stashes = await run('git', ['-C', root, 'stash', 'list']);
  const commitCount = Number(commits.stdout.trim());
  let stashCount = 0;

  if (stashes.stdout.trim() !== '') {
    stashCount = stashes.stdout.trim().split('\n').length;
  }

  return {
    branch: branch.stdout.trim(),
    onlyLocal: commitCount + stashCount,
  };
}
