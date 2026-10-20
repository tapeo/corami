import { describe, expect, test } from 'bun:test';

import {
  authorizedKeyLine,
  execComment,
  execLineAddresses,
  findExecLine,
  knownHostsLine,
  withKnownHost,
  withoutExecLine,
} from '@/core/exec-ssh-keys.ts';

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@macbook';

describe('authorizedKeyLine', () => {
  test('locks the key to the gate and to the addresses of the server', () => {
    const line = authorizedKeyLine({
      gateCommand: '/Users/me/.corami/bin/corami exec gate',
      publicKey: key,
      server: 'hearth-vps',
      addresses: ['100.101.12.7', 'fd7a:115c:a1e0::1234'],
    });

    expect(line).toBe(
      'restrict,from="100.101.12.7,fd7a:115c:a1e0::1234",command="/Users/me/.corami/bin/corami exec gate" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample corami-exec:hearth-vps',
    );
  });

  test('leaves out from= when the server has no address', () => {
    const line = authorizedKeyLine({
      gateCommand: 'corami exec gate',
      publicKey: key,
      server: 'hearth-vps',
      addresses: [],
    });

    expect(line.startsWith('restrict,command=')).toBe(true);
  });
});

describe('findExecLine', () => {
  test('finds the line of one server among the others', () => {
    const text = `${key}\n${authorizedKeyLine({ gateCommand: 'corami exec gate', publicKey: key, server: 'hearth-vps', addresses: [] })}\n`;

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
      addresses: [],
    });
    const text = `${key}\n${gate}\n`;

    expect(withoutExecLine(text, 'hearth-vps')).toBe(`${key}\n`);
    expect(withoutExecLine(gate, 'hearth-vps')).toBe('');
  });
});

describe('execLineAddresses', () => {
  test('reads the addresses of from=', () => {
    const line = authorizedKeyLine({
      gateCommand: 'corami exec gate',
      publicKey: key,
      server: 'hearth-vps',
      addresses: ['100.101.12.7', '100.101.12.8'],
    });

    expect(execLineAddresses(line)).toEqual(['100.101.12.7', '100.101.12.8']);
  });

  test('gives nothing for a missing line', () => {
    expect(execLineAddresses(undefined)).toEqual([]);
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
