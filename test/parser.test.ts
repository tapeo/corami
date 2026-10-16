import { describe, expect, test } from 'bun:test';

import {
  booleanFlag,
  parseArgs,
  requirePositional,
  stringFlag,
  stringListFlag,
} from '@/cli/parser.ts';
import { CoramiError } from '@/core/errors.ts';

describe('parseArgs', () => {
  test('collects positionals', () => {
    const args = parseArgs(['build', 'android', 'extra']);
    expect(args.positionals).toEqual(['build', 'android', 'extra']);
  });

  test('reads a long flag with a value', () => {
    const args = parseArgs(['--name', 'shop-app'], { valueFlags: ['name'] });
    expect(stringFlag(args, 'name')).toBe('shop-app');
  });

  test('reads a long flag with equals', () => {
    const args = parseArgs(['--name=shop-app']);
    expect(stringFlag(args, 'name')).toBe('shop-app');
  });

  test('treats a standalone flag as true', () => {
    const args = parseArgs(['--dry-run']);
    expect(booleanFlag(args, 'dry-run')).toBe(true);
  });

  test('reads --no- as false', () => {
    const args = parseArgs(['--no-color']);
    expect(args.values.color).toBe(false);
  });

  test('expands short flags to long names', () => {
    const args = parseArgs(['-y']);
    expect(booleanFlag(args, 'yes')).toBe(true);
  });

  test('collects repeated flags', () => {
    const args = parseArgs(['--include', 'a', '--include', 'b'], { valueFlags: ['include'] });
    expect(stringListFlag(args, 'include')).toEqual(['a', 'b']);
  });

  test('collects repeated flags written with equals', () => {
    const args = parseArgs(['--include=a', '--include=b']);
    expect(stringListFlag(args, 'include')).toEqual(['a', 'b']);
  });

  test('keeps everything after -- as rest', () => {
    const args = parseArgs(['sync', '--', 'a', '-b']);
    expect(args.positionals).toEqual(['sync']);
    expect(args.rest).toEqual(['a', '-b']);
  });

  test('does not consume the next token for an undeclared flag', () => {
    const args = parseArgs(['--json', 'doctor']);
    expect(booleanFlag(args, 'json')).toBe(true);
    expect(args.positionals).toEqual(['doctor']);
  });

  test('consumes the next token only for declared value flags', () => {
    const args = parseArgs(['--name', 'shop-app'], { valueFlags: ['name'] });
    expect(stringFlag(args, 'name')).toBe('shop-app');
    expect(args.positionals).toEqual([]);
  });
});

describe('requirePositional', () => {
  test('returns the value', () => {
    expect(requirePositional(parseArgs(['up', 'shop-app']), 1, 'project')).toBe('shop-app');
  });

  test('throws a usage error when missing', () => {
    try {
      requirePositional(parseArgs(['up']), 1, 'project');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CoramiError);
      expect((error as CoramiError).code).toBe('usage');
    }
  });
});
