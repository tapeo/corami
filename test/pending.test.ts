import { describe, expect, test } from 'bun:test';

import { pendingExplanation } from '@/cli/exec-gate-run.ts';
import type { SyncSession } from '@/integrations/mutagen.ts';

const GB = 1024 * 1024 * 1024;

function session(overrides: Partial<SyncSession> = {}): SyncSession {
  return {
    name: 'corami-sorumi',
    project: 'sorumi',
    status: 'scanning',
    mode: 'two-way-safe',
    alpha: 'corami@vps:/home/corami/projects/sorumi',
    beta: '/Users/matteo/projects/sorumi',
    conflicts: [],
    lastError: undefined,
    localLinks: [],
    ignore: [],
    pollingInterval: 2,
    serverHost: 'vps',
    serverUser: 'corami',
    serverPath: '/home/corami/projects/sorumi',
    ...overrides,
  };
}

describe('the reason of a pending sync', () => {
  test('names the state of the session when nothing is heavy', () => {
    const reason = pendingExplanation('sorumi', 'tapeo', session(), []);

    expect(reason.message).toBe(
      'The sync of sorumi on tapeo is not up to date: Scanning the files',
    );
    expect(reason.fix).toBe('On tapeo, run corami sync status');
  });

  test('names the heavy folder and the way out', () => {
    const reason = pendingExplanation('sorumi', 'tapeo', session(), [
      { path: '.build/CompilationCache.noindex', kind: 'dir', bytes: 38 * GB },
    ]);

    expect(reason.message).toContain('.build/CompilationCache.noindex/ is 38 GB');
    expect(reason.fix).toContain('Add .build/CompilationCache.noindex/ to .coramiignore');
    expect(reason.fix).toContain('corami sync refresh sorumi');
  });

  test('names a single heavy file without the trailing slash', () => {
    const reason = pendingExplanation('sorumi', 'tapeo', session(), [
      { path: 'assets/demo.mov', kind: 'file', bytes: 2 * GB },
    ]);

    expect(reason.message).toContain('assets/demo.mov is 2.0 GB');
  });

  test('counts the other heavy entries', () => {
    const reason = pendingExplanation('sorumi', 'tapeo', session(), [
      { path: 'a', kind: 'dir', bytes: 3 * GB },
      { path: 'b', kind: 'dir', bytes: 2 * GB },
    ]);

    expect(reason.message).toContain('and 1 more');
  });

  test('says when the session has conflicts', () => {
    const reason = pendingExplanation(
      'sorumi',
      'tapeo',
      session({ status: 'watching', conflicts: ['Sources/App.swift'] }),
      [],
    );

    expect(reason.message).toContain('1 conflicts to resolve');
  });

  test('says when the last error is what stops it', () => {
    const reason = pendingExplanation(
      'sorumi',
      'tapeo',
      session({ lastError: 'connection lost\nno route' }),
      [],
    );

    expect(reason.message).toContain('Retrying: connection lost');
  });

  test('works without a session', () => {
    const reason = pendingExplanation('sorumi', 'tapeo', undefined, []);

    expect(reason.message).toBe(
      'The sync of sorumi on tapeo is not up to date: the command did not start',
    );
  });
});
