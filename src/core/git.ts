import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactUrl, run, shellQuote } from '@/core/exec.ts';
import { type GitRepoState, notARepository } from '@/core/git-align.ts';

export async function git(
  root: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await run('git', ['-C', root, ...args], {
    timeoutMs: options.timeoutMs ?? 300_000,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { ok: result.ok, stdout: result.stdout.trimEnd(), stderr: result.stderr.trim() };
}

async function gitStep(
  root: string,
  args: string[],
  fallback: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; detail: string }> {
  const result = await git(root, args, timeoutMs === undefined ? {} : { timeoutMs });
  return { ok: result.ok, detail: result.ok ? '' : failureDetail(result.stderr, fallback) };
}

export function hasGitRepository(root: string): boolean {
  const entry = join(root, '.git');

  if (!existsSync(entry)) {
    return false;
  }

  if (statSync(entry).isFile()) {
    return true;
  }

  return existsSync(join(entry, 'HEAD'));
}

export async function gitDir(root: string): Promise<string | undefined> {
  const result = await git(root, ['rev-parse', '--path-format=absolute', '--git-dir']);
  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

export async function readGitState(root: string): Promise<GitRepoState> {
  const status = await git(root, ['status', '--porcelain=v2', '--branch']);

  if (!status.ok) {
    return notARepository();
  }

  let commit = '';
  let branch = '';
  let staged = false;
  let dirtyChanges = 0;

  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length);
      branch = name === '(detached)' ? '' : name;
      continue;
    }

    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      commit = oid === '(initial)' ? '' : oid;
      continue;
    }

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      dirtyChanges += 1;

      if (line.charAt(2) !== '.') {
        staged = true;
      }
    }
  }

  if (commit === '') {
    return notARepository();
  }

  return { commit, branch, operation: await detectOperation(root), staged, dirtyChanges };
}

export async function detectOperation(root: string): Promise<string | undefined> {
  const dir = await gitDir(root);

  if (dir === undefined) {
    return undefined;
  }

  const candidates: Array<[string, string]> = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];

  for (const [file, name] of candidates) {
    if (existsSync(join(dir, file))) {
      return name;
    }
  }

  return undefined;
}

export async function gitHasCommit(root: string, commit: string): Promise<boolean> {
  return commit !== '' && (await git(root, ['cat-file', '-e', `${commit}^{commit}`])).ok;
}

export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === '' || descendant === '') {
    return false;
  }

  return (await git(root, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
}

export async function gitCompareAndSwap(
  root: string,
  ref: string,
  value: string,
  expected: string,
): Promise<{ ok: boolean; detail: string }> {
  const update = await gitStep(
    root,
    ['update-ref', ref, value, expected],
    'ref is not what was expected',
  );

  return update.ok ? gitStep(root, ['reset', '--quiet', ref], 'git reset failed') : update;
}

export async function gitBundleCreate(
  root: string,
  file: string,
  branch: string,
): Promise<{ ok: boolean; detail: string }> {
  return gitStep(
    root,
    ['bundle', 'create', file, branch, '--not', '--remotes=origin'],
    'git bundle create failed',
  );
}

export interface BundleFetch {
  ok: boolean;
  detail: string;
  missingBase: boolean;
}

export async function gitBundleFetch(
  root: string,
  file: string,
  branch: string,
  timeoutMs = 60_000,
): Promise<BundleFetch> {
  const result = await git(root, ['fetch', '--quiet', file, branch], { timeoutMs });
  const detail = result.ok ? '' : failureDetail(result.stderr, 'git fetch from the bundle failed');

  return {
    ok: result.ok,
    detail,
    missingBase: /prerequisite commits/i.test(result.stderr),
  };
}

export async function gitSwitchTo(
  root: string,
  branch: string,
  commit: string,
  expected: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const update =
    expected === undefined
      ? await gitStep(
          root,
          ['update-ref', `refs/heads/${branch}`, commit, ''],
          'ref already exists',
        )
      : await gitStep(
          root,
          ['update-ref', `refs/heads/${branch}`, commit, expected],
          'ref is not what was expected',
        );

  if (!update.ok) {
    return update;
  }

  const moved = await gitStep(
    root,
    ['symbolic-ref', 'HEAD', `refs/heads/${branch}`],
    'cannot move HEAD',
  );

  return moved.ok ? gitStep(root, ['reset', '--quiet'], 'git reset failed') : moved;
}

export async function gitSetUpstream(root: string, branch: string): Promise<void> {
  await git(root, ['branch', '--quiet', '--set-upstream-to', `origin/${branch}`, branch]);
}

export function sshArgs(timeoutMs = 60_000): string[] {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return ['-c', `core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=${seconds}`];
}

const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

export async function gitFetchOrigin(
  root: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; detail: string }> {
  const result = await git(root, [...sshArgs(timeoutMs), 'fetch', '--quiet', 'origin'], {
    timeoutMs,
    env: NO_PROMPT,
  });

  return {
    ok: result.ok,
    detail: result.ok ? '' : failureDetail(result.stderr, 'git fetch failed'),
  };
}

export async function gitOriginUrl(root: string): Promise<string | undefined> {
  const result = await git(root, ['remote', 'get-url', 'origin']);
  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

export interface CopyGitResult {
  status: 'done' | 'skipped' | 'failed';
  summary: string;
  detail?: string | undefined;
}

export interface GitProgress {
  phase: string;
  done?: number | undefined;
  total?: number | undefined;
}

const GIT_PROGRESS =
  /^(?:remote: )?((?:[A-Z][A-Za-z ]*?(?:objects|deltas|files))|Total)\s*:\s*(?:(\d+)%\s*)?(?:\((\d+)\/(\d+)\))?/;

export function parseGitProgress(line: string): GitProgress | undefined {
  const match = GIT_PROGRESS.exec(line.trim());

  if (match === null) {
    return undefined;
  }

  const phase = match[1] ?? '';
  const done = match[3] === undefined ? undefined : Number(match[3]);
  const total = match[4] === undefined ? undefined : Number(match[4]);

  if (done === undefined || total === undefined) {
    return { phase };
  }

  return { phase, done, total };
}

function progressLines(onProgress: (progress: GitProgress) => void): (chunk: string) => void {
  let rest = '';

  return (chunk) => {
    const parts = `${rest}${chunk}`.split(/[\r\n]/);
    rest = parts.pop() ?? '';

    for (const part of parts) {
      const progress = parseGitProgress(part);

      if (progress !== undefined) {
        onProgress(progress);
      }
    }
  };
}

export async function giveCopyGit(options: {
  local: string;
  originUrl: string | undefined;
  branch: string;
  timeoutMs?: number;
  onProgress?: (progress: GitProgress) => void;
}): Promise<CopyGitResult> {
  const { local, originUrl, branch, onProgress } = options;

  if (hasGitRepository(local)) {
    return { status: 'skipped', summary: 'The local copy already has its .git' };
  }

  if (originUrl === undefined) {
    return {
      status: 'skipped',
      summary: 'No origin for the project on the server: the local copy stays without .git',
    };
  }

  const timeoutMs = options.timeoutMs ?? 1_800_000;
  const temporary = `${local}.corami-git-${process.pid}`;
  const where = redactUrl(originUrl);
  const manual = `git clone --no-checkout ${shellQuote(where)} ${shellQuote(temporary)} && mv ${shellQuote(`${temporary}/.git`)} ${shellQuote(`${local}/`)} && git -C ${shellQuote(local)} reset`;

  rmSync(temporary, { recursive: true, force: true });

  const cloned = await run(
    'git',
    [...sshArgs(60_000), 'clone', '--progress', '--no-checkout', '--', originUrl, temporary],
    {
      timeoutMs,
      env: { ...NO_PROMPT, LC_ALL: 'C' },
      ...(onProgress === undefined ? {} : { onStderr: progressLines(onProgress) }),
    },
  );

  if (!cloned.ok) {
    rmSync(temporary, { recursive: true, force: true });
    return {
      status: 'failed',
      summary: `Could not clone ${where} on this machine`,
      detail: `${failureDetail(cloned.stderr, 'git clone failed')}. Check the git credentials of this machine, then: ${manual}`,
    };
  }

  mkdirSync(local, { recursive: true });
  renameSync(join(temporary, '.git'), join(local, '.git'));
  rmSync(temporary, { recursive: true, force: true });

  const current = (await git(local, ['symbolic-ref', '--short', 'HEAD'])).stdout;
  let note: string | undefined;

  if (branch !== '' && branch !== current) {
    const remote = await gitRefCommit(local, `refs/remotes/origin/${branch}`);

    if (remote === undefined) {
      note = `Branch ${branch} of the server is not on origin: the copy stays on ${current}`;
    } else {
      await git(local, ['branch', '--quiet', '--track', branch, `origin/${branch}`]);
      await git(local, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    }
  }

  await git(local, ['reset', '--quiet']);
  const head = (await git(local, ['symbolic-ref', '--short', 'HEAD'])).stdout;

  return {
    status: 'done',
    summary: `Git repository of origin on branch ${head}`,
    detail: note,
  };
}

export async function gitUpstreamOf(root: string, branch: string): Promise<string | undefined> {
  if (branch === '') {
    return undefined;
  }

  const result = await git(root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${branch}@{upstream}`,
  ]);

  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

export async function gitRefCommit(root: string, ref: string): Promise<string | undefined> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', ref]);
  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

interface ChangedEntry {
  status: string;
  path: string;
}

async function changedEntries(
  root: string,
  from: string,
  to: string,
): Promise<ChangedEntry[] | undefined> {
  const result = await git(root, ['diff', '--name-status', '--no-renames', '-z', from, to]);

  if (!result.ok) {
    return undefined;
  }

  const parts = result.stdout.split('\0').filter((part) => part !== '');
  const entries: ChangedEntry[] = [];

  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index] ?? '';
    const path = parts[index + 1] ?? '';

    if (status !== '' && path !== '') {
      entries.push({ status: status.charAt(0), path });
    }
  }

  return entries;
}

async function treeHashes(
  root: string,
  commit: string,
  paths: string[],
): Promise<Map<string, string> | undefined> {
  const result = await git(root, ['ls-tree', '-z', commit, '--', ...paths]);

  if (!result.ok) {
    return undefined;
  }

  const hashes = new Map<string, string>();

  for (const record of result.stdout.split('\0')) {
    if (record === '') {
      continue;
    }

    const [meta, path] = record.split('\t');

    if (path === undefined || meta === undefined) {
      continue;
    }

    const hash = meta.split(' ')[2];
    hashes.set(path, hash ?? ':');
  }

  return hashes;
}

async function worktreeHashes(
  root: string,
  paths: string[],
): Promise<Map<string, string> | undefined> {
  const script = [
    'root=$1',
    'shift',
    'for path in "$@"; do',
    '  hash=$(git -C "$root" hash-object -- "$path" 2>/dev/null) || hash=-',
    '  printf "%s\\n" "$hash"',
    'done',
  ].join('\n');
  const result = await run('sh', ['-c', script, 'corami', root, ...paths]);

  if (!result.ok) {
    return undefined;
  }

  const lines = result.stdout.split('\n');
  const hashes = new Map<string, string>();

  paths.forEach((path, index) => {
    const line = lines[index];
    hashes.set(path, line === undefined || line.trim() === '' ? '-' : line.trim());
  });

  return hashes;
}

export async function filesArrived(root: string, from: string, to: string): Promise<boolean> {
  if (from === '' || to === '') {
    return false;
  }

  const entries = await changedEntries(root, from, to);

  if (entries === undefined) {
    return false;
  }

  if (entries.length === 0) {
    return true;
  }

  const paths = entries.map((entry) => entry.path);
  const [before, now] = await Promise.all([
    treeHashes(root, from, paths),
    worktreeHashes(root, paths),
  ]);

  if (before === undefined || now === undefined) {
    return false;
  }

  return entries.every((entry) => arrived(entry, before, now));
}

function arrived(
  entry: ChangedEntry,
  before: Map<string, string>,
  now: Map<string, string>,
): boolean {
  const previous = before.get(entry.path) ?? ':';
  const current = now.get(entry.path) ?? '-';

  if (entry.status === 'A') {
    return current !== '-';
  }

  if (entry.status === 'D') {
    return current === '-';
  }

  return previous !== current;
}

function failureDetail(stderr: string, fallback: string): string {
  const lines = stderr
    .split(/[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && parseGitProgress(line) === undefined);

  return lines.slice(0, 3).join(' ') || fallback;
}
