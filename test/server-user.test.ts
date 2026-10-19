import { describe, expect, test } from 'bun:test';

import {
  accountToLeaveTo,
  canSudo,
  DEFAULT_SERVER_USER,
  isValidServerUser,
  loginAccounts,
  ownerBinary,
  ownerOfServer,
  privilegedGroups,
  serverUser,
  stepIdentity,
} from '@/core/server-user.ts';

describe('server user name', () => {
  test('accepts a name that useradd can create', () => {
    expect(isValidServerUser(DEFAULT_SERVER_USER)).toBe(true);
    expect(isValidServerUser('me')).toBe(true);
    expect(isValidServerUser('dev_1')).toBe(true);
    expect(isValidServerUser('a'.repeat(32))).toBe(true);
  });

  test('rejects a name that carries something into a command line', () => {
    expect(isValidServerUser('')).toBe(false);
    expect(isValidServerUser('Foo')).toBe(false);
    expect(isValidServerUser('-dev')).toBe(false);
    expect(isValidServerUser('dev; rm -rf /')).toBe(false);
    expect(isValidServerUser('dev name')).toBe(false);
    expect(isValidServerUser('a'.repeat(33))).toBe(false);
  });

  test('rejects the accounts that already exist', () => {
    expect(isValidServerUser('root')).toBe(false);
    expect(isValidServerUser('daemon')).toBe(false);
    expect(isValidServerUser('www-data')).toBe(false);
    expect(isValidServerUser('sshd')).toBe(false);
  });
});

describe('step identities', () => {
  test('runs the machine steps as root and the account steps as the owner', () => {
    expect(stepIdentity('packages')).toBe('root');
    expect(stepIdentity('tailscale')).toBe('root');
    expect(stepIdentity('hosts')).toBe('root');
    expect(stepIdentity('user')).toBe('root');
    expect(stepIdentity('firewall')).toBe('root');
    expect(stepIdentity('daemon')).toBe('owner');
    expect(stepIdentity('git-watch')).toBe('owner');
    expect(stepIdentity('serve')).toBe('owner');
    expect(stepIdentity('summary')).toBe('owner');
  });
});

describe('the binary of the account', () => {
  test('is the copied one under the home of the account, never the one of root', () => {
    expect(ownerBinary('/home/corami')).toBe('/home/corami/.corami/bin/corami');
    expect(ownerBinary('/root')).toBe('/root/.corami/bin/corami');
  });
});

describe('the account to work with', () => {
  test('takes the first source that has one', () => {
    expect(serverUser({ flag: 'dev', configured: 'corami', announced: 'other' })).toBe('dev');
    expect(serverUser({ configured: 'corami', announced: 'other' })).toBe('corami');
    expect(serverUser({ announced: 'other' })).toBe('other');
    expect(serverUser({})).toBeUndefined();
  });

  test('ignores an empty answer', () => {
    expect(serverUser({ flag: '', configured: '' })).toBeUndefined();
  });
});

describe('the account that owns the server', () => {
  test('is the one of the configuration, never root', () => {
    expect(ownerOfServer({ role: 'server', server_user: 'corami' })).toBe('corami');
    expect(ownerOfServer({ role: 'server', server_user: 'root' })).toBeUndefined();
    expect(ownerOfServer({ role: 'server' })).toBeUndefined();
    expect(ownerOfServer({ role: 'client', server_user: 'corami' })).toBeUndefined();
    expect(ownerOfServer(undefined)).toBeUndefined();
  });
});

describe('privileges of the owner account', () => {
  test('reports the groups that lead back to root', () => {
    expect(privilegedGroups('corami sudo')).toEqual(['sudo']);
    expect(privilegedGroups('corami docker adm')).toEqual(['docker', 'adm']);
    expect(privilegedGroups('corami')).toEqual([]);
    expect(privilegedGroups('')).toEqual([]);
  });

  test('reads a sudo listing', () => {
    const allowed = [
      'Matching Defaults entries for corami on corami:',
      '    env_reset, mail_badpass',
      '',
      'User corami may run the following commands on corami:',
      '    (ALL : ALL) ALL',
    ].join('\n');

    expect(canSudo(allowed)).toBe(true);
    expect(canSudo('User corami is not allowed to run sudo on corami.')).toBe(false);
    expect(canSudo('')).toBe(false);
  });
});

describe('commands that have to leave root', () => {
  const server = { role: 'server', server_user: 'corami' };

  test('leaves the commands of a server to the account that owns the projects', () => {
    expect(accountToLeaveTo({ platform: 'linux', user: 'root', config: server })).toBe('corami');
  });

  test('stays put when there is nothing to hand over', () => {
    expect(
      accountToLeaveTo({ platform: 'linux', user: 'root', config: undefined }),
    ).toBeUndefined();
    expect(
      accountToLeaveTo({ platform: 'linux', user: 'root', config: { role: 'client' } }),
    ).toBeUndefined();
    expect(
      accountToLeaveTo({ platform: 'linux', user: 'root', config: { role: 'server' } }),
    ).toBeUndefined();
    expect(accountToLeaveTo({ platform: 'linux', user: 'corami', config: server })).toBeUndefined();
    expect(accountToLeaveTo({ platform: 'darwin', user: 'root', config: server })).toBeUndefined();
  });
});

describe('the accounts someone can log in as', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash',
    'corami:x:1001:1001::/home/corami:/bin/bash',
    'backup:x:1002:1002::/home/backup:/usr/sbin/nologin',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
    '',
  ].join('\n');

  test('keeps the accounts of people with a shell that opens a session', () => {
    expect(loginAccounts(passwd)).toEqual(['ubuntu', 'corami']);
  });

  test('leaves out root, the system accounts and the shells of no session', () => {
    const names = loginAccounts(passwd);

    expect(names).not.toContain('root');
    expect(names).not.toContain('daemon');
    expect(names).not.toContain('backup');
    expect(names).not.toContain('nobody');
  });

  test('read nothing from a passwd that is empty or broken', () => {
    expect(loginAccounts('')).toEqual([]);
    expect(loginAccounts('corami:x:notanumber:1001::/home/corami:/bin/bash')).toEqual([]);
  });
});
