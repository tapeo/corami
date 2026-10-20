import { describe, expect, test } from 'bun:test';

import {
  approvalOptions,
  approvalQuestion,
  dialogChoice,
  dialogCommand,
  graphicalEnv,
  hasDisplay,
  ruleArgv,
} from '@/core/exec-approval.ts';

const options = approvalOptions({ project: 'myapp', argv: ['flutter', 'build', 'ios'] });

describe('approvalOptions', () => {
  test('offers once, always on the subcommand, always on the program, everything for a while, and deny', () => {
    expect(options).toEqual([
      { label: 'Allow once', value: 'once' },
      { label: 'Always allow: flutter build *', value: 'subcommand' },
      { label: 'Always allow: flutter *', value: 'always' },
      { label: 'Allow everything in myapp for 15 minutes', value: 'grant' },
      { label: 'Deny', value: 'deny' },
    ]);
  });

  test('offers no subcommand for a single token', () => {
    const values = approvalOptions({ project: 'myapp', argv: ['xcodebuild'] }).map(
      (option) => option.value,
    );

    expect(values).toEqual(['once', 'always', 'grant', 'deny']);
  });

  test('offers only the exact command for a program that runs arbitrary code', () => {
    expect(approvalOptions({ project: 'myapp', argv: ['npx', 'something'] })).toEqual([
      { label: 'Allow once', value: 'once' },
      { label: 'Always allow this command', value: 'always' },
      { label: 'Allow everything in myapp for 15 minutes', value: 'grant' },
      { label: 'Deny', value: 'deny' },
    ]);
  });
});

describe('ruleArgv', () => {
  const argv = ['flutter', 'build', 'ios', '--release'];

  test('allows the subcommand and a star', () => {
    expect(ruleArgv(argv, 'subcommand')).toEqual(['flutter', 'build', '*']);
  });

  test('allows the program and a star', () => {
    expect(ruleArgv(argv, 'always')).toEqual(['flutter', '*']);
  });

  test('allows exactly the command of a program that runs arbitrary code', () => {
    const npx = ['npx', '-y', '@mobilenext/mobile-mcp@latest'];

    expect(ruleArgv(npx, 'always')).toEqual(npx);
    expect(ruleArgv(npx, 'subcommand')).toEqual(npx);
  });
});

describe('approvalQuestion', () => {
  test('shows the project and the command', () => {
    expect(approvalQuestion({ project: 'myapp', argv: ['flutter', 'devices'] })).toEqual([
      'The server asks to run, in myapp:',
      '  flutter devices',
    ]);
  });

  test('warns when the program runs arbitrary code', () => {
    const lines = approvalQuestion({ project: 'myapp', argv: ['npx', 'something'] });

    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('npx runs code of the project or of the network');
  });
});

describe('dialogCommand', () => {
  test('passes the text, the command and the labels to osascript as arguments, never inside the script', () => {
    const argv = ['flutter', 'build', '"x"', '\\', 'end'];
    const command = dialogCommand('osascript', { project: 'myapp', argv }, options);
    const script = command.slice(0, 5).join(' ');

    expect(command.slice(5)).toEqual([
      'The server asks to run, in myapp:',
      'flutter build "x" \\ end',
      'Allow once',
      'Always allow: flutter build *',
      'Always allow: flutter *',
      'Allow everything in myapp for 15 minutes',
      'Deny',
    ]);
    expect(script).not.toContain('flutter');
  });

  test('puts the command of osascript in a read-only field, with no default button', () => {
    const argv = ['bash', '-c', 'echo a\necho b'];
    const request = { project: 'myapp', argv };
    const command = dialogCommand('osascript', request, approvalOptions(request));

    expect(command[4]).toContain('setEditable(false)');
    expect(command[4]).toContain("setKeyEquivalent('')");
    expect(command[6]).toBe('bash -c echo a\\necho b');
    expect(command[5]).not.toContain('echo');
    expect(command[8]).toBe('Always allow this command');
  });

  test('turns off the markup of zenity and makes deny the default', () => {
    const command = dialogCommand('zenity', { project: 'myapp', argv: ['<b>x</b>'] }, options);

    expect(command).toContain('--no-markup');
    expect(command).toContain('--default-cancel');
    expect(command).toContain('--text=The server asks to run, in myapp:\n  <b>x</b>');
    expect(command).toContain('--ok-label=Allow once');
    expect(command).toContain('--cancel-label=Deny');
    expect(command.slice(-3)).toEqual([
      '--extra-button=Always allow: flutter build *',
      '--extra-button=Always allow: flutter *',
      '--extra-button=Allow everything in myapp for 15 minutes',
    ]);
  });
});

describe('dialogChoice', () => {
  test('reads the button of osascript', () => {
    expect(dialogChoice('osascript', 0, 'Allow once\n', options)).toBe('once');
    expect(dialogChoice('osascript', 0, 'Always allow: flutter build *\n', options)).toBe(
      'subcommand',
    );
    expect(dialogChoice('osascript', 0, 'Always allow: flutter *\n', options)).toBe('always');
    expect(
      dialogChoice('osascript', 0, 'Allow everything in myapp for 15 minutes\n', options),
    ).toBe('grant');
    expect(dialogChoice('osascript', 0, 'Deny\n', options)).toBe('deny');
  });

  test('gives no answer when osascript fails or the button is unknown', () => {
    expect(dialogChoice('osascript', 1, '', options)).toBeUndefined();
    expect(dialogChoice('osascript', 0, 'Other\n', options)).toBeUndefined();
  });

  test('reads the exit code and the extra button of zenity', () => {
    expect(dialogChoice('zenity', 0, '', options)).toBe('once');
    expect(dialogChoice('zenity', 1, 'Always allow: flutter build *\n', options)).toBe(
      'subcommand',
    );
    expect(dialogChoice('zenity', 1, 'Always allow: flutter *\n', options)).toBe('always');
    expect(dialogChoice('zenity', 1, 'Allow everything in myapp for 15 minutes\n', options)).toBe(
      'grant',
    );
    expect(dialogChoice('zenity', 1, '', options)).toBe('deny');
    expect(dialogChoice('zenity', 255, '', options)).toBeUndefined();
  });
});

describe('graphicalEnv', () => {
  test('keeps only the variables of the graphical session', () => {
    const environment = [
      'HOME=/home/me',
      'DISPLAY=:0',
      'WAYLAND_DISPLAY=wayland-0',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      'PATH=/usr/bin',
    ].join('\n');

    expect(graphicalEnv(environment)).toEqual({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });
});

describe('hasDisplay', () => {
  test('needs DISPLAY or WAYLAND_DISPLAY', () => {
    expect(hasDisplay({ DISPLAY: ':0' })).toBe(true);
    expect(hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(hasDisplay({ DISPLAY: '' })).toBe(false);
    expect(hasDisplay({})).toBe(false);
  });
});
