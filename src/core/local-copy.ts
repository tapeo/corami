import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { paths } from '@/core/config.ts';
import { run } from '@/core/exec.ts';

/**
 * One path rule, the single source of the paths a copy never carries: the sync
 * ignores them, the import leaves them out of the archive, and the removal
 * checks count them as local only. Every place that needs one of those lists
 * derives it from here, so they cannot drift apart.
 */
export interface PathRule {
  /** Without `/` the name matches at any level; with `/` it matches from the root. */
  pattern: string;
  class: PathClass;
  /** A trailing `/` matches directories only. */
  directories?: boolean | undefined;
}

export type PathClass = 'regenerable' | 'key' | 'env' | 'local_only' | 'synced';

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

  // Keys and credentials: they never leave the machine they were created on.
  { pattern: '*.jks', class: 'key' },
  { pattern: '*.keystore', class: 'key' },
  { pattern: '*.p8', class: 'key' },
  { pattern: '*.p12', class: 'key' },
  { pattern: '*service-account*.json', class: 'key' },

  // Env files: they go to the server by import, and stay out of the sync.
  { pattern: '.env', class: 'env' },
  { pattern: '.env.*', class: 'env' },

  // Local only: nothing regenerates them, every machine keeps its own.
  { pattern: 'android/local.properties', class: 'local_only' },
  { pattern: 'android/key.properties', class: 'local_only' },
  { pattern: 'ios/Flutter/Generated.xcconfig', class: 'local_only' },
  { pattern: 'ios/Flutter/flutter_export_environment.sh', class: 'local_only' },
  { pattern: 'ios/.symlinks', class: 'local_only', directories: true },
  { pattern: '.flutter-plugins', class: 'local_only' },
  { pattern: '.flutter-plugins-dependencies', class: 'local_only' },
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
 * it; the first match wins, exactly as in a gitignore.
 */
export function classifyPath(relativePath: string, extraPatterns: string[] = []): PathClass {
  const segments = relativePath.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    return 'synced';
  }

  const name = segments[segments.length - 1] ?? '';

  for (const entry of COMPILED_RULES) {
    // The rules see a path, not a file: a folder rule applies to a folder the
    // path goes through, whether or not the path names the folder itself.
    if (segments.some((_, index) => matchesAt(entry, segments, index))) {
      return entry.rule.class;
    }
  }

  // The patterns of `--include` are paths of this project, not names.
  for (const pattern of extraPatterns) {
    if (globToRegExp(pattern).test(name)) {
      return 'key';
    }
  }

  return 'synced';
}

/** Whether a path is an env file, which the import copies to the server. */
export function classifyEnvPath(relativePath: string): boolean {
  return classifyPath(relativePath) === 'env';
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

export const SENSITIVE_PATTERNS = patternsOf('key', 'env');

const SENSITIVE_MATCHERS = SENSITIVE_PATTERNS.map((pattern) => globToRegExp(pattern));

export function isSensitiveName(name: string, extraPatterns: string[] = []): boolean {
  const matchers = [...SENSITIVE_MATCHERS, ...extraPatterns.map(globToRegExp)];
  return matchers.some((matcher) => matcher.test(name));
}

export interface LocalOnlyFile {
  path: string;
  bytes: number;
  class: Exclude<PathClass, 'synced' | 'regenerable'>;
}

/**
 * The files the copy carries and the server never sees: the ones the sync
 * ignores that nothing regenerates. Inside a regenerable folder nothing is
 * reported, the folder is rebuilt from scratch.
 */
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

      walk(root, full, extraPatterns, found, limit);
      continue;
    }

    const classified = classifyPath(path, extraPatterns);

    if (classified !== 'synced' && classified !== 'regenerable') {
      found.push({ path, bytes: stats.size, class: classified });
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
