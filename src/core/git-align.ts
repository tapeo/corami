// Git state of one side and its relation with `origin`. The files are already
// the ones of the commit to reach, delivered by the sync: only the refs are
// decided here.

export interface GitRepoState {
  commit: string;
  branch: string;
  operation: string | undefined;
  staged: boolean;
  dirtyChanges: number;
}

export type GitRelationStatus = 'unknown' | 'aligned' | 'behind' | 'ahead' | 'diverged';

export interface GitRelation {
  status: GitRelationStatus;
  // True when the side is behind and can move: `aligned` and `ahead` leave
  // things alone, and `ahead` means commits to publish.
  move: boolean;
  reason: string | undefined;
}

export interface OriginRelationInput {
  state: GitRepoState;
  // The branch of `origin` that is followed: `origin/<branch>`, or nothing.
  upstream: string | undefined;
  // The upstream commit already exists locally: without it, nothing is read.
  upstreamHere: boolean;
  aligned: boolean;
  headInUpstream: boolean;
  upstreamInHead: boolean;
}

export function notARepository(): GitRepoState {
  return {
    commit: '',
    branch: '',
    operation: undefined,
    staged: false,
    dirtyChanges: 0,
  };
}

export function isUsable(state: GitRepoState): boolean {
  return state.commit !== '' && state.branch !== '';
}

export function parseGitState(value: unknown): GitRepoState | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');

  return {
    commit: text('commit'),
    branch: text('branch'),
    operation: text('operation') === '' ? undefined : text('operation'),
    staged: record.staged === true,
    dirtyChanges:
      typeof record.dirty_changes === 'number' && Number.isFinite(record.dirty_changes)
        ? record.dirty_changes
        : 0,
  };
}

export function gitStateJson(state: GitRepoState): Record<string, unknown> {
  return {
    commit: state.commit,
    branch: state.branch,
    operation: state.operation ?? null,
    staged: state.staged,
    dirty_changes: state.dirtyChanges,
  };
}

export function isRelationStatus(value: unknown): value is GitRelationStatus {
  return (
    value === 'unknown' ||
    value === 'aligned' ||
    value === 'behind' ||
    value === 'ahead' ||
    value === 'diverged'
  );
}

// The relation of one side with `origin`. `aligned` and `ahead` never move
// anything: whoever is ahead has commits to publish, and the push stays a human
// act. `behind` moves the HEAD only when there is no staged work and no
// operation in progress; whether the files arrived is checked by the caller.
export function originRelation(input: OriginRelationInput): GitRelation {
  const { state } = input;

  if (!isUsable(state)) {
    return {
      status: 'unknown',
      move: false,
      reason: state.commit === '' ? 'not_a_repository' : 'detached_head',
    };
  }

  if (input.upstream === undefined) {
    return { status: 'unknown', move: false, reason: 'no_upstream' };
  }

  if (!input.upstreamHere) {
    return { status: 'behind', move: false, reason: 'upstream_not_here' };
  }

  if (input.aligned) {
    return { status: 'aligned', move: false, reason: undefined };
  }

  if (input.headInUpstream) {
    if (state.staged) {
      return { status: 'behind', move: false, reason: 'staged' };
    }

    if (state.operation !== undefined) {
      return { status: 'behind', move: false, reason: `${state.operation}_in_progress` };
    }

    return { status: 'behind', move: true, reason: undefined };
  }

  if (input.upstreamInHead) {
    return { status: 'ahead', move: false, reason: undefined };
  }

  return { status: 'diverged', move: false, reason: 'history_diverged' };
}
