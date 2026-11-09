import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { git, readGitState } from '@/core/git.ts';
import { originTipAction } from '@/core/git-follow.ts';
import { originTipJson, parseOriginTip, parsePeerHead } from '@/core/git-peers.ts';
import {
  peerFingerprint,
  publishOriginTip,
  readPeerHeads,
  syncPeers,
} from '@/core/git-peers-sync.ts';

import { cloneAs, commit, copyPeerFiles, copyPeerHeads, scene, syncFiles } from './git-scene.ts';

function ownHead(root: string, machine: string) {
  const text = readFileSync(join(root, '.git', 'corami', `${machine}.json`), 'utf8');
  return parsePeerHead(JSON.parse(text));
}

describe('peer exchange', () => {
  test('publishes the commits origin does not have', async () => {
    const { server } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    const result = await syncPeers(server, { machine: 'hearth-vps' });

    expect(result.peers).toEqual([]);
    expect(ownHead(server, 'hearth-vps')).toEqual({
      machine: 'hearth-vps',
      branch: 'main',
      commit: head,
      branchEpoch: 0,
    });
    expect(existsSync(join(server, '.git', 'corami', 'hearth-vps.bundle'))).toBe(true);
  });

  test('drops the bundle once origin has the commit', async () => {
    const { server } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    await git(server, ['push', '--quiet', 'origin', 'main']);
    await git(server, ['fetch', '--quiet', 'origin']);
    await syncPeers(server, { machine: 'hearth-vps' });

    expect(existsSync(join(server, '.git', 'corami', 'hearth-vps.bundle'))).toBe(false);
  });

  test('moves the head of the client to an unpushed commit of the server', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);
    await syncPeers(client, { machine: 'tapeo' });

    expect((await readGitState(client)).commit).toBe(head);
    expect(ownHead(client, 'tapeo')?.commit).toBe(head);
  });

  test('moves the head of the server to an unpushed commit of the client', async () => {
    const { server, client } = await scene();
    await Bun.write(join(client, 'c1.ts'), 'c1\n');
    const head = await commit(client, 'c1');

    await syncPeers(client, { machine: 'tapeo' });
    syncFiles(client, server);
    copyPeerFiles(client, server);
    await syncPeers(server, { machine: 'hearth-vps' });

    expect((await readGitState(server)).commit).toBe(head);
  });

  test('waits when the files of the commit are not here', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    copyPeerFiles(server, client);
    const before = (await readGitState(client)).commit;
    const result = await syncPeers(client, { machine: 'tapeo' });

    expect(result.pending).toBe(true);
    expect((await readGitState(client)).commit).toBe(before);
    expect(head).not.toBe(before);
  });

  test('leaves two diverged sides alone', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');
    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);

    await Bun.write(join(client, 'c1.ts'), 'c1\n');
    const clientHead = await commit(client, 'c1');
    await syncPeers(client, { machine: 'tapeo' });
    copyPeerFiles(server, client);
    await syncPeers(client, { machine: 'tapeo' });

    expect((await readGitState(client)).commit).toBe(clientHead);
    expect((await readGitState(client)).branch).toBe('main');
  });

  test('follows the branch of the other side', async () => {
    const { server, client } = await scene();
    await git(server, ['switch', '--quiet', '-c', 'feat/x']);
    await Bun.write(join(server, 'x.ts'), 'x\n');
    const head = await commit(server, 'x');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);
    await syncPeers(client, { machine: 'tapeo' });

    const state = await readGitState(client);
    expect(state.branch).toBe('feat/x');
    expect(state.commit).toBe(head);
  });

  test('keeps the epoch and raises it only for a switch made by hand', async () => {
    const { server, client } = await scene();
    await git(server, ['switch', '--quiet', '-c', 'feat/x']);
    await commit(server, 'x');
    await syncPeers(server, { machine: 'hearth-vps' });
    await git(server, ['switch', '--quiet', '-c', 'feat/y']);
    await commit(server, 'y');
    await syncPeers(server, { machine: 'hearth-vps' });

    expect(ownHead(server, 'hearth-vps')?.branchEpoch).toBe(1);

    syncFiles(server, client);
    copyPeerFiles(server, client);
    await syncPeers(client, { machine: 'tapeo' });

    expect(ownHead(client, 'tapeo')?.branch).toBe('feat/y');
    expect(ownHead(client, 'tapeo')?.branchEpoch).toBe(1);

    await git(client, ['switch', '--quiet', '-c', 'mine']);
    await commit(client, 'mine');
    await syncPeers(client, { machine: 'tapeo' });

    expect(ownHead(client, 'tapeo')?.branch).toBe('mine');
    expect(ownHead(client, 'tapeo')?.branchEpoch).toBe(2);
  });

  test('changes the fingerprint when the branch moves', async () => {
    const { server } = await scene();
    const before = peerFingerprint(server);
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');

    expect(peerFingerprint(server)).not.toBe(before);
  });

  test('reads the heads of the other machines', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');
    await syncPeers(server, { machine: 'hearth-vps' });
    copyPeerFiles(server, client);

    const heads = readPeerHeads(join(client, '.git'));

    expect(heads.map((entry) => entry.machine)).toEqual(['hearth-vps']);
  });

  test('does nothing when the other origin moved and the base is missing', async () => {
    const { origin, server, client } = await scene();
    const other = await cloneAs(origin, 'other');
    await Bun.write(join(other, 'o1.ts'), 'o1\n');
    await commit(other, 'o1');
    await git(other, ['push', '--quiet', 'origin', 'main']);

    await git(server, ['fetch', '--quiet', 'origin']);
    await git(server, ['merge', '--quiet', '--ff-only', 'origin/main']);
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');
    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);

    const before = (await readGitState(client)).commit;
    await syncPeers(client, { machine: 'tapeo' });

    expect((await readGitState(client)).commit).toBe(before);
  });

  test('reports a peer commit whose bundle has not arrived', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    const head = await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerHeads(server, client);

    const before = (await readGitState(client)).commit;
    const result = await syncPeers(client, { machine: 'tapeo' });

    expect(result.missing.map((entry) => entry.commit)).toEqual([head]);
    expect((await readGitState(client)).commit).toBe(before);
  });

  test('reports no gap when the bundle carries the commit', async () => {
    const { server, client } = await scene();
    await Bun.write(join(server, 's1.ts'), 's1\n');
    await commit(server, 's1');

    await syncPeers(server, { machine: 'hearth-vps' });
    syncFiles(server, client);
    copyPeerFiles(server, client);

    const result = await syncPeers(client, { machine: 'tapeo' });

    expect(result.missing).toEqual([]);
  });
});

describe('origin tip', () => {
  test('parses and writes the published tip', () => {
    const tip = { branch: 'main', commit: 'c'.repeat(40), fetchedAt: '2026-11-09T09:49:04.000Z' };

    expect(parseOriginTip(originTipJson(tip))).toEqual(tip);
    expect(parseOriginTip({ branch: 'main', commit: 'c'.repeat(40) })).toEqual({
      branch: 'main',
      commit: 'c'.repeat(40),
      fetchedAt: '',
    });
    expect(parseOriginTip({ branch: '', commit: 'c'.repeat(40) })).toBeUndefined();
    expect(parseOriginTip({ branch: 'main' })).toBeUndefined();
    expect(parseOriginTip(null)).toBeUndefined();
  });

  test('the published tip decides between none, update and fetch', () => {
    const tip = { branch: 'main', commit: 'c'.repeat(40), fetchedAt: '' };

    expect(originTipAction(undefined, undefined, false)).toBe('none');
    expect(originTipAction('c'.repeat(40), tip, true)).toBe('none');
    expect(originTipAction('d'.repeat(40), tip, true)).toBe('update_ref');
    expect(originTipAction(undefined, tip, false)).toBe('fetch');
    expect(originTipAction('d'.repeat(40), tip, false)).toBe('fetch');
  });

  test('publishing the same tip again leaves the file alone', async () => {
    const { server } = await scene();
    const file = join(server, '.git', 'corami', 'origin.json');

    await publishOriginTip(server, 'main', 'c'.repeat(40));
    const first = readFileSync(file, 'utf8');
    await publishOriginTip(server, 'main', 'c'.repeat(40));

    expect(readFileSync(file, 'utf8')).toBe(first);
  });
});
