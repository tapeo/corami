import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readGitState } from '@/core/git.ts';
import { parsePeerHead } from '@/core/git-peers.ts';
import { peerFingerprint, readPeerHeads, syncPeers } from '@/core/git-peers-sync.ts';

interface Scene {
  origin: string;
  server: string;
  client: string;
}

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `corami-${prefix}-`));
  await git(root, ['init', '--quiet', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '--quiet', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout;
}

async function scene(): Promise<Scene> {
  const origin = await mkdtemp(join(tmpdir(), 'corami-origin-'));
  await git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);

  const seed = await repository('seed');
  await Bun.write(join(seed, 'app.ts'), 'first\n');
  await commit(seed, 'first');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '--quiet', 'origin', 'main']);

  const server = await mkdtemp(join(tmpdir(), 'corami-server-'));
  await git(server, ['clone', '--quiet', origin, '.']);
  await git(server, ['config', 'user.email', 'server@example.com']);
  await git(server, ['config', 'user.name', 'Server']);

  const client = await mkdtemp(join(tmpdir(), 'corami-client-'));
  await git(client, ['clone', '--quiet', origin, '.']);
  await git(client, ['config', 'user.email', 'client@example.com']);
  await git(client, ['config', 'user.name', 'Client']);

  return { origin, server, client };
}

function syncFiles(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (path) => !path.includes('/.git'),
  });
}

function copyPeerFiles(from: string, to: string): void {
  cpSync(join(from, '.git', 'corami'), join(to, '.git', 'corami'), { recursive: true });
}

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
    await syncPeers(client, { machine: 'tapeo' });

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
    const other = await mkdtemp(join(tmpdir(), 'corami-other-'));
    await git(other, ['clone', '--quiet', origin, '.']);
    await git(other, ['config', 'user.email', 'other@example.com']);
    await git(other, ['config', 'user.name', 'Other']);
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
});
