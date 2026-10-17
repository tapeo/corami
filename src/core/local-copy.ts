import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { paths } from '@/core/config.ts';
import { run } from '@/core/exec.ts';

/**
 * One path rule, the single source of the paths a copy never carries: the sync
 * ignores them, the import leaves them out of the archive, and the removal
 * checks count them as local only. Every place that needs one of those lists
 * derives it from here, so they cannot drift apart.
 *
 * `.git` is the one exception: the sync never carries it, because every copy
 * has its own repository, but the import does. The project that lands on the
 * server is a clone, with the history and the uncommitted work of the folder
 * it came from. The manifest of the import leaves `.git` out on both sides and
 * the history is compared on its own, ref by ref.
 *
 * Everything else travels: a key, an env file or any other file of the project
 * is a file of the project. Keeping one out of the machines is the user's
 * decision, made by keeping it out of the folder or by injecting it from an
 * external store.
 */
export interface PathRule {
  /** Without `/` the name matches at any level; with `/` it matches from the root. */
  pattern: string;
  class: PathClass;
  /** A trailing `/` matches directories only. */
  directories?: boolean | undefined;
}

export type PathClass = 'regenerable' | 'local_only' | 'synced';

export const PATH_RULES: PathRule[] = [
  // Regenerable: rebuilt by every machine, never carried.
  { pattern: '.git', class: 'regenerable', directories: true },
  { pattern: 'node_modules', class: 'regenerable', directories: true },
  { pattern: '.next', class: 'regenerable', directories: true },
  { pattern: '.turbo', class: 'regenerable', directories: true },
  { pattern: '.expo', class: 'regenerable', directories: true },
  { pattern: 'dist', class: 'regenerable', directories: true },
  { pattern: 'build', class: 'regenerable', directories: true },
  { pattern: 'coverage', class: 'regenerable', directories: true },
  { pattern: '.dart_tool', class: 'regenerable', directories: true },
  { pattern: '.fvm', class: 'regenerable', directories: true },
  { pattern: 'Pods', class: 'regenerable', directories: true },
  { pattern: '.gradle', class: 'regenerable', directories: true },
  { pattern: 'ephemeral', class: 'regenerable', directories: true },
  { pattern: '.venv', class: 'regenerable', directories: true },
  { pattern: '__pycache__', class: 'regenerable', directories: true },
  { pattern: '.DS_Store', class: 'regenerable' },
  { pattern: '._*', class: 'regenerable' },
  { pattern: '.flutter-plugins', class: 'regenerable' },
  { pattern: '.flutter-plugins-dependencies', class: 'regenerable' },

  // Local only: generated for this machine, with paths that would break the
  // build of another one.
  { pattern: 'android/local.properties', class: 'local_only' },
  { pattern: 'ios/Flutter/Generated.xcconfig', class: 'local_only' },
  { pattern: 'ios/Flutter/flutter_export_environment.sh', class: 'local_only' },
  { pattern: 'ios/.symlinks', class: 'local_only', directories: true },
];

interface CompiledRule {
  rule: PathRule;
  matcher: RegExp;
  rooted: boolean;
}

const COMPILED_RULES: CompiledRule[] = PATH_RULES.map((rule) => ({
  rule,
  matcher: globToRegExp(rule.pattern),
  rooted: rule.pattern.includes('/'),
}));

/** Whether a folder name, alone or as any folder of a path, is regenerable. */
export function isRegenerableFolder(folderName: string): boolean {
  return PATH_RULES.some(
    (rule) =>
      rule.class === 'regenerable' &&
      rule.directories === true &&
      !rule.pattern.includes('/') &&
      rule.pattern === folderName,
  );
}

/** The patterns of the given classes, in the syntax the rules describe. */
export function patternsOf(...classes: PathClass[]): string[] {
  return PATH_RULES.filter((rule) => classes.includes(rule.class)).map((rule) =>
    rule.directories === true ? `${rule.pattern}/` : rule.pattern,
  );
}

/**
 * The class of one path inside a copy, relative to its root and with `/` as
 * separator. A rule matches the name of a file or the name of any folder above
 * it; the first match wins, exactly as in a gitignore. A path no rule matches
 * is `synced`: it travels.
 */
export function classifyPath(relativePath: string): PathClass {
  const segments = relativePath.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    return 'synced';
  }

  for (const entry of COMPILED_RULES) {
    // The rules see a path, not a file: a folder rule applies to a folder the
    // path goes through, whether or not the path names the folder itself.
    if (segments.some((_, index) => matchesAt(entry, segments, index))) {
      return entry.rule.class;
    }
  }

  return 'synced';
}

function matchesAt(entry: CompiledRule, segments: string[], index: number): boolean {
  // A folder rule never matches the last segment alone: the path is a folder
  // only when it goes through the name, and a file with the same name is not
  // the folder the rule is about.
  if (entry.rule.directories === true && index === segments.length - 1) {
    return false;
  }

  const path = matchesPath(entry, segments, index);

  return entry.matcher.test(path);
}

function matchesPath(entry: CompiledRule, segments: string[], index: number): string {
  return entry.rooted ? segments.slice(0, index + 1).join('/') : (segments[index] ?? '');
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export interface LocalOnlyFile {
  path: string;
  bytes: number;
}

/**
 * The files the copy carries and the server never sees: the ones the sync
 * ignores that nothing regenerates, and that would break the build of another
 * machine. Inside a regenerable folder nothing is reported, the folder is
 * rebuilt from scratch.
 */
export function findLocalOnlyFiles(root: string, limit = 200): LocalOnlyFile[] {
  const found: LocalOnlyFile[] = [];

  walk(root, root, found, limit);

  return found;
}

function walk(root: string, current: string, found: LocalOnlyFile[], limit: number): void {
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
    const path = toPosix(relative(root, full));
    let stats: ReturnType<typeof statSync>;

    try {
      stats = statSync(full);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      if (isRegenerableFolder(entry)) {
        continue;
      }

      walk(root, full, found, limit);
      continue;
    }

    if (classifyPath(path) === 'local_only') {
      found.push({ path, bytes: stats.size });
    }
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
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
          if (isRegenerableFolder(entry)) {
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
