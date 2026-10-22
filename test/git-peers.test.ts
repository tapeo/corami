import { describe, expect, test } from 'bun:test';
import {
  branchFollow,
  branchWinner,
  type DivergedSide,
  divergenceAdvice,
  furthestTip,
  nextBranchEpoch,
  parsePeerHead,
  peerBundleFile,
  peerHeadFile,
  peerHeadJson,
  publishNeeded,
  type TipInput,
} from '@/core/git-peers.ts';

function head(machine: string, epoch: number, branch = 'main', commit = 'c1') {
  return { machine, branch, commit, branchEpoch: epoch };
}

function tip(source: string, commit: string, ancestors: string[], fromHead = true): TipInput {
  return { source, commit, fromHead, ancestors };
}

describe('peer head', () => {
  test('parses a valid file', () => {
    const parsed = parsePeerHead({
      machine: 'tapeo',
      branch: 'main',
      commit: 'abc',
      branch_epoch: 2,
    });

    expect(parsed).toEqual({ machine: 'tapeo', branch: 'main', commit: 'abc', branchEpoch: 2 });
  });

  test('rejects malformed files', () => {
    expect(parsePeerHead(null)).toBeUndefined();
    expect(parsePeerHead({})).toBeUndefined();
    expect(parsePeerHead({ machine: 'tapeo', branch: 'main', commit: 'abc' })).toBeUndefined();
    expect(
      parsePeerHead({ machine: '', branch: 'main', commit: 'abc', branch_epoch: 1 }),
    ).toBeUndefined();
    expect(
      parsePeerHead({ machine: 'tapeo', branch: 'main', commit: 'abc', branch_epoch: 1.5 }),
    ).toBeUndefined();
    expect(
      parsePeerHead({ machine: 'tapeo', branch: 'main', commit: 'abc', branch_epoch: -1 }),
    ).toBeUndefined();
  });

  test('writes snake case keys', () => {
    expect(peerHeadJson(head('tapeo', 3))).toEqual({
      machine: 'tapeo',
      branch: 'main',
      commit: 'c1',
      branch_epoch: 3,
    });
  });

  test('names the two files of a machine', () => {
    expect(peerHeadFile('tapeo')).toBe('tapeo.json');
    expect(peerBundleFile('tapeo')).toBe('tapeo.bundle');
  });
});

describe('branch winner', () => {
  test('takes the highest epoch', () => {
    expect(branchWinner([head('a', 1), head('b', 4), head('c', 2)])?.machine).toBe('b');
  });

  test('breaks ties by machine name', () => {
    expect(branchWinner([head('tapeo', 2), head('hearth-vps', 2)])?.machine).toBe('hearth-vps');
  });

  test('has no winner among no heads', () => {
    expect(branchWinner([])).toBeUndefined();
  });
});

describe('branch epoch', () => {
  test('a switch made by hand goes past everything seen', () => {
    expect(nextBranchEpoch(1, [1, 3, 2], true)).toBe(4);
  });

  test('a followed switch keeps the epoch', () => {
    expect(nextBranchEpoch(3, [1, 3], false)).toBe(3);
  });
});

describe('furthest tip', () => {
  test('picks the candidate ahead of the head', () => {
    const picked = furthestTip([tip('origin', 'c2', ['c1']), tip('tapeo', 'c1', [])]);

    expect(picked?.commit).toBe('c2');
  });

  test('returns the common tip, equal to the head included', () => {
    const picked = furthestTip([tip('tapeo', 'c1', [], false), tip('origin', 'c1', [])]);

    expect(picked?.commit).toBe('c1');
  });

  test('picks nothing when two candidates diverged', () => {
    const picked = furthestTip([
      tip('origin', 'c2', ['c1']),
      tip('tapeo', 'c3', ['c1']),
      tip('hearth-vps', 'c1', []),
    ]);

    expect(picked).toBeUndefined();
  });

  test('picks the furthest of a chain', () => {
    const picked = furthestTip([
      tip('origin', 'c2', ['c1']),
      tip('tapeo', 'c3', ['c1', 'c2']),
      tip('hearth-vps', 'c1', []),
    ]);

    expect(picked?.source).toBe('tapeo');
  });

  test('ignores candidates that do not descend from the head', () => {
    expect(furthestTip([tip('origin', 'c2', ['c1'], false)])).toBeUndefined();
  });

  test('has nothing to pick among no candidates', () => {
    expect(furthestTip([])).toBeUndefined();
  });
});

describe('branch follow', () => {
  const target = head('hearth-vps', 2, 'feat/x', 'c9');

  test('does nothing when the two sides are already on the same commit', () => {
    const decision = branchFollow({
      ownBranch: 'feat/x',
      ownCommit: 'c9',
      target,
      targetHere: true,
      filesHere: true,
      blocked: undefined,
      ref: 'ancestor',
    });

    expect(decision).toEqual({ follow: false, reason: undefined });
  });

  test('follows when everything is in place', () => {
    const decision = branchFollow({
      ownBranch: 'main',
      ownCommit: 'c1',
      target,
      targetHere: true,
      filesHere: true,
      blocked: undefined,
      ref: 'ancestor',
    });

    expect(decision.follow).toBe(true);
  });

  test('waits on staged work or an operation in progress', () => {
    const decision = branchFollow({
      ownBranch: 'main',
      ownCommit: 'c1',
      target,
      targetHere: true,
      filesHere: true,
      blocked: 'staged',
      ref: 'ancestor',
    });

    expect(decision).toEqual({ follow: false, reason: 'staged' });
  });

  test('waits when the target commit is not here', () => {
    const decision = branchFollow({
      ownBranch: 'main',
      ownCommit: 'c1',
      target,
      targetHere: false,
      filesHere: true,
      blocked: undefined,
      ref: 'ancestor',
    });

    expect(decision.reason).toBe('branch_target_not_here');
  });

  test('leaves a local branch that diverged', () => {
    const decision = branchFollow({
      ownBranch: 'main',
      ownCommit: 'c1',
      target,
      targetHere: true,
      filesHere: true,
      blocked: undefined,
      ref: 'other',
    });

    expect(decision.reason).toBe('branch_history_diverged');
  });

  test('waits for the files of the other branch', () => {
    const decision = branchFollow({
      ownBranch: 'main',
      ownCommit: 'c1',
      target,
      targetHere: true,
      filesHere: false,
      blocked: undefined,
      ref: 'missing',
    });

    expect(decision.reason).toBe('waiting_for_files');
  });
});

describe('divergence advice', () => {
  const sides: DivergedSide[] = [
    { machine: 'tapeo', ahead: 1, tip: 'a1' },
    { machine: 'hearth-vps', ahead: 3, tip: 's3' },
  ];

  test('resets the side with fewer commits onto the furthest tip', () => {
    expect(divergenceAdvice(sides)).toEqual({ machine: 'tapeo', resetTo: 's3' });
  });

  test('breaks ties by machine name', () => {
    const tied = divergenceAdvice([
      { machine: 'tapeo', ahead: 2, tip: 'a2' },
      { machine: 'hearth-vps', ahead: 2, tip: 's2' },
    ]);

    expect(tied).toEqual({ machine: 'hearth-vps', resetTo: 'a2' });
  });

  test('needs two sides', () => {
    expect(divergenceAdvice([sides[0] as DivergedSide])).toBeUndefined();
  });
});

describe('publishing', () => {
  test('publishes when origin does not have the commit', () => {
    expect(publishNeeded('c1', 'c0')).toBe(true);
    expect(publishNeeded('c1', '')).toBe(true);
  });

  test('does not publish when origin has it', () => {
    expect(publishNeeded('c1', 'c1')).toBe(false);
    expect(publishNeeded('', 'c1')).toBe(false);
  });
});
