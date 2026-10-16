import { describe, expect, test } from 'bun:test';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@/core/exec.ts';
import {
  filesArrived,
  git,
  gitCompareAndSwap,
  gitFetchOrigin,
  gitHasCommit,
  gitUpstreamOf,
  giveCopyGit,
  isAncestor,
  readGitState,
  sshArgs,
} from '@/core/git.ts';
import {
  type GitRepoState,
  gitStateJson,
  notARepository,
  originRelation,
  parseGitState,
} from '@/core/git-align.ts';
import {
  describeOrigin,
  followOrigin,
  gitOriginState,
  originStatusJson,
} from '@/core/git-follow.ts';

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corami-git-'));
  await git(root, ['init', '--quiet', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', message]);
  const head = await git(root, ['rev-parse', 'HEAD']);
  return head.stdout;
}

// A bare `origin` and two clones, like the two sides of a project: the files
// between the two sides are carried by the sync, and in the tests we copy
// them by hand.
async function originAndClones(): Promise<{
  origin: string;
  server: string;
  client: string;
}> {
  const origin = await mkdtemp(join(tmpdir(), 'corami-origin-'));
  await git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);

  const seed = await repository();
  writeFileSync(join(seed, 'app.ts'), 'first\n');
  await commit(seed, 'first');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '--quiet', 'origin', 'main']);

  const server = await repository();
  const client = await repository();

  for (const root of [server, client]) {
    await git(root, ['remote', 'add', 'origin', origin]);
    await git(root, ['fetch', '--quiet', 'origin']);
    await git(root, ['reset', '--quiet', '--hard', 'origin/main']);
    await git(root, ['branch', '--set-upstream-to=origin/main', 'main']);
  }

  rmSync(seed, { recursive: true, force: true });

  return { origin, server, client };
}

async function pushFrom(root: string): Promise<string> {
  await git(root, ['push', '--quiet', 'origin', 'main']);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout;
}

// A commit on the side, like an agent or the IDE would do, and the push.
async function changeAndPush(root: string, content: string): Promise<string> {
  writeFileSync(join(root, 'app.ts'), content);
  await commit(root, content.trim());
  return pushFrom(root);
}

// The sync: the files of one side become those of the other.
function syncFiles(from: string, to: string): void {
  copyFileSync(join(from, 'app.ts'), join(to, 'app.ts'));
}

function state(overrides: Partial<GitRepoState> = {}): GitRepoState {
  return {
    ...notARepository(),
    commit: 'a'.repeat(40),
    branch: 'main',
    ...overrides,
  };
}

function relation(overrides: Partial<Parameters<typeof originRelation>[0]> = {}) {
  return originRelation({
    state: state(),
    upstream: 'origin/main',
    upstreamHere: true,
    aligned: false,
    headInUpstream: false,
    upstreamInHead: false,
    ...overrides,
  });
}

describe('originRelation', () => {
  test('is aligned on the same commit', () => {
    const result = relation({ aligned: true, headInUpstream: true, upstreamInHead: true });

    expect(result.status).toBe('aligned');
    expect(result.move).toBe(false);
  });

  test('moves a side that is behind', () => {
    const result = relation({ headInUpstream: true });

    expect(result.status).toBe('behind');
    expect(result.move).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('waits with work in stage', () => {
    const result = relation({ headInUpstream: true, state: state({ staged: true }) });

    expect(result.status).toBe('behind');
    expect(result.move).toBe(false);
    expect(result.reason).toBe('staged');
  });

  test('waits with an operation in progress', () => {
    const result = relation({ headInUpstream: true, state: state({ operation: 'rebase' }) });

    expect(result.move).toBe(false);
    expect(result.reason).toBe('rebase_in_progress');
  });

  test('reports commits to publish when ahead', () => {
    const result = relation({ upstreamInHead: true });

    expect(result.status).toBe('ahead');
    expect(result.move).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test('does nothing when the histories diverge', () => {
    const result = relation();

    expect(result.status).toBe('diverged');
    expect(result.move).toBe(false);
    expect(result.reason).toBe('history_diverged');
  });

  test('needs an upstream', () => {
    const result = relation({ upstream: undefined });

    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('no_upstream');
  });

  test('waits when the upstream commit is not here yet', () => {
    const result = relation({ upstreamHere: false });

    expect(result.status).toBe('behind');
    expect(result.move).toBe(false);
    expect(result.reason).toBe('upstream_not_here');
  });

  test('refuses a detached head and an empty repository', () => {
    expect(relation({ state: state({ branch: '' }) }).reason).toBe('detached_head');
    expect(relation({ state: notARepository() }).reason).toBe('not_a_repository');
  });
});

describe('git state json', () => {
  test('round trips through json', () => {
    const original = state({ operation: 'merge', staged: true, dirtyChanges: 2 });
    const parsed = parseGitState(gitStateJson(original));
    expect(parsed).toEqual(original);
  });

  test('rejects anything that is not an object', () => {
    expect(parseGitState('main')).toBeUndefined();
    expect(parseGitState(null)).toBeUndefined();
  });
});

describe('readGitState', () => {
  test('reports a repository without commits', async () => {
    const root = await repository();
    const result = await readGitState(root);
    expect(result.commit).toBe('');
    expect(result.branch).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('reports a folder that is not a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-git-'));
    expect(await readGitState(root)).toEqual(notARepository());
    rmSync(root, { recursive: true, force: true });
  });

  test('leaves untracked files out of the modified count', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    await commit(root, 'first');
    writeFileSync(join(root, 'new.ts'), 'untracked\n');

    const clean = await readGitState(root);
    expect(clean.dirtyChanges).toBe(0);
    expect(clean.staged).toBe(false);

    writeFileSync(join(root, 'app.ts'), 'edited\n');

    const edited = await readGitState(root);
    expect(edited.dirtyChanges).toBe(1);
    expect(edited.staged).toBe(false);

    await git(root, ['add', 'app.ts']);

    const staged = await readGitState(root);
    expect(staged.staged).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test('reports a detached head as an empty branch', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    await commit(root, 'first');
    await git(root, ['checkout', '--quiet', '--detach']);

    const detached = await readGitState(root);
    expect(detached.branch).toBe('');
    expect(detached.commit).not.toBe('');
    expect(await isAncestor(root, 'HEAD', 'HEAD')).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test('detects an interrupted rebase', async () => {
    const root = await repository();
    writeFileSync(join(root, 'base.ts'), 'base\n');
    await commit(root, 'first');
    await git(root, ['checkout', '--quiet', '-b', 'side']);
    writeFileSync(join(root, 'base.ts'), 'side\n');
    await commit(root, 'side');
    await git(root, ['checkout', '--quiet', 'main']);
    writeFileSync(join(root, 'base.ts'), 'main\n');
    await commit(root, 'main');
    const rebase = await run('git', ['-C', root, 'rebase', 'side']);
    expect(rebase.ok).toBe(false);

    expect((await readGitState(root)).operation).toBe('rebase');

    rmSync(root, { recursive: true, force: true });
  });
});

describe('git helpers on a real repository', () => {
  test('reads the ancestor relation both ways', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'app.ts'), 'second\n');
    const second = await commit(root, 'second');

    expect(await isAncestor(root, first, second)).toBe(true);
    expect(await isAncestor(root, second, first)).toBe(false);
    expect(await isAncestor(root, '', second)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('knows which commits are already here', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');

    expect(await gitHasCommit(root, first)).toBe(true);
    expect(await gitHasCommit(root, 'c'.repeat(40))).toBe(false);
    expect(await gitHasCommit(root, '')).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('moves a ref only when it still points where expected', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'app.ts'), 'second\n');
    const second = await commit(root, 'second');

    const stale = await gitCompareAndSwap(root, 'refs/heads/main', first, 'c'.repeat(40));
    expect(stale.ok).toBe(false);
    expect((await readGitState(root)).commit).toBe(second);

    const moved = await gitCompareAndSwap(root, 'refs/heads/main', first, second);
    expect(moved.ok).toBe(true);
    expect((await readGitState(root)).commit).toBe(first);
    // The reset is mixed: the files did not change.
    expect(await Bun.file(join(root, 'app.ts')).text()).toBe('second\n');

    rmSync(root, { recursive: true, force: true });
  });

  test('builds the ssh command with a timeout', () => {
    expect(sshArgs(10_000)).toEqual([
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10',
    ]);
    expect(sshArgs(10)[1]).toContain('ConnectTimeout=1');
  });

  test('reads the upstream of a branch', async () => {
    const { server } = await originAndClones();

    expect(await gitUpstreamOf(server, 'main')).toBe('origin/main');
    expect(await gitUpstreamOf(server, '')).toBeUndefined();
    expect(await gitUpstreamOf(server, 'other')).toBeUndefined();

    rmSync(server, { recursive: true, force: true });
  });

  test('reaches origin and updates the remote-tracking ref', async () => {
    const { origin, server, client } = await originAndClones();
    const second = await changeAndPush(server, 'second\n');

    expect((await gitFetchOrigin(client)).ok).toBe(true);
    expect((await readGitState(client)).commit).not.toBe(second);
    expect((await git(client, ['rev-parse', 'origin/main'])).stdout).toBe(second);

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });
});

describe('filesArrived', () => {
  test('true when the changed file is already the new one', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'app.ts'), 'second\n');
    const second = await commit(root, 'second');

    expect(await filesArrived(root, first, second)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test('false when the file is still the old one', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'app.ts'), 'second\n');
    const second = await commit(root, 'second');
    await git(root, ['reset', '--quiet', '--hard', first]);

    expect(await filesArrived(root, first, second)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('sees a file that was edited further after the commit', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'app.ts'), 'second\n');
    const second = await commit(root, 'second');
    // The agent keeps working: the file is not the one of the commit, but the
    // changes of the commit arrived anyway.
    writeFileSync(join(root, 'app.ts'), 'third\n');

    expect(await filesArrived(root, first, second)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test('handles additions, deletions and paths with spaces', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');
    writeFileSync(join(root, 'new file.ts'), 'new\n');
    const second = await commit(root, 'second');

    expect(await filesArrived(root, first, second)).toBe(true);

    await git(root, ['rm', '--quiet', 'app.ts']);
    const third = await commit(root, 'third');

    expect(await filesArrived(root, second, third)).toBe(true);

    // The deleted file is back: the changes did not arrive.
    writeFileSync(join(root, 'app.ts'), 'first\n');

    expect(await filesArrived(root, second, third)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('false with an empty commit on either side', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    const first = await commit(root, 'first');

    expect(await filesArrived(root, '', first)).toBe(false);
    expect(await filesArrived(root, first, '')).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('followOrigin', () => {
  test('moves the side that is behind once the files are here', async () => {
    const { origin, server, client } = await originAndClones();
    const second = await changeAndPush(server, 'second\n');

    // The files are not here yet: it waits without moving the HEAD.
    const waiting = await followOrigin(client);

    expect(waiting.status).toBe('behind');
    expect(waiting.reason).toBe('waiting_for_files');
    expect(waiting.move).toBe(false);
    expect((await readGitState(client)).commit).not.toBe(second);

    // The sync arrives, and the next cycle moves.
    syncFiles(server, client);
    const aligned = await followOrigin(client);

    expect(aligned.status).toBe('aligned');
    expect(aligned.move).toBe(false);
    expect((await readGitState(client)).commit).toBe(second);
    // The reset is mixed and the files stay the ones delivered by the sync.
    expect(await Bun.file(join(client, 'app.ts')).text()).toBe('second\n');

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('does nothing when there are commits to publish', async () => {
    const { origin, server, client } = await originAndClones();
    writeFileSync(join(client, 'app.ts'), 'client\n');
    const ahead = await commit(client, 'client');

    const status = await followOrigin(client);

    expect(status.status).toBe('ahead');
    expect(status.move).toBe(false);
    expect((await readGitState(client)).commit).toBe(ahead);
    expect((await readGitState(server)).commit).not.toBe(ahead);

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('does nothing when the histories diverge', async () => {
    const { origin, server, client } = await originAndClones();
    await changeAndPush(server, 'server\n');
    writeFileSync(join(client, 'app.ts'), 'client\n');
    await commit(client, 'client');
    syncFiles(server, client);

    const status = await followOrigin(client);

    expect(status.status).toBe('diverged');
    expect(status.reason).toBe('history_diverged');
    expect(status.move).toBe(false);

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('waits with work in stage', async () => {
    const { origin, server, client } = await originAndClones();
    const second = await changeAndPush(server, 'second\n');
    syncFiles(server, client);
    writeFileSync(join(client, 'other.ts'), 'work\n');
    await git(client, ['add', 'other.ts']);

    const status = await followOrigin(client);

    expect(status.move).toBe(false);
    expect(status.reason).toBe('staged');
    expect((await readGitState(client)).commit).not.toBe(second);

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('does not cross a commit that lands while it moves', async () => {
    const { origin, server, client } = await originAndClones();
    const second = await changeAndPush(server, 'second\n');
    syncFiles(server, client);

    // The compare-and-swap: with a commit newer than the expected one nothing
    // happens.
    writeFileSync(join(client, 'client.ts'), 'client\n');
    const clientCommit = await commit(client, 'client');
    const stale = await gitCompareAndSwap(client, 'refs/heads/main', second, 'c'.repeat(40));

    expect(stale.ok).toBe(false);
    expect((await readGitState(client)).commit).toBe(clientCommit);

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('reports a repository without origin', async () => {
    const root = await repository();
    writeFileSync(join(root, 'app.ts'), 'first\n');
    await commit(root, 'first');

    const status = await followOrigin(root);

    expect(status.status).toBe('unknown');
    expect(status.reason).toBe('no_upstream');
    expect(status.fetched).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('keeps going with a stale ref when origin is unreachable', async () => {
    const { origin, server, client } = await originAndClones();
    rmSync(origin, { recursive: true, force: true });

    const status = await followOrigin(client);

    expect(status.fetched).toBe(false);
    expect(status.status).toBe('aligned');

    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });

  test('reads the state without network and describes it', async () => {
    const { origin, server, client } = await originAndClones();

    const state = await gitOriginState(client);
    expect(state.status).toBe('aligned');
    expect(state.fetched).toBe(false);
    expect(describeOrigin(state)).toBe('aligned with origin');
    expect(originStatusJson(state).status).toBe('aligned');

    writeFileSync(join(client, 'client.ts'), 'client\n');
    await commit(client, 'client');

    expect(describeOrigin(await gitOriginState(client))).toBe('commits to publish (push)');

    rmSync(origin, { recursive: true, force: true });
    rmSync(server, { recursive: true, force: true });
    rmSync(client, { recursive: true, force: true });
  });
});

describe('giveCopyGit', () => {
  test('gives a synced copy the .git of origin on the branch of the server', async () => {
    const { origin, server, client } = await originAndClones();
    await git(server, ['checkout', '--quiet', '-b', 'feature']);
    writeFileSync(join(server, 'app.ts'), 'feature\n');
    await commit(server, 'feature');
    await git(server, ['push', '--quiet', '-u', 'origin', 'feature']);
    writeFileSync(join(server, 'app.ts'), 'work in progress\n');

    const copy = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    syncFiles(server, copy);

    const result = await giveCopyGit({ local: copy, originUrl: origin, branch: 'feature' });
    expect(result.status).toBe('done');

    const state = await readGitState(copy);
    expect(state.branch).toBe('feature');
    expect(state.commit).toBe((await git(server, ['rev-parse', 'HEAD'])).stdout);
    expect(state.dirtyChanges).toBe(1);
    expect(state.staged).toBe(false);
    expect(await gitUpstreamOf(copy, 'feature')).toBe('origin/feature');

    const again = await giveCopyGit({ local: copy, originUrl: origin, branch: 'feature' });
    expect(again.status).toBe('skipped');

    for (const path of [origin, server, client, copy]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('stays on the default branch when the branch of the server is not on origin', async () => {
    const { origin, server, client } = await originAndClones();
    const copy = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    syncFiles(server, copy);

    const result = await giveCopyGit({ local: copy, originUrl: origin, branch: 'local-only' });
    expect(result.status).toBe('done');
    expect(result.detail).toContain('local-only');
    expect((await readGitState(copy)).branch).toBe('main');

    for (const path of [origin, server, client, copy]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('reports a clone that fails and leaves the copy as it was', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    const missing = join(copy, 'no-such-origin');

    const result = await giveCopyGit({ local: copy, originUrl: missing, branch: 'main' });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('git clone --no-checkout');
    expect(await readGitState(copy)).toEqual(notARepository());

    const none = await giveCopyGit({ local: copy, originUrl: undefined, branch: 'main' });
    expect(none.status).toBe('skipped');

    rmSync(copy, { recursive: true, force: true });
  });
});
