import { describe, expect, test } from 'bun:test';

import { sshdAcceptsPasswords, sshdKeysOnlyText, sshdValue } from '@/core/exec-sshd.ts';

describe('sshdAcceptsPasswords', () => {
  test('assumes the default of sshd when nothing says otherwise', () => {
    expect(sshdAcceptsPasswords('')).toBe(true);
  });

  test('is false only when both ways are off', () => {
    expect(
      sshdAcceptsPasswords(
        ['PasswordAuthentication no', 'KbdInteractiveAuthentication no'].join('\n'),
      ),
    ).toBe(false);
  });

  test('stays true when keyboard-interactive is on', () => {
    expect(
      sshdAcceptsPasswords(
        ['PasswordAuthentication no', 'KbdInteractiveAuthentication yes'].join('\n'),
      ),
    ).toBe(true);
  });

  test('reads the legacy name of keyboard-interactive', () => {
    expect(
      sshdAcceptsPasswords(
        ['PasswordAuthentication no', 'ChallengeResponseAuthentication yes'].join('\n'),
      ),
    ).toBe(true);
  });

  test('ignores comments and matches the name in any case', () => {
    const config = [
      '# PasswordAuthentication yes',
      'passwordauthentication NO',
      'KbdInteractiveAuthentication no',
    ].join('\n');
    expect(sshdAcceptsPasswords(config)).toBe(false);
  });

  test('takes the first directive as sshd does', () => {
    const config = [
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PasswordAuthentication yes',
      'KbdInteractiveAuthentication yes',
    ].join('\n');
    expect(sshdAcceptsPasswords(config)).toBe(false);
  });
});

describe('sshdValue', () => {
  test('reads a directive without its comment', () => {
    expect(sshdValue('Port 22 # the usual one', 'port')).toBe('22');
    expect(sshdValue('Include /etc/ssh/sshd_config.d/*.conf', 'include')).toBe(
      '/etc/ssh/sshd_config.d/*.conf',
    );
  });
});

describe('sshdKeysOnlyText', () => {
  test('turns off both ways in', () => {
    expect(sshdKeysOnlyText()).toBe('PasswordAuthentication no\nKbdInteractiveAuthentication no\n');
  });
});
