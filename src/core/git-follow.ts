import {
  filesArrived,
  gitCompareAndSwap,
  gitFetchOrigin,
  gitHasCommit,
  gitRefCommit,
  gitUpstreamOf,
  isAncestor,
  readGitState,
} from '@/core/git.ts';
import {
  type GitRelationStatus,
  type GitRepoState,
  gitStateJson,
  isUsable,
  originRelation,
} from '@/core/git-align.ts';
import { FOLLOW_ORIGIN_MESSAGE, type OriginTip } from '@/core/git-peers.ts';

const ACTIVE_MS = 60_000;
const IDLE_MS = 15 * 60_000;
const ACTIVITY_MS = 30 * 60_000;

export interface GitOriginStatus {
  state: GitRepoState;
  upstream: string | undefined;
  upstreamCommit: string;
  status: GitRelationStatus;
  reason: string | undefined;
  move: boolean;
  fetched: boolean;
  filesHere: boolean;
}

export async function gitOriginState(root: string, known?: GitRepoState): Promise<GitOriginStatus> {
  const state = known ?? (await readGitState(root));
  const upstream = await gitUpstreamOf(root, state.branch);
  const upstreamCommit = upstream === undefined ? '' : ((await gitRefCommit(root, upstream)) ?? '');
  const upstreamHere = upstreamCommit !== '' && (await gitHasCommit(root, upstreamCommit));
  const aligned = upstreamHere && state.commit === upstreamCommit;
  const headInUpstream =
    upstreamHere && state.commit !== '' && (await isAncestor(root, state.commit, upstreamCommit));
  const upstreamInHead =
    upstreamHere && state.commit !== '' && (await isAncestor(root, upstreamCommit, state.commit));
  const relation = originRelation({
    state,
    upstream,
    upstreamHere,
    aligned,
    headInUpstream,
    upstreamInHead,
  });

  return {
    state,
    upstream,
    upstreamCommit,
    status: relation.status,
    reason: relation.reason,
    move: relation.move,
    fetched: false,
    filesHere: relation.status !== 'behind' || upstreamHere,
  };
}

export async function followOrigin(root: string, timeoutMs = 60_000): Promise<GitOriginStatus> {
  const status = await gitOriginState(root);

  if (!isUsable(status.state) || status.upstream === undefined) {
    return status;
  }

  const fetched = await gitFetchOrigin(root, timeoutMs);

  if (!fetched.ok) {
    return { ...status, fetched: false };
  }

  const next = await gitOriginState(root);

  if (!next.move) {
    return { ...next, fetched: true };
  }

  const filesHere = await filesArrived(root, next.state.commit, next.upstreamCommit);

  if (!filesHere) {
    return {
      ...next,
      fetched: true,
      move: false,
      reason: 'waiting_for_files',
      filesHere: false,
    };
  }

  const reset = await gitCompareAndSwap(
    root,
    `refs/heads/${next.state.branch}`,
    next.upstreamCommit,
    next.state.commit,
    FOLLOW_ORIGIN_MESSAGE,
  );
  const after = await readGitState(root);

  if (!reset.ok) {
    return { ...next, state: after, fetched: true, move: true, filesHere, reason: reset.detail };
  }

  return {
    ...next,
    state: after,
    status: 'aligned',
    move: false,
    reason: undefined,
    fetched: true,
    filesHere: true,
  };
}

export function originStatusJson(status: GitOriginStatus): Record<string, unknown> {
  return {
    state: gitStateJson(status.state),
    upstream: status.upstream ?? null,
    upstream_commit: status.upstreamCommit,
    status: status.status,
    reason: status.reason ?? null,
    move: status.move,
    fetched: status.fetched,
    files_here: status.filesHere,
  };
}

export function fetchFailed(status: GitOriginStatus): boolean {
  return status.upstream !== undefined && status.fetched === false;
}

export function originStateChanged(
  previous: GitOriginStatus | undefined,
  status: GitOriginStatus,
): boolean {
  if (previous === undefined) {
    return true;
  }

  return previous.status !== status.status || previous.state.commit !== status.state.commit;
}

export interface OriginActivity {
  fingerprint: string;
  dirtyChanges: number;
  offOrigin: boolean;
}

export interface OriginSchedule {
  lastActiveAt: number;
  lastFetchAt: number;
  offOrigin: boolean;
  requested: boolean;
}

export function freshOriginSchedule(): OriginSchedule {
  return { lastActiveAt: 0, lastFetchAt: 0, offOrigin: false, requested: false };
}

export function noteOriginActivity(
  schedule: OriginSchedule,
  previous: OriginActivity | undefined,
  activity: OriginActivity,
  now: number,
): OriginSchedule {
  const changed =
    previous === undefined ||
    previous.fingerprint !== activity.fingerprint ||
    previous.dirtyChanges !== activity.dirtyChanges ||
    (activity.offOrigin && !previous.offOrigin);

  return {
    ...schedule,
    offOrigin: activity.offOrigin,
    lastActiveAt: changed ? now : schedule.lastActiveAt,
  };
}

export function originFetchDue(schedule: OriginSchedule, now: number): boolean {
  if (schedule.requested) {
    return true;
  }

  if (schedule.lastFetchAt === 0) {
    return true;
  }

  const active = schedule.offOrigin || now - schedule.lastActiveAt < ACTIVITY_MS;
  const interval = active ? ACTIVE_MS : IDLE_MS;

  return now - schedule.lastFetchAt >= interval;
}

export function originRequestOpen(requested: boolean, status: GitOriginStatus): boolean {
  const fetchable = isUsable(status.state) && status.upstream !== undefined;

  return requested && fetchable && !status.fetched;
}

export function originIsOff(status: GitOriginStatus): boolean {
  return status.status === 'ahead' || status.status === 'behind';
}

export type OriginTipAction = 'none' | 'update_ref' | 'fetch';

export function originTipAction(
  local: string | undefined,
  published: OriginTip | undefined,
  present: boolean,
): OriginTipAction {
  if (published === undefined || published.commit === local) {
    return 'none';
  }

  return present ? 'update_ref' : 'fetch';
}

export function originChangeJson(
  project: string,
  status: GitOriginStatus,
  from: string | undefined,
): Record<string, unknown> {
  return {
    project,
    status: status.status,
    reason: status.reason ?? null,
    from: from ?? null,
    to: status.state.commit,
    upstream_commit: status.upstreamCommit,
    fetched: status.fetched,
  };
}

export function describeOrigin(status: GitOriginStatus | undefined, watch = true): string {
  if (status === undefined) {
    return 'n/a';
  }

  switch (status.status) {
    case 'aligned':
      return 'aligned with origin';
    case 'ahead':
      return 'commits to publish (push)';
    case 'behind': {
      const text = status.filesHere
        ? `behind (${status.reason ?? 'to update'})`
        : 'behind, waiting for the sync files';

      return watch || !status.move ? text : `${text}, git alignment service not running`;
    }
    case 'diverged':
      return 'diverged from origin';
    default:
      return `n/a (${status.reason ?? 'unknown'})`;
  }
}

export function originNeedsWatch(status: GitOriginStatus | undefined): boolean {
  return status?.status === 'behind' && status.move;
}

export { ACTIVE_MS as ORIGIN_ACTIVE_MS };
