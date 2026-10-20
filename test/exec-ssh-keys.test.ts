import { describe, expect, test } from 'bun:test';

import {
  authorizedKeyLine,
  execComment,
  findExecLine,
  knownHostsLine,
  withKnownHost,
  withoutExecLine,
} from '@/core/exec-ssh-keys.ts';

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@macbook';

describe('authorizedKeyLine', () => {
  test('locks the key to the gate', () => {
    const line = authorizedKeyLine({
      gateCommand: '/Users/me/.corami/bin/corami exec gate',
      publicKey: key,
      server: 'hearth-vps',
    });

    expect(line).toBe(
      'command="/Users/me/.corami/bin/corami exec gate" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample corami-exec:hearth-vps',
    );
  });

  test('escapes the quotes of the gate command', () => {
    const line = authorizedKeyLine({
      gateCommand: '"/opt/my corami/corami" exec gate',
      publicKey: key,
      server: 'hearth-vps',
    });

    expect(line.startsWith('command="\\"/opt/my corami/corami\\" exec gate" ')).toBe(true);
  });
});

describe('findExecLine', () => {
  test('finds the line of one server among the others', () => {
    const text = `${key}\n${authorizedKeyLine({ gateCommand: 'corami exec gate', publicKey: key, server: 'hearth-vps' })}\n`;

    expect(findExecLine(text, 'hearth-vps')?.includes('corami-exec:hearth-vps')).toBe(true);
    expect(findExecLine(text, 'other')).toBeUndefined();
  });
});

describe('withoutExecLine', () => {
  test('keeps the other keys and the file clean', () => {
    const gate = authorizedKeyLine({
      gateCommand: 'corami exec gate',
      publicKey: key,
      server: 'hearth-vps',
    });
    const text = `${key}\n${gate}\n`;

    expect(withoutExecLine(text, 'hearth-vps')).toBe(`${key}\n`);
    expect(withoutExecLine(gate, 'hearth-vps')).toBe('');
  });
});

describe('known_hosts', () => {
  test('writes the host with its key, without the comment', () => {
    expect(knownHostsLine('macbook.tail.ts.net', key)).toBe(
      'macbook.tail.ts.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample',
    );
  });

  test('replaces the old key of the same host', () => {
    const old = 'macbook.tail.ts.net ssh-ed25519 AAAAOld\n';
    const next = withKnownHost(old, 'macbook.tail.ts.net', key);

    expect(next).toBe(
      `macbook.tail.ts.net ${knownHostsLine('macbook.tail.ts.net', key).slice('macbook.tail.ts.net '.length)}\n`,
    );
  });
});

describe('execComment', () => {
  test('names the server', () => {
    expect(execComment('hearth-vps')).toBe('corami-exec:hearth-vps');
  });
});
