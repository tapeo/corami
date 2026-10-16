// The cycle that keeps one side aligned with `origin`. It runs on the client
// and on the server with the same code: the files are never touched here, the
// sync moves them.

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

const CYCLE_MS = 60_000;

export interface GitOriginStatus {
  // The repository of this side: commit, branch, work in progress.
  state: GitRepoState;
  // The branch of `origin` that is followed, like `origin/main`.
  upstream: string | undefined;
  upstreamCommit: string;
  status: GitRelationStatus;
  reason: string | undefined;
  // True when the side is behind and can move.
  move: boolean;
  // False when `origin` did not answer: the decision uses the refs at hand.
  fetched: boolean;
  // True when the incoming changes are already in the files.
  filesHere: boolean;
}

export async function gitOriginState(root: string): Promise<GitOriginStatus> {
  const state = await readGitState(root);
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
    // Nothing is pending when the side is not behind; with an unreachable
    // upstream the commit did not arrive.
    filesHere: relation.status !== 'behind' || upstreamHere,
  };
}

// One cycle: fetch of `origin`, decision and, when the side is behind with the
// files already arrived, a HEAD move with a compare-and-swap.
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
  );
  const after = await readGitState(root);

  if (!reset.ok) {
    // The expected commit changed in the meantime: nothing is jumped over and
    // the next cycle retries.
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

// A fetch failed only when there was an `origin` to follow: a project without
// a repository cannot fail at anything.
export function fetchFailed(status: GitOriginStatus): boolean {
  return status.upstream !== undefined && status.fetched === false;
}

// Does the cycle have something to tell? A move, a relation change, the first
// fetch failure and its recovery: the same line does not repeat at every cycle.
// `wasFailing` is whether the cycle before the fetch towards `origin` did not
// succeed, because a failing fetch does not change the relation read from the
// old refs, and without this memory it would stay silent.
export function originChanged(
  previous: GitOriginStatus | undefined,
  status: GitOriginStatus,
  wasFailing: boolean,
): boolean {
  if (previous === undefined) {
    return true;
  }

  return (
    previous.status !== status.status ||
    previous.state.commit !== status.state.commit ||
    fetchFailed(status) !== wasFailing
  );
}

// One log line per cycle: a JSON object for every state change of a project, so
// the service journal tells what happened without looking further. `from` and
// `to` are the HEAD before and after the cycle, and `upstream_commit` is where
// `origin` stands: while waiting for files `from` and `to` coincide and the
// commit to reach is the upstream.
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

// The state of one side in a line: aligned, commits to publish, behind.
export function describeOrigin(status: GitOriginStatus | undefined): string {
  if (status === undefined) {
    return 'n/a';
  }

  switch (status.status) {
    case 'aligned':
      return 'aligned with origin';
    case 'ahead':
      return 'commits to publish (push)';
    case 'behind':
      return status.filesHere
        ? `behind (${status.reason ?? 'to update'})`
        : 'behind, waiting for the sync files';
    case 'diverged':
      return 'diverged from origin';
    default:
      return `n/a (${status.reason ?? 'unknown'})`;
  }
}

export { CYCLE_MS as ORIGIN_CYCLE_MS };
