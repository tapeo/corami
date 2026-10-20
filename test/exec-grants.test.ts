import { describe, expect, test } from 'bun:test';

import {
  activeGrant,
  activeGrants,
  addGrant,
  grantMinutesLeft,
  grantsFromJson,
  grantsJson,
  newGrant,
} from '@/core/exec-grants.ts';

const now = Date.parse('2026-10-20T20:00:00.000Z');

describe('newGrant', () => {
  test('lasts 15 minutes for one project', () => {
    expect(newGrant('myapp', now)).toEqual({
      project: 'myapp',
      until: '2026-10-20T20:15:00.000Z',
    });
  });
});

describe('activeGrant', () => {
  const grant = newGrant('myapp', now);

  test('covers its project until it expires', () => {
    expect(activeGrant([grant], 'myapp', now + 14 * 60_000)).toBe(grant);
    expect(activeGrant([grant], 'myapp', now + 15 * 60_000)).toBeUndefined();
  });

  test('ignores another project', () => {
    expect(activeGrant([grant], 'other', now)).toBeUndefined();
  });
});

describe('activeGrants', () => {
  test('drops the expired ones', () => {
    const old = newGrant('old', now - 20 * 60_000);
    const fresh = newGrant('myapp', now);

    expect(activeGrants([old, fresh], now)).toEqual([fresh]);
  });
});

describe('addGrant', () => {
  test('replaces the grant of the same project and drops the expired ones', () => {
    const old = newGrant('old', now - 20 * 60_000);
    const first = newGrant('myapp', now - 60_000);
    const other = newGrant('other', now);
    const second = newGrant('myapp', now);

    expect(addGrant([old, first, other], second, now)).toEqual([other, second]);
  });
});

describe('grantMinutesLeft', () => {
  test('rounds up and stops at zero', () => {
    const grant = newGrant('myapp', now);

    expect(grantMinutesLeft(grant, now + 30_000)).toBe(15);
    expect(grantMinutesLeft(grant, now + 20 * 60_000)).toBe(0);
  });
});

describe('grantsFromJson', () => {
  test('reads what grantsJson writes', () => {
    const grants = [newGrant('myapp', now)];

    expect(grantsFromJson(grantsJson(grants))).toEqual(grants);
  });

  test('gives no grant for broken JSON or a broken entry', () => {
    expect(grantsFromJson('{')).toEqual([]);
    expect(grantsFromJson(JSON.stringify({ project: 'myapp' }))).toEqual([]);
    expect(grantsFromJson(JSON.stringify([{ project: 'myapp', until: 'never' }]))).toEqual([]);
  });
});
