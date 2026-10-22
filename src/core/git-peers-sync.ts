import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  filesArrived,
  git,
  gitBundleCreate,
  gitBundleFetch,
  gitCompareAndSwap,
  gitDir,
  gitHasCommit,
  gitRefCommit,
  gitSetUpstream,
  gitSwitchTo,
  isAncestor,
  readGitState,
} from '@/core/git.ts';
import { type GitRepoState, isUsable } from '@/core/git-align.ts';
import {
  branchFollow,
  branchWinner,
  furthestTip,
  nextBranchEpoch,
  PEERS_DIR,
  type PeerHead,
  parsePeerHead,
  peerBundleFile,
  peerHeadFile,
  peerHeadJson,
  publishNeeded,
  type RefPosition,
  type TipInput,
} from '@/core/git-peers.ts';

export interface PeerSyncOptions {
  machine: string;
  timeoutMs?: number;
}

export interface PeerMove {
  from: string;
  to: string;
  source: string;
}

export interface PeerSwitch {
  from: string;
  to: string;
  commit: string;
  epoch: number;
}

export interface PeerSyncResult {
  peers: PeerHead[];
  moved: PeerMove | undefined;
  switched: PeerSwitch | undefined;
}

export async function syncPeers(root: string, options: PeerSyncOptions): Promise<PeerSyncResult> {
  const dir = await gitDir(root);
  const state = await readGitState(root);

  if (dir === undefined || !isUsable(state)) {
    return { peers: [], moved: undefined, switched: undefined };
  }

  const peers = readPeerHeads(dir);
  const own = peers.find((entry) => entry.machine === options.machine);
  const epoch = ownEpoch(own, state, peers);
  const heads = [
    ...peers.filter((entry) => entry.machine !== options.machine),
    {
      machine: options.machine,
      branch: state.branch,
      commit: state.commit,
      branchEpoch: epoch,
    },
  ];
  const switched = await followPeerBranch(root, state, heads, options);
  const current = switched === undefined ? state : await readGitState(root);
  const moved = await moveToPeerTip(root, current, peers, options);
  const after = moved === undefined ? current : await readGitState(root);

  await publish(root, dir, after, options, switched, epoch);

  return { peers, moved, switched };
}

export function peerFingerprint(root: string): string {
  const dir = localGitDir(root);

  if (dir === undefined) {
    return '';
  }

  const parts = [
    refLine(dir, 'HEAD'),
    refLine(dir, 'packed-refs'),
    ...headRefLines(dir),
    ...peerLines(dir),
  ];

  return parts.join('|');
}

function localGitDir(root: string): string | undefined {
  const entry = join(root, '.git');

  if (!existsSync(entry)) {
    return undefined;
  }

  if (statSync(entry).isDirectory()) {
    return entry;
  }

  const text = readFileSync(entry, 'utf8').trim();
  const prefix = 'gitdir:';
  const value = text.startsWith(prefix)
    ? text.slice(prefix.length).trim().split('\n')[0]
    : undefined;

  if (value === undefined || value === '') {
    return undefined;
  }

  return isAbsolute(value) ? value : resolve(dirname(entry), value);
}

function refLine(dir: string, name: string): string {
  const file = join(dir, name);

  try {
    const stat = statSync(file);

    return `${name}:${readFileSync(file, 'utf8').trim()}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${name}:absent`;
  }
}

function headRefLines(dir: string): string[] {
  try {
    const text = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
    const prefix = 'ref:';

    return text.startsWith(prefix) ? [refLine(dir, text.slice(prefix.length).trim())] : [];
  } catch {
    return [];
  }
}

function peerLines(dir: string): string[] {
  const folder = join(dir, PEERS_DIR);

  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder)
    .sort()
    .map((name) => {
      const stat = statSync(join(folder, name));

      return `${name}:${stat.mtimeMs}:${stat.size}`;
    });
}

export type PeerRelation = 'same' | 'ahead' | 'behind' | 'diverged' | 'unknown';

export interface PeerSide {
  machine: string;
  branch: string;
  commit: string;
  branchEpoch: number;
  relation: PeerRelation;
  ahead: number;
  behind: number;
}

export async function peerSides(root: string, machine: string): Promise<PeerSide[]> {
  const dir = await gitDir(root);
  const state = await readGitState(root);

  if (dir === undefined || !isUsable(state)) {
    return [];
  }

  const sides: PeerSide[] = [];

  for (const head of readPeerHeads(dir)) {
    if (head.machine === machine) {
      continue;
    }

    sides.push(await sideOf(root, state.commit, head));
  }

  return sides;
}

async function sideOf(root: string, commit: string, head: PeerHead): Promise<PeerSide> {
  const known = await gitHasCommit(root, head.commit);

  if (!known) {
    return { ...head, relation: 'unknown', ahead: 0, behind: 0 };
  }

  if (head.commit === commit) {
    return { ...head, relation: 'same', ahead: 0, behind: 0 };
  }

  if (await isAncestor(root, commit, head.commit)) {
    return { ...head, relation: 'ahead', ahead: await count(root, commit, head.commit), behind: 0 };
  }

  if (await isAncestor(root, head.commit, commit)) {
    return {
      ...head,
      relation: 'behind',
      ahead: 0,
      behind: await count(root, head.commit, commit),
    };
  }

  return {
    ...head,
    relation: 'diverged',
    ahead: await count(root, commit, head.commit),
    behind: await count(root, head.commit, commit),
  };
}

async function count(root: string, from: string, to: string): Promise<number> {
  const result = await git(root, ['rev-list', '--count', `${from}..${to}`]);

  return result.ok ? Number(result.stdout.trim()) : 0;
}

export function readPeerHeads(dir: string): PeerHead[] {
  const folder = join(dir, PEERS_DIR);

  if (!existsSync(folder)) {
    return [];
  }

  const heads: PeerHead[] = [];

  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith('.json')) {
      continue;
    }

    try {
      const parsed = parsePeerHead(JSON.parse(readFileSync(join(folder, name), 'utf8')));

      if (parsed !== undefined) {
        heads.push(parsed);
      }
    } catch {}
  }

  return heads;
}

async function followPeerBranch(
  root: string,
  state: GitRepoState,
  peers: PeerHead[],
  options: PeerSyncOptions,
): Promise<PeerSwitch | undefined> {
  const winner = branchWinner(peers);

  if (winner === undefined || winner.branch === state.branch) {
    return undefined;
  }

  const present = await bundleCommitHere(root, winner, options);
  const refCommit = await gitRefCommit(root, `refs/heads/${winner.branch}`);
  const ref = await refPosition(root, refCommit, winner.commit);
  const blocked = state.staged ? 'staged' : state.operation;
  const filesHere = present ? await filesArrived(root, state.commit, winner.commit) : false;
  const decision = branchFollow({
    ownBranch: state.branch,
    ownCommit: state.commit,
    target: winner,
    targetHere: present,
    filesHere,
    blocked,
    ref,
  });

  if (!decision.follow) {
    return undefined;
  }

  const switched = await gitSwitchTo(root, winner.branch, winner.commit, refCommit);

  if (!switched.ok) {
    return undefined;
  }

  if ((await gitRefCommit(root, `refs/remotes/origin/${winner.branch}`)) !== undefined) {
    await gitSetUpstream(root, winner.branch);
  }

  return {
    from: state.branch,
    to: winner.branch,
    commit: winner.commit,
    epoch: winner.branchEpoch,
  };
}

async function refPosition(
  root: string,
  refCommit: string | undefined,
  target: string,
): Promise<RefPosition> {
  if (refCommit === undefined) {
    return 'missing';
  }

  if (refCommit === target || (await isAncestor(root, refCommit, target))) {
    return 'ancestor';
  }

  return 'other';
}

async function moveToPeerTip(
  root: string,
  state: GitRepoState,
  peers: PeerHead[],
  options: PeerSyncOptions,
): Promise<PeerMove | undefined> {
  if (state.staged || state.operation !== undefined) {
    return undefined;
  }

  const candidates: Array<{ source: string; commit: string }> = [];
  const originTip = await gitRefCommit(root, `refs/remotes/origin/${state.branch}`);

  if (originTip !== undefined) {
    candidates.push({ source: 'origin', commit: originTip });
  }

  for (const peer of peers) {
    if (peer.machine === options.machine || peer.branch !== state.branch) {
      continue;
    }

    if (await bundleCommitHere(root, peer, options)) {
      candidates.push({ source: peer.machine, commit: peer.commit });
    }
  }

  const inputs: TipInput[] = [];

  for (const candidate of candidates) {
    inputs.push({
      source: candidate.source,
      commit: candidate.commit,
      fromHead:
        candidate.commit === state.commit ||
        (await isAncestor(root, state.commit, candidate.commit)),
      ancestors: await ancestorsOf(root, candidate.commit, candidates),
    });
  }

  const tip = furthestTip(inputs);

  if (tip === undefined || tip.commit === state.commit) {
    return undefined;
  }

  if (!(await filesArrived(root, state.commit, tip.commit))) {
    return undefined;
  }

  const reset = await gitCompareAndSwap(
    root,
    `refs/heads/${state.branch}`,
    tip.commit,
    state.commit,
  );

  return reset.ok ? { from: state.commit, to: tip.commit, source: tip.source } : undefined;
}

async function ancestorsOf(
  root: string,
  commit: string,
  candidates: Array<{ source: string; commit: string }>,
): Promise<string[]> {
  const ancestors: string[] = [];

  for (const candidate of candidates) {
    if (candidate.commit === commit) {
      continue;
    }

    if (await isAncestor(root, candidate.commit, commit)) {
      ancestors.push(candidate.commit);
    }
  }

  return ancestors;
}

async function bundleCommitHere(
  root: string,
  peer: PeerHead,
  options: PeerSyncOptions,
): Promise<boolean> {
  if (await gitHasCommit(root, peer.commit)) {
    return true;
  }

  const dir = await gitDir(root);
  const file = dir === undefined ? undefined : join(dir, PEERS_DIR, peerBundleFile(peer.machine));

  if (file === undefined || !existsSync(file)) {
    return false;
  }

  const fetched = await gitBundleFetch(root, file, peer.branch, options.timeoutMs);

  return fetched.ok && (await gitHasCommit(root, peer.commit));
}

async function publish(
  root: string,
  dir: string,
  state: GitRepoState,
  options: PeerSyncOptions,
  switched: PeerSwitch | undefined,
  epoch: number,
): Promise<void> {
  if (!isUsable(state)) {
    return;
  }

  const head: PeerHead = {
    machine: options.machine,
    branch: state.branch,
    commit: state.commit,
    branchEpoch: switched === undefined ? epoch : switched.epoch,
  };
  const folder = join(dir, PEERS_DIR);
  const headPath = join(folder, peerHeadFile(options.machine));
  const originTip = (await gitRefCommit(root, `refs/remotes/origin/${state.branch}`)) ?? '';
  const bundlePath = join(folder, peerBundleFile(options.machine));
  const needed = publishNeeded(state.commit, originTip);
  const previous = readOwnHead(headPath);

  mkdirSync(folder, { recursive: true });

  if (!needed) {
    rmSync(bundlePath, { force: true });
  } else if (previous?.commit !== state.commit || !existsSync(bundlePath)) {
    const temporary = join(dir, `.corami-${options.machine}.bundle`);

    rmSync(temporary, { force: true });

    const created = await gitBundleCreate(root, temporary, state.branch);

    if (created.ok) {
      renameSync(temporary, bundlePath);
    } else {
      rmSync(temporary, { force: true });
      rmSync(bundlePath, { force: true });
    }
  }

  if (previous !== undefined && sameHead(previous, head)) {
    return;
  }

  const temporary = join(dir, `.corami-${options.machine}.json`);

  writeFileSync(temporary, `${JSON.stringify(peerHeadJson(head))}\n`);
  renameSync(temporary, headPath);
}

function readOwnHead(path: string): PeerHead | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return parsePeerHead(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function sameHead(left: PeerHead, right: PeerHead): boolean {
  return (
    left.machine === right.machine &&
    left.branch === right.branch &&
    left.commit === right.commit &&
    left.branchEpoch === right.branchEpoch
  );
}

function ownEpoch(own: PeerHead | undefined, state: GitRepoState, peers: PeerHead[]): number {
  if (own === undefined) {
    return 0;
  }

  if (own.branch !== state.branch) {
    return nextBranchEpoch(
      own.branchEpoch,
      peers.map((entry) => entry.branchEpoch),
      true,
    );
  }

  return own.branchEpoch;
}
