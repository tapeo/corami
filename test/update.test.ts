import { describe, expect, test } from 'bun:test';

import { pendingSteps } from '@/cli/commands/update.ts';

function answer(checks: unknown[]): unknown {
  return { ok: true, data: { counts: {}, checks } };
}

describe('the steps after an update', () => {
  test('names the checks a client has to act on', () => {
    const steps = pendingSteps(
      answer([
        {
          id: 'mutagen.ignores',
          status: 'warn',
          summary: '9 sessions carry older exclusions',
          fix: 'corami sync refresh --all --keep-extra',
        },
        { id: 'mutagen.watch', status: 'ok', summary: 'Every session checks every 2 s' },
        { id: 'git.service', status: 'warn', summary: 'not running' },
        {
          id: 'exec.setup',
          status: 'warn',
          summary: 'the key is not restricted to the gate',
          fix: 'Run corami exec setup',
        },
      ]),
    );

    expect(steps).toEqual([
      {
        id: 'mutagen.ignores',
        summary: '9 sessions carry older exclusions',
        fix: 'corami sync refresh --all --keep-extra',
      },
      {
        id: 'exec.setup',
        summary: 'the key is not restricted to the gate',
        fix: 'Run corami exec setup',
      },
    ]);
  });

  test('nothing to do gives no steps', () => {
    expect(
      pendingSteps(answer([{ id: 'mutagen.ignores', status: 'ok', summary: 'current' }])),
    ).toEqual([]);
  });

  test('an answer that is not a doctor report gives no steps', () => {
    expect(pendingSteps(undefined)).toEqual([]);
    expect(pendingSteps({ ok: true, data: {} })).toEqual([]);
    expect(pendingSteps({ ok: true, data: { checks: [null, 'x', { id: 1 }] } })).toEqual([]);
  });
});
