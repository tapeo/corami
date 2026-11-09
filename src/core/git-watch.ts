import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir, gitHasCommit, gitRefCommit, gitUpdateRemoteRef } from '@/core/git.ts';
import {
  fetchFailed,
  followOrigin,
  freshOriginSchedule,
  type GitOriginStatus,
  gitOriginState,
  noteOriginActivity,
  ORIGIN_ACTIVE_MS,
  type OriginActivity,
  type OriginSchedule,
  originFetchDue,
  originIsOff,
  originRequestOpen,
  originStateChanged,
  originTipAction,
} from '@/core/git-follow.ts';
import {
  emptyPeerSync,
  type PeerMove,
  type PeerSwitch,
  peerFingerprint,
  publishOriginTip,
  readOriginTip,
  syncPeers,
} from '@/core/git-peers-sync.ts';

const WATCH_TICK_MS = 2_000;
const WATCH_ORIGIN_SLOTS = 4;
const WATCH_SWEEP_MS = 30_000;
const WATCH_PENDING_MS = 60_000;

export interface WatchRoot {
  project: string;
  root: string;
}

export type WatchEvent =
  | { kind: 'origin'; project: string; status: GitOriginStatus; from: string | undefined }
  | { kind: 'fetch'; project: string; failed: boolean }
  | { kind: 'move'; project: string; move: PeerMove }
  | { kind: 'switch'; project: string; switched: PeerSwitch };

export interface WatchOptions {
  machine: string;
  pollsOrigin: boolean;
  roots: () => Promise<WatchRoot[]>;
  signal: AbortSignal;
  onEvent: (event: WatchEvent) => void;
  onProject?: (project: string) => void;
  onEmpty?: () => void;
  resetSession?: (project: string) => Promise<void>;
}

export interface PeerTurnState {
  fingerprint: string;
  pendingUntil: number;
  sweepAt: number;
}

interface ProjectRecord extends PeerTurnState {
  activity: OriginActivity | undefined;
  schedule: OriginSchedule;
  before: GitOriginStatus | undefined;
  failing: boolean;
  originRetryAt: number;
}

interface WatchRuntime {
  options: WatchOptions;
  records: Map<string, ProjectRecord>;
  asked: Set<string>;
  running: Set<string>;
}

export function peerTurnDue(state: PeerTurnState, fingerprint: string, now: number): boolean {
  return now >= state.sweepAt || now < state.pendingUntil || fingerprint !== state.fingerprint;
}

export function nextPendingUntil(
  previous: number,
  pending: boolean,
  changed: boolean,
  now: number,
): number {
  if (!pending) {
    return 0;
  }

  if (changed || previous === 0) {
    return now + WATCH_PENDING_MS;
  }

  return previous;
}

export async function watchProjects(options: WatchOptions): Promise<void> {
  const runtime: WatchRuntime = {
    options,
    records: new Map(),
    asked: new Set(),
    running: new Set(),
  };
  let empty = false;

  while (!options.signal.aborted) {
    const roots = await options.roots().catch(() => []);

    if (roots.length === 0) {
      if (!empty) {
        empty = true;
        options.onEmpty?.();
      }
    } else {
      empty = false;
    }

    for (const item of roots) {
      if (options.signal.aborted) {
        break;
      }

      await peerTurn(runtime, item).catch(() => undefined);
    }

    startOriginTurns(runtime, roots);

    await sleep(WATCH_TICK_MS, options.signal);
  }
}

async function peerTurn(runtime: WatchRuntime, item: WatchRoot): Promise<void> {
  const record = recordFor(runtime, item.project);

  if (runtime.running.has(item.project)) {
    return;
  }

  const now = Date.now();
  const fingerprint = peerFingerprint(item.root);

  if (!peerTurnDue(record, fingerprint, now)) {
    return;
  }

  if (now >= record.sweepAt) {
    record.sweepAt = now + WATCH_SWEEP_MS;
  }

  const changed = fingerprint !== record.fingerprint;

  record.fingerprint = fingerprint;

  const events = await peerWork(runtime, item, record, changed).catch(() => undefined);

  if (events === undefined) {
    record.fingerprint = '';
    return;
  }

  emit(runtime, events);
}

async function peerWork(
  runtime: WatchRuntime,
  item: WatchRoot,
  record: ProjectRecord,
  changed: boolean,
): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  const peerDir = join(item.root, '.git', 'corami');
  const existed = existsSync(peerDir);
  const peers = await syncPeers(item.root, { machine: runtime.options.machine }).catch(
    emptyPeerSync,
  );

  record.pendingUntil = nextPendingUntil(record.pendingUntil, peers.pending, changed, Date.now());

  if (!existed && existsSync(peerDir)) {
    await runtime.options.resetSession?.(item.project).catch(() => undefined);
  }

  if (peers.moved !== undefined) {
    events.push({ kind: 'move', project: item.project, move: peers.moved });
  }

  if (peers.switched !== undefined) {
    events.push({ kind: 'switch', project: item.project, switched: peers.switched });
  }

  for (const peer of peers.missing) {
    requestOrigin(runtime, record, item.project, peer.commit);
  }

  await applyOriginTip(runtime, item, record);

  const status = await gitOriginState(item.root).catch(() => undefined);

  if (status !== undefined) {
    noteActivity(record, status);
    recordStatus(record, item.project, status, events);
  }

  return events;
}

function noteActivity(record: ProjectRecord, status: GitOriginStatus): void {
  const activity: OriginActivity = {
    fingerprint: record.fingerprint,
    dirtyChanges: status.state.dirtyChanges,
    offOrigin: originIsOff(status),
  };

  record.schedule = noteOriginActivity(record.schedule, record.activity, activity, Date.now());
  record.activity = activity;
}

async function applyOriginTip(
  runtime: WatchRuntime,
  item: WatchRoot,
  record: ProjectRecord,
): Promise<void> {
  if (runtime.options.pollsOrigin) {
    return;
  }

  const dir = await gitDir(item.root);

  if (dir === undefined) {
    return;
  }

  const published = readOriginTip(dir);

  if (published === undefined) {
    return;
  }

  const local = await gitRefCommit(item.root, `refs/remotes/origin/${published.branch}`);
  const present = await gitHasCommit(item.root, published.commit);
  const action = originTipAction(local, published, present);

  if (action === 'update_ref') {
    const updated = await gitUpdateRemoteRef(item.root, published.branch, published.commit, local);

    if (!updated) {
      requestOrigin(runtime, record, item.project, published.commit);
    }

    return;
  }

  if (action === 'fetch') {
    requestOrigin(runtime, record, item.project, published.commit);
  }
}

function startOriginTurns(runtime: WatchRuntime, roots: WatchRoot[]): void {
  const now = Date.now();

  for (const item of roots) {
    if (runtime.running.has(item.project) || runtime.running.size >= WATCH_ORIGIN_SLOTS) {
      continue;
    }

    const record = runtime.records.get(item.project);

    if (record === undefined || !originTurnDue(runtime, record, now)) {
      continue;
    }

    runtime.running.add(item.project);

    void originTurn(runtime, item, record)
      .catch(() => undefined)
      .finally(() => runtime.running.delete(item.project));
  }
}

function originTurnDue(runtime: WatchRuntime, record: ProjectRecord, now: number): boolean {
  if (record.schedule.requested) {
    return now >= record.originRetryAt;
  }

  return runtime.options.pollsOrigin && originFetchDue(record.schedule, now);
}

async function originTurn(
  runtime: WatchRuntime,
  item: WatchRoot,
  record: ProjectRecord,
): Promise<void> {
  const now = Date.now();

  record.schedule = { ...record.schedule, lastFetchAt: now };

  const fetched = await followOrigin(item.root).catch(() => undefined);

  if (fetched === undefined) {
    record.originRetryAt = now + ORIGIN_ACTIVE_MS;
    return;
  }

  const open = originRequestOpen(record.schedule.requested, fetched);

  record.schedule = { ...record.schedule, requested: open };
  record.originRetryAt = open ? now + ORIGIN_ACTIVE_MS : 0;

  await publishTip(runtime, item, fetched);

  const events: WatchEvent[] = [];
  const failed = fetchFailed(fetched);

  if (failed !== record.failing) {
    record.failing = failed;
    events.push({ kind: 'fetch', project: item.project, failed });
  }

  recordStatus(record, item.project, fetched, events);
  emit(runtime, events);
}

async function publishTip(
  runtime: WatchRuntime,
  item: WatchRoot,
  status: GitOriginStatus,
): Promise<void> {
  const branch = status.state.branch;
  const tracked = `origin/${branch}`;

  if (
    !runtime.options.pollsOrigin ||
    !status.fetched ||
    branch === '' ||
    status.upstream !== tracked
  ) {
    return;
  }

  await publishOriginTip(item.root, branch, status.upstreamCommit).catch(() => undefined);
}

function requestOrigin(
  runtime: WatchRuntime,
  record: ProjectRecord,
  project: string,
  commit: string,
): void {
  if (commit === '' || !runtime.asked.add(`${project}:${commit}`)) {
    return;
  }

  record.schedule = { ...record.schedule, requested: true };
}

function recordStatus(
  record: ProjectRecord,
  project: string,
  status: GitOriginStatus,
  events: WatchEvent[],
): void {
  const before = record.before;

  record.before = status;

  if (!originStateChanged(before, status)) {
    return;
  }

  events.push({ kind: 'origin', project, status, from: before?.state.commit });
}

function recordFor(runtime: WatchRuntime, project: string): ProjectRecord {
  const existing = runtime.records.get(project);

  if (existing !== undefined) {
    return existing;
  }

  runtime.options.onProject?.(project);

  const record: ProjectRecord = {
    fingerprint: '',
    activity: undefined,
    schedule: freshOriginSchedule(),
    before: undefined,
    failing: false,
    pendingUntil: 0,
    originRetryAt: 0,
    sweepAt: 0,
  };

  runtime.records.set(project, record);

  return record;
}

function emit(runtime: WatchRuntime, events: WatchEvent[]): void {
  for (const event of events) {
    runtime.options.onEvent(event);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
