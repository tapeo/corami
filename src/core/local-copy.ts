import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { paths } from '@/core/config.ts';
import { run } from '@/core/exec.ts';

export interface PathRule {
  pattern: string;
  class: PathClass;
  directories?: boolean | undefined;
}

export type PathClass = 'regenerable' | 'local_only' | 'synced';

export const PATH_RULES: PathRule[] = [
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

  { pattern: 'android/local.properties', class: 'local_only' },
  { pattern: 'ios/Flutter/Generated.xcconfig', class: 'local_only' },
  { pattern: 'ios/Flutter/flutter_export_environment.sh', class: 'local_only' },
  { pattern: 'ios/.symlinks', class: 'local_only', directories: true },
];

interface CompiledRule {
  rule: PathRule;
  matcher: RegExp;
  segments: string[];
}

const COMPILED_RULES: CompiledRule[] = PATH_RULES.map((rule) => ({
  rule,
  matcher: globToRegExp(rule.pattern),
  segments: rule.pattern.split('/'),
}));

export function isRegenerableFolder(folderName: string): boolean {
  return PATH_RULES.some(
    (rule) =>
      rule.class === 'regenerable' &&
      rule.directories === true &&
      !rule.pattern.includes('/') &&
      rule.pattern === folderName,
  );
}

export function classifyPath(relativePath: string, isDirectory = false): PathClass {
  const segments = relativePath.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    return 'synced';
  }

  for (const entry of COMPILED_RULES) {
    const length = entry.segments.length;

    for (let index = 0; index + length <= segments.length; index += 1) {
      if (entry.rule.directories === true && index + length === segments.length && !isDirectory) {
        continue;
      }

      const path = segments.slice(index, index + length).join('/');

      if (entry.matcher.test(path)) {
        return entry.rule.class;
      }
    }
  }

  return 'synced';
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export type InventoryKind = 'file' | 'dir' | 'link';

export interface InventoryEntry {
  path: string;
  kind: InventoryKind;
  bytes: number;
  target?: string;
}

export interface Inventory {
  synced: InventoryEntry[];
  localOnly: InventoryEntry[];
}

const MAX_PORTABLE_LINK_TARGET = 247;

export function symlinkPortable(path: string, target: string): boolean {
  if (target === '') {
    return false;
  }

  if (Buffer.byteLength(target) > MAX_PORTABLE_LINK_TARGET) {
    return false;
  }

  if (target.includes(':')) {
    return false;
  }

  let normalized = target;

  if (process.platform === 'win32') {
    normalized = target.replace(/\\/g, '/');
  } else if (target.includes('\\')) {
    return false;
  }

  if (normalized.startsWith('/')) {
    return false;
  }

  let depth = path.split('/').length - 1;

  for (const component of normalized.split('/')) {
    if (component === '.') {
      continue;
    }

    depth += component === '..' ? -1 : 1;

    if (depth < 0) {
      return false;
    }
  }

  return true;
}

export function copyInventory(root: string): Inventory {
  const inventory: Inventory = { synced: [], localOnly: [] };

  walkInventory(root, root, inventory);
  inventory.synced.sort(byPath);
  inventory.localOnly.sort(byPath);

  return inventory;
}

function walkInventory(root: string, current: string, inventory: Inventory): void {
  let names: string[];

  try {
    names = readdirSync(current);
  } catch {
    return;
  }

  for (const name of names) {
    const full = join(current, name);
    const path = toPosix(relative(root, full));

    if (path === '.git') {
      continue;
    }

    let stats: ReturnType<typeof lstatSync>;

    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }

    if (stats.isSymbolicLink()) {
      const target = linkTarget(full);

      if (target === undefined) {
        continue;
      }

      addEntry(inventory, classifyPath(path), {
        path,
        kind: 'link',
        bytes: Buffer.byteLength(target),
        target,
      });
      continue;
    }

    if (stats.isDirectory()) {
      const pathClass = classifyPath(path, true);

      if (pathClass === 'regenerable') {
        continue;
      }

      addEntry(inventory, pathClass, { path, kind: 'dir', bytes: 0 });

      if (pathClass === 'synced') {
        walkInventory(root, full, inventory);
      }

      continue;
    }

    if (stats.isFile()) {
      addEntry(inventory, classifyPath(path), { path, kind: 'file', bytes: stats.size });
    }
  }
}

function addEntry(inventory: Inventory, pathClass: PathClass, entry: InventoryEntry): void {
  const local =
    pathClass === 'local_only' ||
    (entry.kind === 'link' && !symlinkPortable(entry.path, entry.target ?? ''));

  if (local) {
    inventory.localOnly.push(entry);
    return;
  }

  if (pathClass === 'synced') {
    inventory.synced.push(entry);
  }
}

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function byPath(left: InventoryEntry, right: InventoryEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function findLocalOnlyFiles(root: string, limit = 200): InventoryEntry[] {
  return copyInventory(root).localOnly.slice(0, limit);
}

export function directorySize(root: string): number {
  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined) {
      break;
    }

    let names: string[];

    try {
      names = readdirSync(current);
    } catch {
      continue;
    }

    for (const name of names) {
      const full = join(current, name);

      try {
        const stats = lstatSync(full);
        const path = toPosix(relative(root, full));

        if (stats.isDirectory()) {
          if (classifyPath(path, true) === 'regenerable') {
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
