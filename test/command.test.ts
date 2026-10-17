import { describe, expect, test } from 'bun:test';

import {
  type ActionSpec,
  allSpecs,
  type CommandSpec,
  checkFlags,
  helpData,
  missingAction,
  overview,
  overviewData,
  resolveAction,
  usageFor,
} from '@/cli/command.ts';
import { allCommands } from '@/cli/commands/index.ts';
import { parseArgs } from '@/cli/parser.ts';
import { switchUserFix } from '@/cli/router.ts';
import { CoramiError } from '@/core/errors.ts';
import { valueFlags } from '@/main.ts';

const prune: ActionSpec = {
  name: 'prune',
  summary: 'Removes the copies idle for a while',
  usage: 'corami sync prune --unused <duration>',
  flags: [
    { name: 'unused', value: 'duration', description: 'Only copies idle for longer than this' },
    { name: 'yes', description: 'Confirm the removal' },
  ],
  run: () => ({}),
};

const status: ActionSpec = {
  name: 'status',
  summary: 'Shows the state of the sync',
  usage: 'corami sync status [<project>]',
  run: () => ({}),
};

const spec: CommandSpec = {
  name: 'sync',
  summary: 'Synced local copy',
  usage: 'corami sync add <project>',
  flags: [
    { name: 'path', value: 'folder', description: 'Path of the local copy' },
    { name: 'no-git', description: 'Do not give the new local copy its own .git' },
    { name: 'force', description: 'Proceeds even with conflicts' },
  ],
  actions: [status, prune],
  run: () => ({}),
};

function usageMessage(
  argv: string[],
  target: CommandSpec | ActionSpec = spec,
  path = 'sync',
): string | undefined {
  try {
    checkFlags(target, parseArgs(argv, { valueFlags: ['path', 'unused'] }).values, path);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(CoramiError);
    expect((error as CoramiError).code).toBe('usage');
    return (error as CoramiError).message;
  }
}

describe('resolveAction', () => {
  test('finds the action named by the first argument', () => {
    expect(resolveAction(spec, ['prune', '--unused', '30d'])).toBe(prune);
    expect(resolveAction(spec, ['status', 'myapp'])).toBe(status);
  });

  test('leaves to the command an argument that names no action', () => {
    expect(resolveAction(spec, ['myapp'])).toBeUndefined();
    expect(resolveAction(spec, [])).toBeUndefined();
    expect(resolveAction(spec, ['myapp', 'prune'])).toBeUndefined();
  });

  test('finds nothing in a command without actions', () => {
    const { actions: _, ...plain } = spec;
    expect(resolveAction(plain, ['prune'])).toBeUndefined();
  });
});

describe('missingAction', () => {
  test('names the actions of the command', () => {
    const missing = missingAction(spec, undefined);
    expect(missing.code).toBe('usage');
    expect(missing.message).toBe('Missing action for corami sync');
    expect(missing.fix).toBe('Use corami sync status or prune');
    expect(missingAction(spec, 'nope').message).toBe('Unknown action for corami sync: nope');
  });
});

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

  test('takes the flags of the action only', () => {
    expect(usageMessage(['--unused', '30d', '-y'], prune, 'sync prune')).toBe(undefined);
    expect(usageMessage(['--path', '/tmp/x'], prune, 'sync prune')).toBe(
      'Unknown flag for corami sync prune: --path',
    );
    expect(usageMessage(['--unused', '30d'])).toBe('Unknown flag for corami sync: --unused');
  });
});

describe('usageFor', () => {
  test('lists the actions of a command', () => {
    const text = usageFor(spec, 'sync');
    expect(text).toContain('Actions:');
    expect(text).toContain('  prune   Removes the copies idle for a while');
    expect(text).toContain('--path <folder>');
    expect(text).not.toContain('--unused');
  });

  test('shows the flags of an action only', () => {
    const text = usageFor(prune, 'sync prune');
    expect(text).toContain('Usage: corami sync prune --unused <duration>');
    expect(text).toContain('--unused <duration>');
    expect(text).not.toContain('--path');
    expect(text).not.toContain('Actions:');
  });

  test('ends with the global flags', () => {
    const text = usageFor(prune, 'sync prune');
    expect(text).toContain('Global flags:');
    expect(text).toMatch(/--json +JSON output/);
  });
});

describe('helpData', () => {
  test('gives the help of an action as data', () => {
    const help = helpData(prune, 'sync prune');
    expect(help.command).toBe('sync prune');
    expect(help.flags.map((flag) => flag.name)).toEqual(['unused', 'yes']);
    expect(help.actions).toEqual([]);
    expect(help.global_flags.map((flag) => flag.name)).toEqual(['json', 'help', 'version']);
  });

  test('names the actions of a command', () => {
    expect(helpData(spec, 'sync').actions.map((action) => action.name)).toEqual([
      'status',
      'prune',
    ]);
  });
});

describe('overviewData', () => {
  test('leaves the hidden commands out', () => {
    const hidden: CommandSpec = { ...spec, name: 'daemon', hidden: true };
    const names = overviewData([spec, hidden], '1.0.0').commands.map((command) => command.name);
    expect(names).toEqual(['sync']);
  });

  test('says what Corami is', () => {
    const lines = overview(overviewData([spec], '1.0.0')).split('\n');

    expect(lines[0]).toStartWith('Remote dev host for agents');
    expect(lines[2]).toBe('Commands:');
  });
});

describe('valueFlags', () => {
  test('includes the flags of setup git and project add', () => {
    const names = valueFlags();

    for (const name of ['provider', 'identity-name', 'identity-email', 'user']) {
      expect(names).toContain(name);
    }
  });

  // The arguments are read once for every command: a name that takes a value
  // somewhere and none elsewhere would eat the next argument of the second.
  test('gives each flag name one meaning across commands and actions', () => {
    const takesValue = new Map<string, boolean>();

    for (const item of allSpecs(allCommands())) {
      for (const flag of item.flags ?? []) {
        const seen = takesValue.get(flag.name);
        const current = flag.value !== undefined;

        expect({ flag: flag.name, takesValue: current }).toEqual({
          flag: flag.name,
          takesValue: seen ?? current,
        });
        takesValue.set(flag.name, current);
      }
    }
  });
});

describe('the remedy of a command run as root', () => {
  test('keeps the flags of the run', () => {
    const fix = switchUserFix('corami', ['serve', '3000', '--name', 'api']);

    expect(fix).toBe("Run it as that account: su - corami -c 'corami serve 3000 --name api'");
  });

  test('quotes an argument with a space as one word', () => {
    const fix = switchUserFix('corami', ['project', 'add', '--local-path', '/home/it/my app']);

    expect(fix).toContain("'corami project add --local-path /home/it/my app'");
  });
});
