import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { removalFix } from '@/cli/commands/sync-remove.ts';
import {
  CONFLICT_RESOLUTION,
  conflictCopies,
  conflictFix,
  conflictLabel,
  endpointPath,
} from '@/core/sync-conflicts.ts';

describe('conflict copies', () => {
  test('gives the local and the server path of each conflict', () => {
    const copies = conflictCopies({
      alpha: 'corami@vps:/home/corami/projects/myapp',
      beta: '/Users/me/corami/myapp',
      conflicts: ['app/page.tsx', 'docs/notes.md'],
    });

    expect(copies).toEqual([
      {
        path: 'app/page.tsx',
        local: join('/Users/me/corami/myapp', 'app/page.tsx'),
        server: '/home/corami/projects/myapp/app/page.tsx',
      },
      {
        path: 'docs/notes.md',
        local: join('/Users/me/corami/myapp', 'docs/notes.md'),
        server: '/home/corami/projects/myapp/docs/notes.md',
      },
    ]);
  });

  test('gives nothing without conflicts', () => {
    expect(conflictCopies({ alpha: 'vps:/srv/app', beta: '/tmp/app', conflicts: [] })).toEqual([]);
  });

  test('names the folder itself when the conflict is the root deletion', () => {
    expect(conflictLabel('')).toBe('the folder of the project itself');
    expect(conflictLabel('app/page.tsx')).toBe('app/page.tsx');
  });

  test('gets out of a root deletion without deleting the last copy', () => {
    const fix = conflictFix('myapp', ['']);

    expect(fix).toContain('corami sync stop myapp');
    expect(fix).toContain('corami project rm myapp --on client --force');
    expect(fix).not.toContain(CONFLICT_RESOLUTION);
    expect(conflictFix('myapp', ['app/page.tsx'])).toBe(CONFLICT_RESOLUTION);
  });

  test('reads the path of an endpoint with or without a host', () => {
    expect(endpointPath('corami@vps:/home/corami/projects/myapp')).toBe(
      '/home/corami/projects/myapp',
    );
    expect(endpointPath('vps:~/projects/myapp')).toBe('~/projects/myapp');
    expect(endpointPath('/Users/me/corami/myapp')).toBe('/Users/me/corami/myapp');
  });
});

describe('removal fix', () => {
  test('explains how to resolve conflicts without --force', () => {
    const fix = removalFix('myapp', 'conflicts');

    expect(fix).toContain('corami sync status myapp');
    expect(fix).toContain(CONFLICT_RESOLUTION);
    expect(fix).not.toContain('--force');
  });

  test('keeps the generic fix for the other checks', () => {
    expect(removalFix('myapp', 'local_only')).toBe(
      'Fix the reported items, or pass --force to remove it anyway',
    );
  });

  test('on a copy whose folder is gone, stop keeps it and --force removes it', () => {
    const fix = removalFix('myapp', 'conflicts', true);

    expect(fix).toContain('corami sync stop myapp');
    expect(fix).toContain('corami project rm myapp --on client --force');
    expect(fix).not.toContain(CONFLICT_RESOLUTION);
  });
});
