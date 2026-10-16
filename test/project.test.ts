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
import { isFolderEmpty, localCopyTarget, serverFolderRemoval } from '@/core/projects.ts';

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
  test('an existing session wins over the folder', () => {
    expect(localCopyTarget({ session: true, exists: true, empty: false })).toBe('existing');
  });

  test('creates the copy when the folder is missing or empty', () => {
    expect(localCopyTarget({ session: false, exists: false, empty: true })).toBe('create');
    expect(localCopyTarget({ session: false, exists: true, empty: true })).toBe('create');
  });

  test('leaves a folder with something else in it alone', () => {
    expect(localCopyTarget({ session: false, exists: true, empty: false })).toBe('not-empty');
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
    url: 'git@github.com:me/myapp.git',
    noSync: false,
    session: false,
    target: { exists: false, empty: true },
  };

  test('creates the copy on a client, in a folder that is missing or empty', () => {
    expect(planProjectAdd(client)).toBe('create');
    expect(planProjectAdd({ ...client, target: { exists: true, empty: true } })).toBe('create');
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

    expect(
      planProjectAdd({ ...client, role: 'server', url: undefined, path: '/srv/code/myapp' }),
    ).toBe('skipped');
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

  test('the clone check runs also with --no-sync', () => {
    const cwdRepository = { root: '/Users/me/dev/myapp', origin: 'git@github.com:me/myapp.git' };

    expect(() => planProjectAdd({ ...client, noSync: true, cwdRepository })).toThrow(CoramiError);
  });

  test('leaves the orphan session alone instead of reusing it', () => {
    expect(planProjectAdd({ ...client, session: true })).toBe('orphan-session');
  });

  test('does not sync into a folder with something else in it', () => {
    expect(planProjectAdd({ ...client, target: { exists: true, empty: false } })).toBe(
      'target-not-empty',
    );
  });

  test('does nothing on a server, with --no-sync or without a url', () => {
    expect(planProjectAdd({ ...client, role: 'server' })).toBe('skipped');
    expect(planProjectAdd({ ...client, role: undefined })).toBe('skipped');
    expect(planProjectAdd({ ...client, noSync: true })).toBe('skipped');
    expect(planProjectAdd({ ...client, url: undefined })).toBe('skipped');
  });

  test('a clone of another repository does not stop the command', () => {
    const cwdRepository = { root: '/Users/me/dev/other', origin: 'git@github.com:me/other.git' };

    expect(planProjectAdd({ ...client, cwdRepository })).toBe('create');
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
