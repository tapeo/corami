import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { run, shellQuote } from '@/core/exec.ts';
import { classifyPath, isRegenerableFolder, PATH_RULES, type PathRule } from '@/core/local-copy.ts';

/**
 * The arguments of the import archive, one per excluded path. `findExcludeArgs`
 * and the local manifest walk rebuild the same decision for the other side:
 * the three always agree on what an import carries. What is left out is what
 * the sync leaves out: the regenerable folders and the paths of one machine.
 */
export function tarExcludeArgs(): string[] {
  return PATH_RULES.filter((rule) => rule.class !== 'synced').map(
    (rule) => `--exclude=${tarPattern(rule)}`,
  );
}

/** The path as tar matches it: a name at any level, a `./` path from the root. */
export function tarPattern(rule: PathRule): string {
  return rule.pattern.includes('/') ? `./${rule.pattern}` : rule.pattern;
}

/** The `find` arguments of the remote manifest, matching every ignored path. */
export function findExcludeArgs(): string[] {
  const args: string[] = [];
  const seen = new Set<string>();

  const add = (flag: string, pattern: string): void => {
    const key = `${flag}${pattern}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    // Quoted: the remote shell must not expand the pattern it passes to find.
    args.push('-not', flag, shellQuote(pattern));
  };

  for (const rule of PATH_RULES) {
    if (rule.class === 'synced') {
      continue;
    }

    if (rule.pattern.includes('/')) {
      add('-path', `./${rule.pattern}${rule.directories === true ? '/*' : ''}`);
      continue;
    }

    // A name without a slash reaches every level, as it does for the sync.
    add('-name', rule.pattern);

    if (rule.directories === true) {
      add('-path', `*/${rule.pattern}/*`);
    }
  }

  return args;
}

export interface Manifest {
  files: number;
  bytes: number;
  hash: string;
}

/**
 * The manifest of the files the import carries: everything the sync carries,
 * keys and env files included, minus the regenerable folders and the paths of
 * this machine.
 */
export function localManifest(root: string): Manifest {
  const entries: string[] = [];

  walkManifest(root, root, entries);

  let bytes = 0;

  for (const entry of entries) {
    bytes += Number(entry.split('\t')[1] ?? '0');
  }

  const hash = createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex');

  return { files: entries.length, bytes, hash };
}

function walkManifest(root: string, current: string, entries: string[]): void {
  let names: string[];

  try {
    names = readdirSync(current);
  } catch {
    return;
  }

  for (const name of names) {
    const full = join(current, name);
    const relativePath = toPosix(relative(root, full));

    if (classifyPath(relativePath) !== 'synced') {
      continue;
    }

    try {
      const stats = statSync(full);

      if (stats.isDirectory()) {
        if (isRegenerableFolder(name)) {
          continue;
        }

        walkManifest(root, full, entries);
        continue;
      }

      entries.push(`${relativePath}\t${stats.size}`);
    } catch {}
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** How a remote manifest is read: over ssh, or locally in a test. */
export type ManifestRunner = (script: string) => Promise<{ ok: boolean; stdout: string }>;

export function sshManifestRunner(host: string, user: string): ManifestRunner {
  return async (script) => {
    const result = await run(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, script],
      {
        timeoutMs: 120_000,
      },
    );

    return { ok: result.ok, stdout: result.stdout };
  };
}

export async function remoteManifest(
  host: string,
  user: string,
  path: string,
  runner: ManifestRunner = sshManifestRunner(host, user),
): Promise<Manifest | undefined> {
  if (path.includes('\n') || path.includes('"')) {
    return undefined;
  }

  const skip = findExcludeArgs().join(' ');

  const script = [
    `cd ${shellQuote(path)} || exit 1`,
    `find . -type f ${skip} -printf '%P\\t%s\\n' 2>/dev/null || find . -type f ${skip} -exec stat -f '%N\\t%z' {} +`,
  ].join('; ');

  const result = await runner(script);

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
