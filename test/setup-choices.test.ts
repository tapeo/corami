import { describe, expect, test } from 'bun:test';

import {
  defaultRole,
  isTailnetOnlyFirewall,
  parseChoice,
  parseYesNo,
  proposedOwner,
  roleChoices,
  serverCandidates,
} from '@/core/setup-choices.ts';
import { readPeers, readSelfLogin } from '@/integrations/tailscale.ts';

const STATUS = {
  Self: { UserID: 42, DNSName: 'corami.tail1a2b3c.ts.net.', OS: 'linux', Online: true },
  User: { '42': { ID: 42, LoginName: 'me@example.com' } },
  Peer: {
    a: { DNSName: 'phone.tail1a2b3c.ts.net.', HostName: 'localhost', OS: 'iOS', Online: true },
    b: { DNSName: 'build.tail1a2b3c.ts.net.', HostName: 'build', OS: 'linux', Online: true },
    c: { DNSName: 'old.tail1a2b3c.ts.net.', HostName: 'old', OS: 'linux', Online: false },
    d: { DNSName: 'corami.tail1a2b3c.ts.net.', HostName: 'corami', OS: 'linux', Online: true },
  },
};

describe('setup roles', () => {
  test('offers the server only on Linux', () => {
    expect(roleChoices('linux')).toEqual(['server', 'client']);
    expect(roleChoices('darwin')).toEqual(['client']);
    expect(roleChoices('win32')).toEqual(['client']);
  });

  test('proposes the role already configured, else the server on Linux', () => {
    expect(defaultRole('linux', undefined)).toBe('server');
    expect(defaultRole('linux', 'client')).toBe('client');
    expect(defaultRole('darwin', undefined)).toBe('client');
    expect(defaultRole('darwin', 'server')).toBe('client');
  });
});

describe('server discovery', () => {
  test('reads the peers of the tailnet', () => {
    const peers = readPeers(STATUS);

    expect(peers).toHaveLength(4);
    expect(peers).toContainEqual({
      dnsName: 'build.tail1a2b3c.ts.net',
      hostName: 'build',
      os: 'linux',
      online: true,
    });
    expect(readPeers({})).toEqual([]);
  });

  test('keeps online Linux peers, the corami ones first', () => {
    expect(serverCandidates(readPeers(STATUS))).toEqual([
      'corami.tail1a2b3c.ts.net',
      'build.tail1a2b3c.ts.net',
    ]);
  });
});

describe('owner login', () => {
  test('reads the login that signed the machine in', () => {
    expect(readSelfLogin(STATUS)).toBe('me@example.com');
    expect(readSelfLogin({ Self: { UserID: 7 }, User: {} })).toBeUndefined();
    expect(readSelfLogin({})).toBeUndefined();
  });

  test('proposes no owner for a tagged node', () => {
    expect(proposedOwner('me@example.com')).toBe('me@example.com');
    expect(proposedOwner('tagged-devices')).toBeUndefined();
    expect(proposedOwner('')).toBeUndefined();
    expect(proposedOwner(undefined)).toBeUndefined();
  });
});

describe('firewall', () => {
  test('recognizes the tailnet only firewall', () => {
    const closed = [
      'Status: active',
      '',
      'To                         Action      From',
      '--                         ------      ----',
      'Anywhere on tailscale0     ALLOW       Anywhere',
    ].join('\n');

    expect(isTailnetOnlyFirewall(closed)).toBe(true);
    expect(isTailnetOnlyFirewall('Status: inactive')).toBe(false);
    expect(isTailnetOnlyFirewall('Status: active\n\n22/tcp  ALLOW  Anywhere')).toBe(false);
  });
});

describe('answers', () => {
  test('reads yes and no, with the default on an empty answer', () => {
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('  ', false)).toBe(false);
    expect(parseYesNo('Y', false)).toBe(true);
    expect(parseYesNo('yes', false)).toBe(true);
    expect(parseYesNo('n', true)).toBe(false);
    expect(parseYesNo('No', true)).toBe(false);
    expect(parseYesNo('maybe', true)).toBeUndefined();
  });

  test('reads a choice counted from 1', () => {
    expect(parseChoice('', 3, 1)).toBe(1);
    expect(parseChoice('1', 3, 0)).toBe(0);
    expect(parseChoice('3', 3, 0)).toBe(2);
    expect(parseChoice('4', 3, 0)).toBeUndefined();
    expect(parseChoice('0', 3, 0)).toBeUndefined();
    expect(parseChoice('two', 3, 0)).toBeUndefined();
  });
});
