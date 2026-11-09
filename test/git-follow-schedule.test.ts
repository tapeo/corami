import { describe, expect, test } from 'bun:test';
import { type GitRelationStatus, notARepository } from '@/core/git-align.ts';
import {
  freshOriginSchedule,
  type GitOriginStatus,
  noteOriginActivity,
  ORIGIN_ACTIVE_MS,
  type OriginActivity,
  type OriginSchedule,
  originFetchDue,
  originIsOff,
  originRequestOpen,
} from '@/core/git-follow.ts';

const MINUTE = 60_000;

function activity(overrides: Partial<OriginActivity> = {}): OriginActivity {
  return { fingerprint: 'f1', dirtyChanges: 0, offOrigin: false, ...overrides };
}

function schedule(overrides: Partial<OriginSchedule> = {}): OriginSchedule {
  return { ...freshOriginSchedule(), lastFetchAt: 1, ...overrides };
}

function status(value: GitRelationStatus): GitOriginStatus {
  return {
    state: { ...notARepository(), commit: 'a'.repeat(40), branch: 'main' },
    upstream: 'origin/main',
    upstreamCommit: 'b'.repeat(40),
    status: value,
    reason: undefined,
    move: false,
    fetched: true,
    filesHere: true,
  };
}

describe('origin activity', () => {
  test('a first sample counts as activity', () => {
    const next = noteOriginActivity(freshOriginSchedule(), undefined, activity(), 1_000);

    expect(next.lastActiveAt).toBe(1_000);
  });

  test('the same fingerprint and change count keep the last activity', () => {
    const first = noteOriginActivity(freshOriginSchedule(), undefined, activity(), 1_000);
    const second = noteOriginActivity(first, activity(), activity(), 2_000);

    expect(second.lastActiveAt).toBe(1_000);
  });

  test('a new fingerprint, a new change count or a branch off origin are activity', () => {
    const first = noteOriginActivity(freshOriginSchedule(), undefined, activity(), 1_000);

    expect(
      noteOriginActivity(first, activity(), activity({ fingerprint: 'f2' }), 2_000).lastActiveAt,
    ).toBe(2_000);
    expect(
      noteOriginActivity(first, activity(), activity({ dirtyChanges: 3 }), 2_000).lastActiveAt,
    ).toBe(2_000);
    expect(
      noteOriginActivity(first, activity(), activity({ offOrigin: true }), 2_000).lastActiveAt,
    ).toBe(2_000);
  });

  test('a branch that stays off origin is not activity by itself', () => {
    const first = noteOriginActivity(
      freshOriginSchedule(),
      undefined,
      activity({ offOrigin: true }),
      1_000,
    );
    const second = noteOriginActivity(
      first,
      activity({ offOrigin: true }),
      activity({ offOrigin: true }),
      2_000,
    );

    expect(second.lastActiveAt).toBe(1_000);
    expect(second.offOrigin).toBe(true);
  });

  test('only ahead and behind count as off origin', () => {
    expect(originIsOff(status('ahead'))).toBe(true);
    expect(originIsOff(status('behind'))).toBe(true);
    expect(originIsOff(status('aligned'))).toBe(false);
    expect(originIsOff(status('diverged'))).toBe(false);
    expect(originIsOff(status('unknown'))).toBe(false);
  });
});

describe('origin fetch schedule', () => {
  test('a project nobody has fetched yet is due at once', () => {
    expect(originFetchDue(freshOriginSchedule(), 1_000)).toBe(true);
  });

  test('an active project is due every minute', () => {
    const now = 10 * MINUTE;
    const record = schedule({ lastFetchAt: now - ORIGIN_ACTIVE_MS, lastActiveAt: now });

    expect(originFetchDue(record, now)).toBe(true);
    expect(originFetchDue({ ...record, lastFetchAt: now - MINUTE + 1 }, now)).toBe(false);
  });

  test('a project idle for the whole window waits fifteen minutes', () => {
    const now = 100 * MINUTE;
    const record = schedule({ lastFetchAt: now - MINUTE, lastActiveAt: now - 31 * MINUTE });

    expect(originFetchDue(record, now)).toBe(false);
    expect(originFetchDue({ ...record, lastFetchAt: now - 15 * MINUTE }, now)).toBe(true);
  });

  test('the activity window is thirty minutes', () => {
    const now = 100 * MINUTE;

    expect(
      originFetchDue(
        schedule({ lastFetchAt: now - 2 * MINUTE, lastActiveAt: now - 30 * MINUTE }),
        now,
      ),
    ).toBe(false);
    expect(
      originFetchDue(
        schedule({ lastFetchAt: now - 2 * MINUTE, lastActiveAt: now - 29 * MINUTE }),
        now,
      ),
    ).toBe(true);
  });

  test('a branch off origin keeps the project active', () => {
    const now = 100 * MINUTE;
    const record = schedule({
      lastFetchAt: now - ORIGIN_ACTIVE_MS,
      lastActiveAt: now - 60 * MINUTE,
      offOrigin: true,
    });

    expect(originFetchDue(record, now)).toBe(true);
  });

  test('a request runs at the next turn whatever the schedule', () => {
    const now = 100 * MINUTE;
    const record = schedule({
      lastFetchAt: now - 1,
      lastActiveAt: now - 60 * MINUTE,
      requested: true,
    });

    expect(originFetchDue(record, now)).toBe(true);
  });
});

describe('origin request', () => {
  test('a failed fetch keeps a request open', () => {
    expect(originRequestOpen(true, { ...status('ahead'), fetched: false })).toBe(true);
  });

  test('a failed scheduled fetch does not become a request', () => {
    expect(originRequestOpen(false, { ...status('ahead'), fetched: false })).toBe(false);
  });

  test('a successful fetch closes the request', () => {
    expect(originRequestOpen(true, status('ahead'))).toBe(false);
  });
});
