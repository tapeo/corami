import { describe, expect, test } from 'bun:test';

import {
  alwaysArgv,
  approvalOptions,
  approvalQuestion,
  dialogChoice,
  dialogCommand,
  graphicalEnv,
  hasDisplay,
} from '@/core/exec-approval.ts';

const options = approvalOptions(['flutter', 'build', 'ios']);

describe('approvalOptions', () => {
  test('offers once, always on the program, and deny', () => {
    expect(options).toEqual([
      { label: 'Allow once', value: 'once' },
      { label: 'Always allow: flutter *', value: 'always' },
      { label: 'Deny', value: 'deny' },
    ]);
  });
});

describe('alwaysArgv', () => {
  test('allows the program and a star', () => {
    expect(alwaysArgv(['flutter', 'build', 'ios', '--release'])).toEqual(['flutter', '*']);
  });

  test('allows exactly the command of a program that runs arbitrary code', () => {
    const argv = ['npx', '-y', '@mobilenext/mobile-mcp@latest'];

    expect(alwaysArgv(argv)).toEqual(argv);
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
    const script = command.slice(0, 7).join(' ');

    expect(command.slice(7)).toEqual([
      'The server asks to run, in myapp:',
      'flutter build "x" \\ end',
      'Deny',
      'Always allow: flutter *',
      'Allow once',
    ]);
    expect(script).not.toContain('flutter');
  });

  test('puts the command of osascript in a one-line field', () => {
    const argv = ['bash', '-c', 'echo a\necho b'];
    const command = dialogCommand('osascript', { project: 'myapp', argv }, approvalOptions(argv));

    expect(command[4]).toContain('default answer (item 2 of argv)');
    expect(command[8]).toBe('bash -c echo a\\necho b');
    expect(command[7]).not.toContain('echo');
    expect(command[10]).toBe('Always allow this command');
  });

  test('turns off the markup of zenity', () => {
    const command = dialogCommand('zenity', { project: 'myapp', argv: ['<b>x</b>'] }, options);

    expect(command).toContain('--no-markup');
    expect(command).toContain('--text=The server asks to run, in myapp:\n  <b>x</b>');
    expect(command).toContain('--ok-label=Allow once');
    expect(command).toContain('--cancel-label=Deny');
    expect(command).toContain('--extra-button=Always allow: flutter *');
  });
});

describe('dialogChoice', () => {
  test('reads the button of osascript', () => {
    expect(dialogChoice('osascript', 0, 'Allow once\n', options)).toBe('once');
    expect(dialogChoice('osascript', 0, 'Always allow: flutter *\n', options)).toBe('always');
    expect(dialogChoice('osascript', 0, 'Deny\n', options)).toBe('deny');
  });

  test('gives no answer when osascript fails or the button is unknown', () => {
    expect(dialogChoice('osascript', 1, '', options)).toBeUndefined();
    expect(dialogChoice('osascript', 0, 'Other\n', options)).toBeUndefined();
  });

  test('reads the exit code and the extra button of zenity', () => {
    expect(dialogChoice('zenity', 0, '', options)).toBe('once');
    expect(dialogChoice('zenity', 1, 'Always allow: flutter *\n', options)).toBe('always');
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
