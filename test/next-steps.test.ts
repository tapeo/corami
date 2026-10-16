import { describe, expect, test } from 'bun:test';

import {
  afterClientSetup,
  afterImport,
  afterProjectAdd,
  afterServerSetup,
  afterSync,
  firstSteps,
} from '@/core/next-steps.ts';

const FQDN = 'corami.tail1a2b3c.ts.net';

describe('afterServerSetup', () => {
  test('sends root to the account that owns the projects', () => {
    const steps = afterServerSetup({ fqdn: FQDN, user: 'corami', root: true });

    expect(steps[0]).toBe(`Work as corami from now on: ssh corami@${FQDN}`);
    expect(steps[1]).toContain(`corami setup client ${FQDN}`);
    expect(steps[2]).toContain('corami project import <folder>');
  });

  test('says nothing about the account when the setup ran as the account', () => {
    const steps = afterServerSetup({ fqdn: FQDN, user: 'corami', root: false });

    expect(steps).toHaveLength(2);
    expect(steps.join('\n')).not.toContain('ssh corami@');
  });

  test('says nothing about the account when root owns the projects', () => {
    expect(afterServerSetup({ fqdn: FQDN, user: 'root', root: true })).toHaveLength(2);
  });
});

describe('afterClientSetup', () => {
  test('lists the sync of every project of the server', () => {
    expect(afterClientSetup(['myapp', 'site'])).toEqual([
      'corami sync add myapp',
      'corami sync add site',
    ]);
  });

  test('offers import and add when the server has no project', () => {
    const steps = afterClientSetup([]);

    expect(steps[0]).toContain('corami project import <folder>');
    expect(steps[1]).toContain('corami project add <git-url>');
  });

  test('falls back to the generic sync when the daemon did not answer', () => {
    expect(afterClientSetup(undefined)).toEqual([
      'corami sync add <project> to get the code of a project on this machine',
    ]);
  });
});

describe('afterProjectAdd', () => {
  test('on a client with a copy, it leads to the copy and to the preview', () => {
    const steps = afterProjectAdd('myapp', { role: 'client', local: '/Users/me/corami/myapp' });

    expect(steps[0]).toContain('Open /Users/me/corami/myapp');
    expect(steps[1]).toContain('from ~/projects/myapp');
  });

  test('on a client without a copy, it adds nothing', () => {
    expect(afterProjectAdd('myapp', { role: 'client' })).toEqual([]);
  });

  test('on the server, every client takes its copy', () => {
    expect(afterProjectAdd('myapp', { role: 'server' })[0]).toBe(
      'On each client: corami sync add myapp',
    );
    expect(afterProjectAdd('myapp', { role: undefined })[0]).toBe(
      'On each client: corami sync add myapp',
    );
  });

  test('the preview starts from the folder of the server', () => {
    const steps = afterProjectAdd('myapp', {
      role: 'server',
      serverPath: '/srv/manual/myapp',
    });

    expect(steps[1]).toContain('from /srv/manual/myapp');
  });
});

describe('afterSync and afterImport', () => {
  test('point to the local copy and to the preview', () => {
    const steps = afterSync('myapp', '/Users/me/corami/myapp');

    expect(steps[0]).toContain('Open /Users/me/corami/myapp');
    expect(steps[1]).toContain('corami serve <port> from ~/projects/myapp');
    expect(afterImport('myapp')).toEqual([steps[1] ?? '']);
  });

  test('both take the folder of the project on the server', () => {
    expect(afterSync('myapp', '/Users/me/corami/myapp', '/srv/code/myapp')[1]).toContain(
      'from /srv/code/myapp',
    );
    expect(afterImport('myapp', '/srv/code/myapp')[0]).toContain('from /srv/code/myapp');
  });
});

describe('firstSteps', () => {
  test('follows the role of the machine', () => {
    expect(firstSteps(undefined)).toEqual([
      'corami setup to make this machine the server or a client',
    ]);
    expect(firstSteps('server')[0]).toContain('corami project add <git-url>');
    expect(firstSteps('client')[0]).toContain('corami sync add <project>');
  });
});
