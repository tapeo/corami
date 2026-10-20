import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { run, shellQuote } from '@/core/exec.ts';
import { copyInventory, type Inventory } from '@/core/local-copy.ts';

export function archiveList(root: string, inventory: Inventory = copyInventory(root)): string[] {
  return archivePlan(root, inventory).entries;
}

export interface ArchivePlan {
  entries: string[];
  bytes: number;
}

export function archivePlan(root: string, inventory: Inventory = copyInventory(root)): ArchivePlan {
  const git = gitEntries(root);

  return {
    entries: [...inventory.synced.map((entry) => entry.path), ...git.entries],
    bytes:
      inventory.synced.reduce(
        (sum, entry) => (entry.kind === 'file' ? sum + entry.bytes : sum),
        0,
      ) + git.bytes,
  };
}

export function archiveBytes(root: string, inventory: Inventory = copyInventory(root)): number {
  return archivePlan(root, inventory).bytes;
}

function gitEntries(root: string): { entries: string[]; bytes: number } {
  const git = join(root, '.git');

  if (!existsSync(git)) {
    return { entries: [], bytes: 0 };
  }

  const stack = [git];
  const entries = ['.git'];
  let bytes = 0;

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

    const found: string[] = [];

    for (const name of names) {
      if (transientGitFile(name)) {
        continue;
      }

      const full = join(current, name);
      const path = toPosix(relative(root, full));

      let info: ReturnType<typeof lstatSync>;

      try {
        info = lstatSync(full);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        stack.push(full);
      } else if (info.isFile()) {
        bytes += info.size;
      }

      found.push(path);
    }

    entries.push(...found.sort());
  }

  return { entries: entries.sort((left, right) => comparePaths(left, right)), bytes };
}

function transientGitFile(name: string): boolean {
  return (
    name.endsWith('.lock') ||
    name === 'gc.pid' ||
    name.startsWith('tmp_pack_') ||
    name.startsWith('tmp_idx_') ||
    name.startsWith('tmp_rev_') ||
    name.startsWith('tmp_midx_')
  );
}

function comparePaths(left: string, right: string): number {
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  const shared = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < shared; index += 1) {
    const leftPart = leftParts[index] ?? '';
    const rightPart = rightParts[index] ?? '';

    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return leftParts.length - rightParts.length;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export interface Manifest {
  files: number;
  links: number;
  dirs: number;
  bytes: number;
  hash: string;
  entries: string[];
}

export function manifestOf(inventory: Inventory): Manifest {
  return manifestFromLines(
    inventory.synced.map((entry) => {
      if (entry.kind === 'link') {
        return `l\t${entry.path}\t${entry.target ?? ''}`;
      }

      if (entry.kind === 'dir') {
        return `d\t${entry.path}`;
      }

      return `f\t${entry.path}\t${entry.bytes}`;
    }),
  );
}

export function localManifest(root: string): Manifest {
  return manifestOf(copyInventory(root));
}

function manifestFromLines(unsorted: string[]): Manifest {
  const lines = [...unsorted].sort();
  let files = 0;
  let links = 0;
  let dirs = 0;
  let bytes = 0;

  for (const line of lines) {
    const [kind = '', , size = ''] = line.split('\t');

    if (kind === 'f') {
      files += 1;
      bytes += Number(size);
    } else if (kind === 'l') {
      links += 1;
    } else if (kind === 'd') {
      dirs += 1;
    }
  }

  return {
    files,
    links,
    dirs,
    bytes,
    hash: createHash('sha256').update(lines.join('\n')).digest('hex'),
    entries: lines,
  };
}

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

export interface RemoteHome {
  home: string | undefined;
  sshOutput: string;
}

export type RemoteFolderState = 'missing' | 'empty' | 'taken';

export function remoteFolderStateCommand(path: string): string {
  const folder = shellQuote(path);

  return [
    `{ test -e ${folder} && echo there || echo missing; }`,
    `{ ls -A ${folder} 2>/dev/null | grep -q . && echo '|taken' || echo '|empty'; }`,
  ].join('; ');
}

export async function remoteFolderState(
  host: string,
  user: string,
  path: string,
  runner: ManifestRunner = sshManifestRunner(host, user),
): Promise<RemoteFolderState | undefined> {
  const result = await runner(remoteFolderStateCommand(path));
  const [presence = '', content = ''] = result.stdout
    .trim()
    .split('|')
    .map((part) => part.trim());

  if (presence === 'missing') {
    return 'missing';
  }

  if (presence !== 'there') {
    return undefined;
  }

  return content === 'empty' ? 'empty' : content === 'taken' ? 'taken' : undefined;
}

const STRIPPED_PATH = '$' + '{f#./}';

const REMOTE_MANIFEST_FALLBACK = [
  'for f do',
  `if [ -L "$f" ]; then printf "l\\000%s\\000\\000%s\\000" "${STRIPPED_PATH}" "$(readlink "$f")";`,
  `elif [ -d "$f" ]; then printf "d\\000%s\\000\\000\\000" "${STRIPPED_PATH}";`,
  `elif [ -f "$f" ]; then printf "f\\000%s\\000%s\\000\\000" "${STRIPPED_PATH}" "$(wc -c < "$f" | tr -d " ")";`,
  'fi',
  'done',
].join(' ');

export function remoteManifestCommand(path: string, printf = true): string {
  const folder = shellQuote(path);
  const fallback = `find . -mindepth 1 -path ./.git -prune -o -exec sh -c '${REMOTE_MANIFEST_FALLBACK}' sh {} +`;

  if (!printf) {
    return `cd ${folder} || exit 1; ${fallback}`;
  }

  const primary = `find . -mindepth 1 -path ./.git -prune -o -printf '%y\\0%P\\0%s\\0%l\\0'`;

  return `cd ${folder} || exit 1; ${primary} 2>/dev/null || ${fallback}`;
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

  const result = await runner(remoteManifestCommand(path));

  if (!result.ok && result.stdout.trim() === '') {
    return undefined;
  }

  return parseManifest(result.stdout);
}

export function parseManifest(raw: string): Manifest {
  const fields = raw.split('\0');

  if (fields[fields.length - 1] === '') {
    fields.pop();
  }

  const lines: string[] = [];

  for (let index = 0; index + 3 < fields.length; index += 4) {
    const kind = fields[index] ?? '';
    const path = fields[index + 1] ?? '';
    const size = fields[index + 2] ?? '';
    const target = fields[index + 3] ?? '';

    if (path === '') {
      continue;
    }

    if (kind === 'f') {
      lines.push(`f\t${path}\t${size}`);
    } else if (kind === 'l') {
      lines.push(`l\t${path}\t${target}`);
    } else if (kind === 'd') {
      lines.push(`d\t${path}`);
    }
  }

  return manifestFromLines(lines);
}

export function manifestsMatch(left: Manifest, right: Manifest): boolean {
  return (
    left.hash === right.hash &&
    left.files === right.files &&
    left.links === right.links &&
    left.dirs === right.dirs
  );
}

export function manifestDiff(left: Manifest, right: Manifest, limit = 3): string | undefined {
  if (manifestsMatch(left, right)) {
    return undefined;
  }

  const leftOnly = difference(left.entries, right.entries);
  const rightOnly = difference(right.entries, left.entries);
  const parts: string[] = [];

  if (leftOnly.length > 0) {
    parts.push(`only here: ${describeLines(leftOnly, limit)}`);
  }

  if (rightOnly.length > 0) {
    parts.push(`only on the server: ${describeLines(rightOnly, limit)}`);
  }

  return parts.length > 0 ? parts.join('; ') : 'the entries differ';
}

function difference(lines: string[], other: string[]): string[] {
  const seen = new Set(other);

  return lines.filter((line) => !seen.has(line)).map((line) => line.split('\t')[1] ?? line);
}

function describeLines(paths: string[], limit: number): string {
  const shown = paths.slice(0, limit).join(', ');
  const rest = paths.length - Math.min(paths.length, limit);

  return rest > 0 ? `${shown} and ${rest} more` : shown;
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

export function factsMatch(left: GitFacts, right: GitFacts): boolean {
  return left.head === right.head && left.refs === right.refs && left.stashes === right.stashes;
}
