// Git commands and the state of one side. Every side follows `origin` only: the
// files are always moved by the sync, here we read states and move the local HEAD.

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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

async function gitDir(root: string): Promise<string | undefined> {
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
    // `# branch.head (detached)` means a detached HEAD: branch stays empty.
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

    // An untracked file (`?`) does not count. In `1`/`2`/`u` the first character
    // is about the index, the second the worktree.
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

// Updates a ref only if it still equals `expected`, then moves the index with a
// mixed reset: the files stay the ones from the sync.
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

// The ssh command for git commands towards `origin`, with a timeout: when the
// service starts the network may not be ready yet, and we do not hang.
export function sshArgs(timeoutMs = 60_000): string[] {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return ['-c', `core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=${seconds}`];
}

// Nobody watches the terminal: a `fetch` must never ask for credentials.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

// Downloads the refs of `origin`. Without network it fails, and the caller
// decides with the refs of the last successful fetch.
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

// Gives a local copy born from the sync its own `.git`: a clone of `origin`
// without checkout, moved into the copy, on the branch of the server. The
// files are the synced ones: `git reset` only rebuilds the index from HEAD.
export async function giveCopyGit(options: {
  local: string;
  originUrl: string | undefined;
  branch: string;
  timeoutMs?: number;
}): Promise<CopyGitResult> {
  const { local, originUrl, branch } = options;

  if (existsSync(join(local, '.git'))) {
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
    [...sshArgs(60_000), 'clone', '--quiet', '--no-checkout', '--', originUrl, temporary],
    { timeoutMs, env: NO_PROMPT },
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

// The branch that follows `origin`, in the form `origin/<branch>`. Without a
// configured upstream there is no destination, and the caller says so.
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

// The files changed between two commits. `--no-renames` and `-z` give simple
// paths to read even with spaces or odd characters.
async function changedPaths(root: string, from: string, to: string): Promise<string[] | undefined> {
  const result = await git(root, ['diff', '--name-only', '--no-renames', '-z', from, to]);

  if (!result.ok) {
    return undefined;
  }

  return result.stdout.split('\0').filter((path) => path !== '');
}

// The hash of every path in the commit, `:` for a file that is not there.
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

// The hash of the file on disk, `-` when it is missing. One missing file would
// make a single `hash-object` fail, so every path is asked on its own.
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

// Are the changes of commit `to` already in the files? For every path changed
// between `from` and `to` the disk must differ from what it was in `from`: a new
// file must be there, a deleted one must be gone. That way a file the agent
// modified again after the commit does not block, while a commit that arrived
// from outside and was not delivered by the sync yet does block.
export async function filesArrived(root: string, from: string, to: string): Promise<boolean> {
  if (from === '' || to === '') {
    return false;
  }

  const paths = await changedPaths(root, from, to);

  if (paths === undefined) {
    return false;
  }

  if (paths.length === 0) {
    return true;
  }

  const [before, now] = await Promise.all([
    treeHashes(root, from, paths),
    worktreeHashes(root, paths),
  ]);

  if (before === undefined || now === undefined) {
    return false;
  }

  return paths.every((path) => (before.get(path) ?? ':') !== (now.get(path) ?? '-'));
}

// The first stderr lines on a single line: in a rejected fetch or push the
// first line is the remote address, and the reason is in the ones after.
function failureDetail(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  return lines.slice(0, 3).join(' ') || fallback;
}
