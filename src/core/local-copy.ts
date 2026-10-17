import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
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
 *
 * A pattern with `/` matches at any depth, like a name rule: `ios/.symlinks`
 * covers the Flutter app at the root and the one under `apps/demo`. A folder
 * whose path is `local_only` is never entered: it belongs to this machine
 * whole, with the links it holds.
 */
export interface PathRule {
  /** Without `/` the name matches at any level; with `/` the path matches at any level too. */
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
  segments: string[];
}

const COMPILED_RULES: CompiledRule[] = PATH_RULES.map((rule) => ({
  rule,
  matcher: globToRegExp(rule.pattern),
  segments: rule.pattern.split('/'),
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

/**
 * The class of one path inside a copy, relative to its root and with `/` as
 * separator. A rule matches a path at any depth, exactly as in a gitignore: a
 * pattern with `/` matches the path itself at any level, a name at any level
 * matches the name. A folder rule matches a folder only, so the walk of a copy
 * passes `isDirectory` for the entries it lists: a file named `build` travels,
 * the folder `build` does not. The first match wins. A path no rule matches is
 * `synced`: it travels.
 */
export function classifyPath(relativePath: string, isDirectory = false): PathClass {
  const segments = relativePath.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    return 'synced';
  }

  for (const entry of COMPILED_RULES) {
    const length = entry.segments.length;

    for (let index = 0; index + length <= segments.length; index += 1) {
      // A folder rule never matches a file: only a folder, or a path that goes
      // through the folder.
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
  /** The bytes of a file, or the length of a link target. Zero for a folder. */
  bytes: number;
  /** Links only: the target as it is written, never resolved. */
  target?: string;
}

export interface Inventory {
  /** What the import carries and the sync keeps in step. `.git` is not here. */
  synced: InventoryEntry[];
  /** What stays on this machine: the archive never carries it, the copy gets it back. */
  localOnly: InventoryEntry[];
}

const MAX_PORTABLE_LINK_TARGET = 247;

/**
 * Whether Mutagen in its `portable` mode, which Corami uses, carries a link:
 * a relative target of safe characters that never leaves the root. This is the
 * rule of `normalizeSymbolicLinkAndEnsurePortable` in Mutagen v0.18.1
 * (`pkg/synchronization/core/symbolic_link.go`), copied here so the import and
 * the sync agree on what a link of this machine is. A new pinned Mutagen is a
 * reason to check it again.
 */
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

  // The folder that holds the link: the target climbs at most back to the root.
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

/**
 * The inventory of one folder: every entry that travels, and every entry that
 * belongs to this machine. One walk, `lstat` only, so a link is an entry and
 * never a way into another folder: the manifest, the archive and the copy that
 * comes back all read the same decision from here. Regenerable folders are
 * never entered. A folder of this machine is listed whole and not entered.
 */
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

    // The root history is compared on its own, ref by ref, and the import
    // carries it whole: a `.git` file, as a worktree writes it, is no content
    // of the project. A `.git` deeper down is a submodule gitlink and travels.
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

    // Only a regular file or a link is content a copy carries: a FIFO, a socket
    // and a device are none of the three, and Mutagen leaves them untracked.
    if (stats.isFile()) {
      addEntry(inventory, classifyPath(path), { path, kind: 'file', bytes: stats.size });
    }
  }
}

/**
 * A link whose target cannot be read, or that the sync would not carry, is a
 * file of this machine: it stays here and the copy gets it back, never the
 * server.
 */
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

/**
 * The entries the copy carries and the server never sees: the ones the sync
 * ignores that nothing regenerates, and the links that point outside the
 * folder, which no other machine could follow.
 */
export function findLocalOnlyFiles(root: string, limit = 200): InventoryEntry[] {
  return copyInventory(root).localOnly.slice(0, limit);
}

/**
 * How much a folder takes on this machine. Links are counted by their own
 * size: following one would count content another folder owns.
 */
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
