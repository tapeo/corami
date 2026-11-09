import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { git, gitRefCommit, readGitState } from '@/core/git.ts';
import { publishOriginTip, syncPeers } from '@/core/git-peers-sync.ts';
import { nextPendingUntil, peerTurnDue, type WatchEvent, watchProjects } from '@/core/git-watch.ts';

import { commit, copyPeerFiles, removeScene, scene, syncFiles } from './git-scene.ts';

async function runWatch(root: string, machine: string): Promise<WatchEvent[]> {
  const abort = new AbortController();
  const events: WatchEvent[] = [];
  const timer = setTimeout(() => abort.abort(), 300);

  await watchProjects({
    machine,
    pollsOrigin: false,
    roots: async () => [{ project: 'demo', root }],
    signal: abort.signal,
    onEvent: (event) => events.push(event),
  });

  clearTimeout(timer);

  return events;
}

describe('peer turn', () => {
  const idle = { fingerprint: 'f1', pendingUntil: 0 };

  test('skips a project whose fingerprint did not change', () => {
    expect(peerTurnDue(idle, 'f1', 5_000)).toBe(false);
  });

  test('runs on a new fingerprint or a pending move', () => {
    expect(peerTurnDue(idle, 'f2', 5_000)).toBe(true);
    expect(peerTurnDue({ ...idle, pendingUntil: 6_000 }, 'f1', 5_000)).toBe(true);
  });
});

describe('pending move', () => {
  test('a move that waits for the files is retried for a minute', () => {
    expect(nextPendingUntil(0, true, false, 1_000)).toBe(61_000);
    expect(nextPendingUntil(61_000, true, false, 30_000)).toBe(61_000);
  });

  test('after the minute only a new fingerprint brings the fast retry back', () => {
    expect(nextPendingUntil(61_000, true, false, 90_000)).toBe(61_000);
    expect(nextPendingUntil(61_000, true, true, 90_000)).toBe(150_000);
  });

  test('a move that no longer waits clears the retry', () => {
    expect(nextPendingUntil(61_000, false, false, 30_000)).toBe(0);
  });
});

describe('watch cycle', () => {
  test('moves to an unpushed commit of the other machine', async () => {
    const paths = await scene();
    const { server, client } = paths;
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);

    const events = await runWatch(client, 'tapeo');

    expect((await readGitState(client)).commit).toBe(head);
    expect(events.some((event) => event.kind === 'move')).toBe(true);

    removeScene(paths);
  });

  test('takes the published tip of origin without a fetch', async () => {
    const paths = await scene();
    const { server, client } = paths;
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);
    await syncPeers(client, { machine: 'tapeo' });
    await git(server, ['push', '--quiet', 'origin', 'main']);
    await publishOriginTip(server, 'main', head);
    copyPeerFiles(server, client);

    await runWatch(client, 'tapeo');

    expect(await gitRefCommit(client, 'refs/remotes/origin/main')).toBe(head);

    removeScene(paths);
  });
});
