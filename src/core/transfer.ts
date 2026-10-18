import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { run, shellQuote } from '@/core/exec.ts';
import { copyInventory, type Inventory } from '@/core/local-copy.ts';

/**
 * The list the archive carries, in the order `tar` writes it: the entries the
 * inventory says travel, plus the history of the folder. `.git` does not go
 * through the path rules, which would leave it out as regenerable: every copy
 * has one, but the project on the server is a clone of this one, with the
 * branches and the uncommitted work of the folder it came from. Parent folders
 * always come before their content, and `tar` runs with `--no-recursion`: the
 * list decides what the archive holds, never a pattern.
 */
export function archiveList(root: string, inventory: Inventory = copyInventory(root)): string[] {
  return [...inventory.synced.map((entry) => entry.path), ...gitEntries(root)];
}

function gitEntries(root: string): string[] {
  const git = join(root, '.git');

  if (!existsSync(git)) {
    return [];
  }

  const stack = [git];
  const entries = ['.git'];

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
      const full = join(current, name);
      const path = toPosix(relative(root, full));

      try {
        if (lstatSync(full).isDirectory()) {
          stack.push(full);
        }
      } catch {
        continue;
      }

      found.push(path);
    }

    entries.push(...found.sort());
  }

  return entries.sort((left, right) => comparePaths(left, right));
}

/** Parents before content, so `tar` finds the folder of an entry already made. */
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
  /** One line per entry, sorted: what the two sides compare and report. */
  entries: string[];
}

/**
 * The manifest of the entries the import carries: everything the sync carries,
 * keys and env files included, minus the regenerable folders and the paths of
 * this machine. One line per entry, with the type first, so a link and a file
 * of the same name cannot pass for each other.
 */
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

export interface RemoteHome {
  home: string | undefined;
  sshOutput: string;
}

export type RemoteFolderState = 'missing' | 'empty' | 'taken';

/**
 * The command that tells whether the folder of the project is free on the
 * server: not there, there and empty, and there with something in it. It
 * answers one word, the two parts separated by a `|`. A folder the command
 * cannot read answers nothing, which is none of the three.
 */
export function remoteFolderStateCommand(path: string): string {
  const folder = shellQuote(path);

  return [
    `{ test -e ${folder} && echo there || echo missing; }`,
    `{ ls -A ${folder} 2>/dev/null | grep -q . && echo '|taken' || echo '|empty'; }`,
  ].join('; ');
}

/**
 * The state of the folder of the project on the server, read before anything
 * is copied: the import writes only into a folder it makes. Undefined when the
 * command did not answer, which the caller treats as a stop: a folder that
 * cannot be read is not a folder to write into.
 */
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

/** The path of a found entry without the `./` `find` puts in front of it. */
const STRIPPED_PATH = '$' + '{f#./}';

/**
 * The four fields of one entry for the fallback script, which runs where
 * `find` has no `-printf`: the type, the path, the size and the target, each
 * one ending with a NUL, exactly as the `-printf` command writes them. A path
 * with a tab or a newline is still one field, and no name can hold a NUL.
 */
const REMOTE_MANIFEST_FALLBACK = [
  'for f do',
  `if [ -L "$f" ]; then printf "l\\000%s\\000\\000%s\\000" "${STRIPPED_PATH}" "$(readlink "$f")";`,
  `elif [ -d "$f" ]; then printf "d\\000%s\\000\\000\\000" "${STRIPPED_PATH}";`,
  `elif [ -f "$f" ]; then printf "f\\000%s\\000%s\\000\\000" "${STRIPPED_PATH}" "$(wc -c < "$f" | tr -d " ")";`,
  'fi',
  'done',
].join(' ');

/**
 * The command of the remote manifest: every entry the folder holds, with its
 * type, its path and, for a file, its size or, for a link, its target. `.git`
 * is left out: the history is compared on its own, ref by ref. The folder of
 * an import is made by the import and written only by the archive, so there is
 * nothing here to leave out but the history.
 */
export function remoteManifestCommand(path: string, printf = true): string {
  const folder = shellQuote(path);
  const fallback = `find . -mindepth 1 -path ./.git -prune -o -exec sh -c '${REMOTE_MANIFEST_FALLBACK}' sh {} +`;

  if (!printf) {
    return `cd ${folder} || exit 1; ${fallback}`;
  }

  const primary = `find . -mindepth 1 -path ./.git -prune -o -printf '%y\\0%P\\0%s\\0%l\\0'`;

  return `cd ${folder} || exit 1; ${primary} 2>/dev/null || ${fallback}`;
}

/** The manifest of a remote folder, undefined when the command did not answer. */
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

/**
 * The fields of the remote command into a manifest: four per entry, a folder
 * saying `d`, a file `f` with its size, a link `l` with its target. The same
 * three lines the local side writes, so the hash of the two can be compared.
 */
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

/**
 * The paths that make two manifests differ, at most `limit` of them: what the
 * error of an import says when the copies do not match, so the cause is read
 * without going into either machine. Undefined when they match.
 */
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
