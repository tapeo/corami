import { describe, expect, test } from 'bun:test';

import { refreshMode, refreshTarget } from '@/cli/commands/sync-refresh.ts';
import { parseArgs } from '@/cli/parser.ts';

describe('the flags of a refresh', () => {
  test('no flag means the plain refresh', () => {
    expect(refreshMode(parseArgs([]))).toBe('plain');
  });

  test('reads --force and --keep-extra', () => {
    expect(refreshMode(parseArgs(['--force']))).toBe('force');
    expect(refreshMode(parseArgs(['--keep-extra']))).toBe('keep-extra');
  });

  test('--force and --keep-extra say opposite things', () => {
    expect(() => refreshMode(parseArgs(['--force', '--keep-extra']))).toThrow(/opposite things/);
  });

  test('--all takes no project', () => {
    expect(refreshTarget(parseArgs(['--all']))).toBe('all');
    expect(refreshTarget(parseArgs([]))).toBe('one');
    expect(refreshTarget(parseArgs(['myapp']))).toBe('one');
    expect(() => refreshTarget(parseArgs(['--all', 'myapp']))).toThrow(/takes no project/);
  });
});
