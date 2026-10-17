import { describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectsRootFor, serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { git } from '@/core/git.ts';
import { PORT_RANGE_START } from '@/core/ports.ts';
import {
  allocatePublicPort,
  planServeRules,
  previewUrl,
  projectForPath,
  validatePreviewName,
  validateTargetPort,
} from '@/core/previews.ts';
import { planProjectAdd, repositoryAt, sameRepository } from '@/core/project-add.ts';
import {
  isFolderEmpty,
  isWithin,
  localCopyTarget,
  projectOfCopy,
  serverFolderRemoval,
  unexpandedHome,
  withLocalCopies,
} from '@/core/projects.ts';

describe('allocatePublicPort', () => {
  test('starts at the first port of the range', () => {
    expect(allocatePublicPort([])).toBe(PORT_RANGE_START);
  });

  test('skips the ports already taken', () => {
    expect(allocatePublicPort([PORT_RANGE_START, PORT_RANGE_START + 1])).toBe(PORT_RANGE_START + 2);
  });

  test('fills the gaps', () => {
    expect(allocatePublicPort([PORT_RANGE_START, PORT_RANGE_START + 2])).toBe(PORT_RANGE_START + 1);
  });
});

describe('validateTargetPort', () => {
  test('accepts a normal dev server port', () => {
    expect(() => validateTargetPort(3000)).not.toThrow();
  });

  test('rejects the daemon port and the preview range', () => {
    expect(() => validateTargetPort(7420)).toThrow(CoramiError);
    expect(() => validateTargetPort(PORT_RANGE_START + 1)).toThrow(CoramiError);
  });

  test('rejects nonsense', () => {
    expect(() => validateTargetPort(0)).toThrow(CoramiError);
    expect(() => validateTargetPort(70_000)).toThrow(CoramiError);
    expect(() => validateTargetPort(Number.NaN)).toThrow(CoramiError);
  });
});

describe('validatePreviewName', () => {
  test('accepts letters, digits, dots, dashes and underscores', () => {
    expect(() => validatePreviewName('web')).not.toThrow();
    expect(() => validatePreviewName('web-2.staging_x')).not.toThrow();
  });

  test('rejects names with spaces or slashes', () => {
    expect(() => validatePreviewName('my web')).toThrow(CoramiError);
    expect(() => validatePreviewName('a/b')).toThrow(CoramiError);
  });
});

describe('previewUrl', () => {
  test('uses the MagicDNS name and the public port', () => {
    expect(previewUrl('corami.tail1a2b3c.ts.net', 4101)).toBe(
      'https://corami.tail1a2b3c.ts.net:4101',
    );
  });
});

describe('planServeRules', () => {
  test('creates the missing rules and removes the stale ones', () => {
    const plan = planServeRules([4100, 4102], [4100, 4101]);

    expect(plan.add).toEqual([4102]);
    expect(plan.remove).toEqual([4101]);
  });

  test('never touches rules outside the range', () => {
    const plan = planServeRules([4100], [4096, 7420, 4100]);

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  test('is empty when the rules already match', () => {
    const plan = planServeRules([4100, 4101], [4101, 4100]);

    expect(plan).toEqual({ add: [], remove: [] });
  });
});

describe('the projects of a server', () => {
  test('live directly in the home of the account that owns them', () => {
    expect(projectsRootFor('/home/corami')).toBe('/home/corami/projects');
  });

  test('a project keeps the POSIX path of the server, on every client', () => {
    expect(serverProjectPath('/home/corami', 'myapp')).toBe('/home/corami/projects/myapp');
    expect(serverProjectPath('~', 'myapp')).toBe('~/projects/myapp');
  });
});

describe('serverFolderRemoval', () => {
  const root = '/home/corami/projects';

  test('deletes a project folder inside the root', () => {
    expect(serverFolderRemoval('/home/corami/projects/myapp', root)).toBe('delete');
  });

  test('deletes a folder nested deeper', () => {
    expect(serverFolderRemoval('/home/corami/projects/team/myapp', root)).toBe('delete');
  });

  test('deletes the folder when the path has a trailing slash', () => {
    expect(serverFolderRemoval('/home/corami/projects/myapp/', root)).toBe('delete');
  });

  test('keeps the root itself', () => {
    expect(serverFolderRemoval(root, root)).toBe('keep');
    expect(serverFolderRemoval(`${root}/`, root)).toBe('keep');
  });

  test('keeps a folder outside the root', () => {
    expect(serverFolderRemoval('/home/corami/code/myapp', root)).toBe('keep');
  });

  test('keeps a sibling with a shared prefix', () => {
    expect(serverFolderRemoval('/home/corami/projects-old/myapp', root)).toBe('keep');
  });

  test('keeps a path that leaves the root with ..', () => {
    expect(serverFolderRemoval('/home/corami/projects/../secrets', root)).toBe('keep');
  });

  test('keeps a path that is not absolute', () => {
    expect(serverFolderRemoval('projects/myapp', root)).toBe('keep');
    expect(serverFolderRemoval('/home/corami/projects/myapp', 'projects')).toBe('keep');
  });
});

describe('isFolderEmpty', () => {
  test('tells an empty folder from one with something in it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'corami-empty-'));
    const sub = join(folder, 'sub');

    expect(isFolderEmpty(folder)).toBe(true);
    mkdirSync(sub);
    expect(isFolderEmpty(folder)).toBe(false);
    expect(isFolderEmpty(sub)).toBe(true);
    expect(isFolderEmpty(join(folder, 'missing'))).toBe(false);
  });
});

describe('localCopyTarget', () => {
  const fresh = { others: [], exists: false, empty: false };

  test('the session wins over the folder, and needs no --path', () => {
    const session = '/Users/me/dev/myapp';

    expect(localCopyTarget({ ...fresh, session, exists: true })).toBe('existing');
    expect(localCopyTarget({ ...fresh, session, requested: session })).toBe('existing');
  });

  test('refuses another folder for a copy that has a session', () => {
    expect(
      localCopyTarget({ ...fresh, session: '/Users/me/dev/myapp', requested: '/Users/me/myapp' }),
    ).toBe('move');
  });

  test('never guesses the folder without a session', () => {
    expect(localCopyTarget(fresh)).toBe('missing');
    expect(localCopyTarget({ ...fresh, exists: true, empty: true })).toBe('missing');
  });

  test('creates the copy when the folder asked is missing or empty', () => {
    const requested = '/Users/me/dev/myapp';

    expect(localCopyTarget({ ...fresh, requested })).toBe('create');
    expect(localCopyTarget({ ...fresh, requested, exists: true, empty: true })).toBe('create');
  });

  test('leaves a folder with something else in it alone', () => {
    expect(
      localCopyTarget({ ...fresh, requested: '/Users/me/dev/myapp', exists: true, empty: false }),
    ).toBe('not-empty');
  });

  test('refuses a folder inside the copy of another project, or around it', () => {
    const others = ['/Users/me/dev/site'];

    expect(localCopyTarget({ ...fresh, others, requested: '/Users/me/dev/site/myapp' })).toBe(
      'nested',
    );
    expect(localCopyTarget({ ...fresh, others, requested: '/Users/me/dev/site' })).toBe('nested');
    expect(localCopyTarget({ ...fresh, others, requested: '/Users/me/dev' })).toBe('nested');
    expect(localCopyTarget({ ...fresh, others, requested: '/Users/me/dev/site-2' })).toBe('create');
  });
});

describe('isWithin', () => {
  test('tells a folder inside another from a neighbour', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/a/b/..c', '/a/b')).toBe(true);
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
  });
});

describe('projectOfCopy', () => {
  const copies = [
    { project: 'site', local: '/Users/me/dev/site' },
    { project: 'docs', local: '/Users/me/dev/site/docs' },
  ];

  test('finds the copy that holds the folder, the deepest one first', () => {
    expect(projectOfCopy('/Users/me/dev/site', copies)).toBe('site');
    expect(projectOfCopy('/Users/me/dev/site/app', copies)).toBe('site');
    expect(projectOfCopy('/Users/me/dev/site/docs/guide', copies)).toBe('docs');
  });

  test('a neighbour folder is no copy', () => {
    expect(projectOfCopy('/Users/me/dev/site-2', copies)).toBeUndefined();
    expect(projectOfCopy('/Users/me/dev', copies)).toBeUndefined();
  });
});

describe('unexpandedHome', () => {
  test('flags a path the shell did not expand', () => {
    expect(unexpandedHome('~/dev/myapp')).toBe(true);
    expect(unexpandedHome('~')).toBe(true);
    expect(unexpandedHome('/Users/me/dev/myapp')).toBe(false);
    expect(unexpandedHome('dev/~myapp')).toBe(false);
  });
});

describe('withLocalCopies', () => {
  const projects = [
    { name: 'myapp', path: '/home/corami/projects/myapp' },
    { name: 'site', path: '/home/corami/projects/site' },
  ];

  test('gives every project the copy of this machine, or null', () => {
    const listed = withLocalCopies(projects, [
      { project: 'myapp', local: '/Users/me/corami/myapp' },
    ]);

    expect(listed.projects).toEqual([
      {
        name: 'myapp',
        path: '/home/corami/projects/myapp',
        local_copy: '/Users/me/corami/myapp',
      },
      { name: 'site', path: '/home/corami/projects/site', local_copy: null },
    ]);
    expect(listed.orphan_copies).toEqual([]);
  });

  test('reports the copies of a project that is not on the server', () => {
    const listed = withLocalCopies(projects, [
      { project: 'gone', local: '/Users/me/corami/gone' },
      { project: 'myapp', local: '/Users/me/corami/myapp' },
    ]);

    expect(listed.orphan_copies).toEqual([{ project: 'gone', local: '/Users/me/corami/gone' }]);
  });
});

describe('sameRepository', () => {
  test('reads one repository from the scp, ssh and https forms', () => {
    const ssh = 'git@github.com:me/myapp.git';

    expect(sameRepository(ssh, 'https://github.com/me/myapp')).toBe(true);
    expect(sameRepository(ssh, 'ssh://git@github.com/me/myapp')).toBe(true);
    expect(sameRepository(ssh, 'ssh://git@github.com:2222/me/myapp.git')).toBe(true);
    expect(sameRepository(ssh, 'https://GitHub.com/me/myapp/')).toBe(true);
    expect(sameRepository(ssh, 'https://me@github.com/me/myapp')).toBe(true);
    expect(sameRepository('github.com:me/myapp.git', ssh)).toBe(true);
  });

  test('tells apart another project, another host and another case', () => {
    const ssh = 'git@github.com:me/myapp.git';

    expect(sameRepository(ssh, 'git@github.com:me/other.git')).toBe(false);
    expect(sameRepository(ssh, 'git@gitlab.com:me/myapp.git')).toBe(false);
    // Two paths of a git server can differ by case: a false positive would
    // stop the command on a folder that is not the project.
    expect(sameRepository(ssh, 'git@github.com:me/MyApp.git')).toBe(false);
  });

  test('compares two local paths without a host', () => {
    expect(sameRepository('/srv/git/myapp.git', '/srv/git/myapp/')).toBe(true);
    expect(sameRepository('file:///srv/git/myapp.git', '/srv/git/myapp')).toBe(true);
    expect(sameRepository('/srv/git/myapp', '/srv/git/other')).toBe(false);
    expect(sameRepository('/srv/git/myapp', 'git@github.com:me/myapp.git')).toBe(false);
  });
});

describe('repositoryAt', () => {
  test('answers with the root of the clone, from a subfolder too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-repo-'));
    await git(root, ['init', '--quiet', '--initial-branch=main']);
    await git(root, ['remote', 'add', 'origin', 'git@github.com:me/myapp.git']);

    const sub = join(root, 'apps', 'web');
    mkdirSync(sub, { recursive: true });

    // git answers with the physical path: a temporary folder can be a link.
    expect(await repositoryAt(sub)).toEqual({
      root: realpathSync(root),
      origin: 'git@github.com:me/myapp.git',
    });
    expect(await repositoryAt(join(root, 'missing'))).toBeUndefined();
  });
});

describe('planProjectAdd', () => {
  const client = {
    role: 'client' as const,
    project: 'myapp',
    url: 'git@github.com:me/myapp.git',
    onServer: false,
  };

  test('lets a client add the project on the server', () => {
    expect(() => planProjectAdd(client)).not.toThrow();
  });

  test('refuses --path on a client, and takes it on the server', () => {
    const asClient = () => planProjectAdd({ ...client, url: undefined, path: '/srv/code/myapp' });

    expect(asClient).toThrow(CoramiError);

    try {
      asClient();
      expect.unreachable();
    } catch (error) {
      expect((error as CoramiError).fix).toContain('corami project import');
    }

    expect(() =>
      planProjectAdd({ ...client, role: 'server', url: undefined, path: '/srv/code/myapp' }),
    ).not.toThrow();
  });

  test('stops on a clone of the same url, naming the folder to import', () => {
    const cwdRepository = { root: '/Users/me/dev/myapp', origin: 'https://github.com/me/myapp' };

    expect(() => planProjectAdd({ ...client, cwdRepository })).toThrow(CoramiError);

    try {
      planProjectAdd({ ...client, cwdRepository, explicitName: 'shop' });
      expect.unreachable();
    } catch (error) {
      const fix = (error as CoramiError).fix ?? '';

      expect(fix).toContain('corami project import /Users/me/dev/myapp');
      expect(fix).toContain('--name shop');
    }
  });

  test('stops on the session of a project removed from the server', () => {
    const orphan = () => planProjectAdd({ ...client, session: '/Users/me/dev/myapp' });

    expect(orphan).toThrow(CoramiError);

    try {
      orphan();
      expect.unreachable();
    } catch (error) {
      expect((error as CoramiError).message).toContain('/Users/me/dev/myapp');
      expect((error as CoramiError).fix).toContain('corami sync stop myapp');
    }
  });

  test('leaves a session of a project still on the server to the server', () => {
    expect(() =>
      planProjectAdd({ ...client, session: '/Users/me/dev/myapp', onServer: true }),
    ).not.toThrow();
  });

  test('does nothing on a server or without a url', () => {
    const cwdRepository = { root: '/srv/myapp', origin: 'git@github.com:me/myapp.git' };

    expect(() => planProjectAdd({ ...client, role: 'server', cwdRepository })).not.toThrow();
    expect(() => planProjectAdd({ ...client, role: undefined, session: '/x' })).not.toThrow();
    expect(() => planProjectAdd({ ...client, url: undefined, session: '/x' })).not.toThrow();
  });

  test('a clone of another repository does not stop the command', () => {
    const cwdRepository = { root: '/Users/me/dev/other', origin: 'git@github.com:me/other.git' };

    expect(() => planProjectAdd({ ...client, cwdRepository })).not.toThrow();
  });
});

describe('projectForPath', () => {
  const projects = [
    { name: 'shop-app', path: '/root/projects/shop-app' },
    { name: 'other', path: '/root/projects/other' },
  ];

  test('finds the project that contains the folder', () => {
    expect(projectForPath('/root/projects/shop-app/apps/web', projects)).toBe('shop-app');
  });

  test('matches the root itself', () => {
    expect(projectForPath('/root/projects/other', projects)).toBe('other');
  });

  test('does not match a sibling with a shared prefix', () => {
    expect(projectForPath('/root/projects/shop-app-2', projects)).toBeUndefined();
  });

  test('returns nothing outside the projects', () => {
    expect(projectForPath('/tmp', projects)).toBeUndefined();
  });

  test('picks the longest path when one contains the other', () => {
    const nested = [
      { name: 'parent', path: '/srv/code' },
      { name: 'child', path: '/srv/code/app' },
    ];

    expect(projectForPath('/srv/code/app/web', nested)).toBe('child');
  });
});
