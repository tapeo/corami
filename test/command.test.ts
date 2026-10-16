import { describe, expect, test } from 'bun:test';

import { type CommandSpec, checkFlags } from '@/cli/command.ts';
import { parseArgs } from '@/cli/parser.ts';
import { CoramiError } from '@/core/errors.ts';
import { valueFlags } from '@/main.ts';

const spec: CommandSpec = {
  name: 'sync',
  summary: 'Synced local copy',
  usage: 'corami sync <project>',
  flags: [
    { name: 'path', value: 'folder', description: 'Path of the local copy' },
    { name: 'no-git', description: 'Do not give the new local copy its own .git' },
    { name: 'force', description: 'Proceeds even with conflicts' },
    { name: 'json', description: 'JSON output' },
  ],
  run: () => ({}),
};

function usageMessage(argv: string[]): string | undefined {
  try {
    checkFlags(spec, parseArgs(argv, { valueFlags: ['path'] }).values);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(CoramiError);
    expect((error as CoramiError).code).toBe('usage');
    return (error as CoramiError).message;
  }
}

describe('checkFlags', () => {
  test('accepts the declared flags, their negation and the global ones', () => {
    expect(usageMessage(['myapp', '--path', '/tmp/x', '--force', '--json', '--help'])).toBe(
      undefined,
    );
    expect(usageMessage(['myapp', '--no-git'])).toBe(undefined);
    expect(usageMessage(['myapp', '-f', '-p', '/tmp/x'])).toBe(undefined);
  });

  test('refuses a flag the command does not declare', () => {
    expect(usageMessage(['myapp', '--pth', '/tmp/x'])).toBe('Unknown flag for corami sync: --pth');
    expect(usageMessage(['myapp', '-x'])).toBe('Unknown flag for corami sync: -x');
  });

  test('refuses a value flag without its value', () => {
    expect(usageMessage(['myapp', '--path'])).toBe('Missing value for --path');
    expect(usageMessage(['myapp', '--path', '--force'])).toBe('Missing value for --path');
  });
});

describe('valueFlags', () => {
  test('includes the flags of setup git and project import', () => {
    const names = valueFlags();

    for (const name of ['provider', 'identity-name', 'identity-email', 'include', 'user']) {
      expect(names).toContain(name);
    }
  });
});
