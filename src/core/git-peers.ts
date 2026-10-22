export interface PeerHead {
  machine: string;
  branch: string;
  commit: string;
  branchEpoch: number;
}

export interface TipInput {
  source: string;
  commit: string;
  fromHead: boolean;
  ancestors: string[];
}

export type RefPosition = 'missing' | 'ancestor' | 'other';

export interface BranchFollowInput {
  ownBranch: string;
  ownCommit: string;
  target: PeerHead;
  targetHere: boolean;
  filesHere: boolean;
  blocked: string | undefined;
  ref: RefPosition;
}

export interface BranchFollow {
  follow: boolean;
  reason: string | undefined;
}

export interface DivergedSide {
  machine: string;
  ahead: number;
  tip: string;
}

export interface DivergenceAdvice {
  machine: string;
  resetTo: string;
}

export const PEERS_DIR = 'corami';

export function peerHeadFile(machine: string): string {
  return `${machine}.json`;
}

export function peerBundleFile(machine: string): string {
  return `${machine}.bundle`;
}

export function parsePeerHead(value: unknown): PeerHead | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const machine = record.machine;
  const branch = record.branch;
  const commit = record.commit;
  const epoch = record.branch_epoch;

  if (
    typeof machine !== 'string' ||
    machine === '' ||
    typeof branch !== 'string' ||
    branch === '' ||
    typeof commit !== 'string' ||
    commit === '' ||
    typeof epoch !== 'number' ||
    !Number.isInteger(epoch) ||
    epoch < 0
  ) {
    return undefined;
  }

  return { machine, branch, commit, branchEpoch: epoch };
}

export function peerHeadJson(head: PeerHead): Record<string, unknown> {
  return {
    machine: head.machine,
    branch: head.branch,
    commit: head.commit,
    branch_epoch: head.branchEpoch,
  };
}

export function branchWinner(heads: PeerHead[]): PeerHead | undefined {
  return [...heads].sort(byEpochAndMachine)[0];
}

export function nextBranchEpoch(current: number, seen: number[], manual: boolean): number {
  if (!manual) {
    return current;
  }

  return Math.max(current, ...seen) + 1;
}

export function furthestTip(inputs: TipInput[]): TipInput | undefined {
  const commits = [...new Set(inputs.map((input) => input.commit))].filter(
    (commit) => commit !== '',
  );

  if (commits.length === 0) {
    return undefined;
  }

  const tips = inputs.filter((input) => covers(input, commits));
  const chosen = tips[0];

  if (chosen === undefined) {
    return undefined;
  }

  return tips.every((tip) => tip.commit === chosen.commit) ? chosen : undefined;
}

export function branchFollow(input: BranchFollowInput): BranchFollow {
  if (input.ownBranch === input.target.branch && input.ownCommit === input.target.commit) {
    return { follow: false, reason: undefined };
  }

  if (input.blocked !== undefined) {
    return { follow: false, reason: input.blocked };
  }

  if (!input.targetHere) {
    return { follow: false, reason: 'branch_target_not_here' };
  }

  if (input.ref === 'other') {
    return { follow: false, reason: 'branch_history_diverged' };
  }

  if (!input.filesHere) {
    return { follow: false, reason: 'waiting_for_files' };
  }

  return { follow: true, reason: undefined };
}

export function divergenceAdvice(sides: DivergedSide[]): DivergenceAdvice | undefined {
  if (sides.length < 2) {
    return undefined;
  }

  const resetter = [...sides].sort(byAheadAndMachine)[0];

  if (resetter === undefined) {
    return undefined;
  }

  const others = sides.filter((side) => side.machine !== resetter.machine);
  const furthest = [...others].sort(byAheadThenMachine)[0];

  if (furthest === undefined) {
    return undefined;
  }

  return { machine: resetter.machine, resetTo: furthest.tip };
}

export function publishNeeded(commit: string, originTip: string): boolean {
  return commit !== '' && commit !== originTip;
}

function covers(input: TipInput, commits: string[]): boolean {
  if (!input.fromHead) {
    return false;
  }

  return commits.every((commit) => commit === input.commit || input.ancestors.includes(commit));
}

function byEpochAndMachine(left: PeerHead, right: PeerHead): number {
  if (left.branchEpoch !== right.branchEpoch) {
    return right.branchEpoch - left.branchEpoch;
  }

  return left.machine.localeCompare(right.machine);
}

function byAheadAndMachine(left: DivergedSide, right: DivergedSide): number {
  if (left.ahead !== right.ahead) {
    return left.ahead - right.ahead;
  }

  return left.machine.localeCompare(right.machine);
}

function byAheadThenMachine(left: DivergedSide, right: DivergedSide): number {
  if (left.ahead !== right.ahead) {
    return right.ahead - left.ahead;
  }

  return left.machine.localeCompare(right.machine);
}
