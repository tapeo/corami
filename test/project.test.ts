import { Database } from 'bun:sqlite';
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
import {
  defaultServerPath,
  importStagingPath,
  isImportStagingFor,
  missingImportFolder,
  movableLocalFolder,
  orphanServerFolders,
  planProjectAdd,
  repositoryAt,
  sameRepository,
  serverFolderOverlaps,
  serverPathFrom,
  serverPathsOf,
  suggestedProjectName,
  takenServerFolder,
  validServerPath,
} from '@/core/project-add.ts';
import {
  isFolderEmpty,
  isWithin,
  localCopyTarget,
  projectOfCopy,
  serverFolderRemoval,
  syncName,
  unexpandedHome,
  validNewProjectName,
  validProjectName,
  withLocalCopies,
} from '@/core/projects.ts';
import { migrate } from '@/core/state.ts';

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
  const rule = (port: number, targetPort = port): { port: number; target: string } => ({
    port,
    target: `http://127.0.0.1:${targetPort}`,
  });

  test('applies the missing rules and removes the stale ones', () => {
    const plan = planServeRules([rule(4100), rule(4102)], [rule(4100), rule(4101)]);

    expect(plan.apply).toEqual([rule(4102)]);
    expect(plan.remove).toEqual([4101]);
  });

  test('applies a rule again when its target changed', () => {
    const plan = planServeRules([rule(4100, 3001)], [rule(4100, 3000)]);

    expect(plan.apply).toEqual([rule(4100, 3001)]);
    expect(plan.remove).toEqual([]);
  });

  test('never touches rules outside the range', () => {
    const plan = planServeRules([rule(4100)], [rule(4096), rule(7420), rule(4100)]);

    expect(plan.apply).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  test('is empty when the rules already match', () => {
    const plan = planServeRules([rule(4100), rule(4101)], [rule(4101), rule(4100)]);

    expect(plan).toEqual({ apply: [], remove: [] });
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

describe('the folder of a project on the server', () => {
  test('an import never writes into a folder another project holds, or around it', () => {
    const projects = [
      { name: 'web', path: '/home/corami/projects/web' },
      { name: 'api', path: '/home/corami/projects/api' },
    ];
    const folders = serverPathsOf(projects);

    expect(folders).toEqual(['/home/corami/projects/web', '/home/corami/projects/api']);
    expect(serverFolderOverlaps('/home/corami/projects/web', folders)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects/web/assets', folders)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects', folders)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects/notes', folders)).toBe(false);
    expect(serverFolderOverlaps('/home/corami/projects/web-2', folders)).toBe(false);
  });
});

describe('validProjectName', () => {
  test('accepts the names a project can have', () => {
    expect(validProjectName('myapp')).toBe(true);
    expect(validProjectName('my-app_2')).toBe(true);
    expect(validProjectName('app.v2')).toBe(true);
    expect(validProjectName('a')).toBe(true);
  });

  test('refuses a name that would be a path', () => {
    expect(validProjectName('a/../b')).toBe(false);
    expect(validProjectName('a/b')).toBe(false);
    expect(validProjectName('..')).toBe(false);
    expect(validProjectName('.')).toBe(false);
    expect(validProjectName('')).toBe(false);
    expect(validProjectName('-leading')).toBe(false);
    expect(validProjectName('a b')).toBe(false);
    expect(validProjectName('app\\other')).toBe(false);
  });

  test('accepts a name that exists, with a dot or an underscore', () => {
    expect(validProjectName('my_app')).toBe(true);
    expect(validProjectName('app.v2')).toBe(true);
  });
});

describe('validNewProjectName', () => {
  test('accepts what the sync engine can name a session', () => {
    expect(validNewProjectName('myapp')).toBe(true);
    expect(validNewProjectName('my-app-2')).toBe(true);
    expect(validNewProjectName('a')).toBe(true);
  });

  test('refuses a dot or an underscore, which the engine refuses too', () => {
    expect(validNewProjectName('my_app')).toBe(false);
    expect(validNewProjectName('app.v2')).toBe(false);
    expect(validNewProjectName('2app')).toBe(false);
    expect(validNewProjectName('')).toBe(false);
  });
});

describe('syncName', () => {
  test('turns the name of a folder into one the engine takes', () => {
    expect(syncName('my_app')).toBe('my-app');
    expect(syncName('app.v2')).toBe('app-v2');
    expect(syncName('my app')).toBe('my-app');
    expect(syncName('my--app')).toBe('my-app');
    expect(syncName('-my_app-')).toBe('my-app');
    expect(syncName('myapp')).toBe('myapp');
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

    expect(await repositoryAt(sub)).toEqual({
      root: realpathSync(root),
      origin: 'git@github.com:me/myapp.git',
    });
    expect(await repositoryAt(join(root, 'missing'))).toBeUndefined();
  });
});

describe('planProjectAdd', () => {
  const git = {
    role: 'client' as const,
    from: 'git' as const,
    project: 'myapp',
    url: 'git@github.com:me/myapp.git',
  };

  test('lets a client add the project from any source', () => {
    expect(() => planProjectAdd(git)).not.toThrow();
    expect(() => planProjectAdd({ ...git, from: 'local', url: undefined })).not.toThrow();
    expect(() => planProjectAdd({ ...git, from: 'server', url: undefined })).not.toThrow();
  });

  test('refuses to run where the copy of a project cannot live', () => {
    for (const role of ['server', undefined] as const) {
      expect(() => planProjectAdd({ ...git, role })).toThrow(CoramiError);
    }
  });

  test('stops on the name of a project already on the server, pointing at its copy', () => {
    const registeredPath = '/home/corami/projects/myapp';

    for (const from of ['git', 'local'] as const) {
      expect(() => planProjectAdd({ ...git, from, registeredPath })).toThrow(CoramiError);
    }

    try {
      planProjectAdd({ ...git, registeredPath, localPath: '/Users/me/dev/myapp' });
      expect.unreachable();
    } catch (error) {
      const fix = (error as CoramiError).fix ?? '';

      expect(fix).toContain('Move /Users/me/dev/myapp away if it has files');
      expect(fix).toContain('corami project add /Users/me/dev/myapp --from-server --name myapp');
    }
  });

  test('keeps the path of a registered project, whatever the default suggests', () => {
    const registeredPath = '/srv/code/myapp';
    const fromServer = { ...git, from: 'server' as const, url: undefined, registeredPath };

    expect(() => planProjectAdd(fromServer)).not.toThrow();
    expect(() => planProjectAdd({ ...fromServer, serverPath: registeredPath })).not.toThrow();
    expect(() => planProjectAdd({ ...fromServer, serverPath: '~/projects/myapp' })).toThrow(
      CoramiError,
    );
  });

  test('stops on a clone of the same url, naming the folder to move', () => {
    const cwdRepository = { root: '/Users/me/dev/myapp', origin: 'https://github.com/me/myapp' };

    expect(() => planProjectAdd({ ...git, cwdRepository })).toThrow(CoramiError);

    try {
      planProjectAdd({ ...git, cwdRepository, explicitName: 'shop' });
      expect.unreachable();
    } catch (error) {
      const fix = (error as CoramiError).fix ?? '';

      expect(fix).toContain('corami project add /Users/me/dev/myapp');
      expect(fix).toContain('--name shop');
    }
  });

  test('stops on the session of a project removed from the server', () => {
    const orphan = () => planProjectAdd({ ...git, session: '/Users/me/dev/myapp' });

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
      planProjectAdd({
        ...git,
        from: 'server',
        url: undefined,
        session: '/Users/me/dev/myapp',
        registeredPath: '/home/corami/projects/myapp',
      }),
    ).not.toThrow();
  });

  test('stops on the copy of a project still on the server, and says there is nothing to add', () => {
    const folder = '/Users/me/dev/myapp';
    const same = {
      ...git,
      registeredPath: '/home/corami/projects/myapp',
      session: folder,
      sessionIsFolder: true,
      localPath: folder,
    };

    for (const from of ['git', 'local'] as const) {
      expect(() =>
        planProjectAdd({ ...same, from, url: from === 'git' ? git.url : undefined }),
      ).toThrow(CoramiError);
    }

    try {
      planProjectAdd({ ...same, from: 'local', url: undefined });
      expect.unreachable();
    } catch (error) {
      const thrown = error as CoramiError;

      expect(thrown.message).toContain(`this folder is its copy: ${folder}`);
      expect(thrown.message).toContain('/home/corami/projects/myapp');
      expect(thrown.fix).toContain('corami sync status myapp');
      expect(thrown.fix).not.toContain('sync stop');
    }
  });

  test('stops on a project still on the server, naming the copy of this machine', () => {
    const copy = {
      ...git,
      registeredPath: '/home/corami/projects/myapp',
      session: '/Users/me/other/myapp',
      sessionIsFolder: false,
      localPath: '/Users/me/dev/myapp',
    };

    try {
      planProjectAdd(copy);
      expect.unreachable();
    } catch (error) {
      const thrown = error as CoramiError;

      expect(thrown.message).toContain('its copy on this machine is /Users/me/other/myapp');
      expect(thrown.fix).toContain('corami project add /Users/me/dev/myapp --name <other>');
    }
  });

  test('never calls the session of a project still on the server one of a removed project', () => {
    const registeredPath = '/home/corami/projects/myapp';

    for (const from of ['git', 'local'] as const) {
      for (const sessionIsFolder of [true, false]) {
        let thrown: CoramiError | undefined;

        try {
          planProjectAdd({
            ...git,
            from,
            url: from === 'git' ? git.url : undefined,
            registeredPath,
            session: '/Users/me/dev/myapp',
            sessionIsFolder,
          });
        } catch (error) {
          thrown = error as CoramiError;
        }

        expect(thrown?.code).toBe('usage');
        expect(thrown?.message).toContain(`is already on the server at ${registeredPath}`);
        expect(thrown?.message).not.toContain('removed from the server');
      }
    }
  });

  test('a clone of another repository does not stop the command', () => {
    const cwdRepository = { root: '/Users/me/dev/other', origin: 'git@github.com:me/other.git' };

    expect(() => planProjectAdd({ ...git, cwdRepository })).not.toThrow();
  });

  test('never moves the home folder of this machine to the server', () => {
    const local = { ...git, from: 'local' as const, url: undefined, home: '/Users/me' };

    expect(() => planProjectAdd({ ...local, localPath: '/Users/me' })).toThrow(CoramiError);
    expect(() => planProjectAdd({ ...local, localPath: '/Users/me/Downloads' })).not.toThrow();
    expect(() => planProjectAdd({ ...local, localPath: undefined })).not.toThrow();
    expect(() => planProjectAdd({ ...git, home: '/Users/me' })).not.toThrow();
  });
});

describe('the paths of an added project', () => {
  test('the folder of the server is absolute or starts with ~/', () => {
    expect(validServerPath('/srv/code/myapp')).toBe(true);
    expect(validServerPath('~/projects/myapp')).toBe(true);
    expect(validServerPath('~')).toBe(false);
    expect(validServerPath('~/')).toBe(false);
    expect(validServerPath('projects/myapp')).toBe(false);
    expect(validServerPath('../myapp')).toBe(false);
  });

  test('the ~/ of the server is the home it names', () => {
    expect(serverPathFrom('/home/corami', '~/projects/myapp')).toBe('/home/corami/projects/myapp');
    expect(serverPathFrom('/home/corami', '/srv/code/myapp')).toBe('/srv/code/myapp');
  });

  test('refuses a folder inside another project, or around it', () => {
    const others = ['/home/corami/projects/site'];

    expect(serverFolderOverlaps('/home/corami/projects/site/myapp', others)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects/site', others)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects', others)).toBe(true);
    expect(serverFolderOverlaps('/home/corami/projects/site-2', others)).toBe(false);
    expect(serverFolderOverlaps('/home/corami/projects/other', others)).toBe(false);
  });

  test('the project of the server goes to the projects folder of its home', () => {
    expect(defaultServerPath('myapp')).toBe('~/projects/myapp');
  });

  test('a folder to import that is not here says what takes it', () => {
    const missing = missingImportFolder({ given: 'myapp', project: 'myapp' });

    expect(missing.code).toBe('usage');
    expect(missing.message).toBe(
      'There is no folder myapp on this machine: there is nothing to import',
    );
    expect(missing.fix).toContain('corami project add myapp --from-git <url>');
    expect(missing.fix).toContain('corami project add myapp --from-server');

    const registered = missingImportFolder({
      given: 'myapp',
      project: 'myapp',
      registeredPath: '~/projects/myapp',
    });

    expect(registered.message).toContain('myapp is already on the server');
    expect(registered.fix).toBe(
      'corami project add myapp --from-server --name myapp takes its copy',
    );
  });

  test('the home of this machine is not a project', () => {
    expect(() => movableLocalFolder('/', '/Users/me')).toThrow(CoramiError);
    expect(() => movableLocalFolder('/Users/me', '/Users/me')).toThrow(CoramiError);
    expect(() => movableLocalFolder('/Users/me/', '/Users/me')).toThrow(CoramiError);
    expect(() => movableLocalFolder('/home', '/home/corami')).toThrow(CoramiError);
    expect(() => movableLocalFolder('/Users/me/dev/myapp', '/Users/me')).not.toThrow();
    expect(() => movableLocalFolder('/Users/metoo', '/Users/me')).not.toThrow();
  });

  test('the home of a Windows machine is read with the rules of Windows', () => {
    expect(() => movableLocalFolder('C:\\Users\\me', 'C:\\Users\\me', 'win32')).toThrow(
      CoramiError,
    );
    expect(() => movableLocalFolder('C:\\', 'C:\\Users\\me', 'win32')).toThrow(CoramiError);
    expect(() =>
      movableLocalFolder('C:\\Users\\me\\dev\\myapp', 'C:\\Users\\me', 'win32'),
    ).not.toThrow();
    expect(() => movableLocalFolder('C:\\Users\\metoo', 'C:\\Users\\me', 'win32')).not.toThrow();
  });

  test('the name to suggest comes from what the command already knows', () => {
    expect(suggestedProjectName({ url: 'git@github.com:me/myapp.git' })).toBe('myapp');
    expect(suggestedProjectName({ serverPath: '~/projects/other' })).toBe('other');
    expect(suggestedProjectName({ localPath: '/Users/me/dev/site/' })).toBe('site');
    expect(suggestedProjectName({ localPath: '/Users/me/dev/my_app' })).toBe('my-app');
    expect(suggestedProjectName({ url: 'git@github.com:me/app.v2.git' })).toBe('app-v2');
    expect(suggestedProjectName({ name: 'chosen', url: 'git@github.com:me/myapp.git' })).toBe(
      'chosen',
    );
    expect(suggestedProjectName({})).toBeUndefined();
  });
});

describe('the staging folder of an import', () => {
  test('sits next to the project, so the registration renames it on one filesystem', () => {
    expect(importStagingPath('/home/corami/projects/app', 'app', '20261018-232001')).toBe(
      '/home/corami/projects/.corami-import-app-20261018-232001',
    );
    expect(importStagingPath('/srv/code/app/', 'app', '20261018-232001')).toBe(
      '/srv/code/.corami-import-app-20261018-232001',
    );
  });

  test('a folder is the staging of an import only next to its project and with its name', () => {
    const project = '/home/corami/projects/app';
    const staging = '/home/corami/projects/.corami-import-app-20261018-232001';

    expect(isImportStagingFor(project, staging)).toBe(true);
    expect(isImportStagingFor(project, '/home/corami/projects/other')).toBe(false);
    expect(isImportStagingFor(project, '/home/corami/projects/.backup-app-1')).toBe(false);
    expect(isImportStagingFor(project, '/srv/code/.corami-import-app-1')).toBe(false);
    expect(isImportStagingFor(project, project)).toBe(false);
    expect(isImportStagingFor(project, '/home/corami/projects/.corami-import-')).toBe(false);
    expect(
      isImportStagingFor(project, '/home/corami/projects/../projects/.corami-import-app-1'),
    ).toBe(true);
  });

  test('a folder that matches the commit of this machine reads as an import that stopped', () => {
    const head = '3e9c949a1b2c3d4e5f60718293a4b5c6d7e8f901';
    const error = takenServerFolder({
      serverPath: '/home/corami/projects/app',
      folder: '/Users/me/projects/app',
      remoteHead: head,
      localHead: head,
    });

    expect(error.code).toBe('usage');
    expect(error.message).toBe(
      'The folder /home/corami/projects/app is on the server, at the same commit as /Users/me/projects/app, and no project names it: an import that stopped probably left it',
    );
    expect(error.fix).toContain(
      'corami project add /Users/me/projects/app --from-server --server-path /home/corami/projects/app',
    );
    expect(error.fix).not.toContain('~/');
  });

  test('a repository with another history, and a folder that is not one', () => {
    const other = takenServerFolder({
      serverPath: '/home/corami/projects/app',
      folder: '/Users/me/projects/app',
      remoteHead: 'aaaa',
      localHead: 'bbbb',
    });

    expect(other.message).toBe(
      'The folder /home/corami/projects/app is on the server, a git repository that no project names',
    );
    expect(other.fix).toContain('--from-server --server-path /home/corami/projects/app');

    const folder = takenServerFolder({
      serverPath: '/home/corami/projects/app',
      folder: 'app',
    });

    expect(folder.message).toBe(
      'The folder /home/corami/projects/app is already on the server and is not empty',
    );
    expect(folder.fix).toContain('--server-path');
  });
});

describe('the folders of the projects root that no project uses', () => {
  test('says which ones are leftovers of an import', () => {
    const root = '/home/corami/projects';
    const orphans = orphanServerFolders(
      [
        `${root}/app`,
        `${root}/app/notes`,
        `${root}/old`,
        `${root}/.hidden`,
        `${root}/.corami-import-app-20261018-232001`,
        `${root}/.corami-import-`,
      ],
      [`${root}/app`],
    );

    expect(orphans.unregistered).toEqual([`${root}/old`]);
    expect(orphans.staging).toEqual([`${root}/.corami-import-app-20261018-232001`]);
  });
});

describe('the registry written before `owned`', () => {
  test('fills the column with the rule of the day: inside the root, Corami made it', () => {
    const home = '/home/corami';
    const previous = process.env.HOME;
    process.env.HOME = home;

    try {
      const target = new Database(':memory:');
      target.exec(
        'CREATE TABLE projects (name TEXT PRIMARY KEY, path TEXT NOT NULL, repo_url TEXT, created_at TEXT NOT NULL)',
      );
      const insert = target.query(
        'INSERT INTO projects (name, path, repo_url, created_at) VALUES (?, ?, NULL, ?)',
      );

      insert.run('clone', `${home}/projects/clone`, 'now');
      insert.run('registered', '/srv/code/registered', 'now');

      migrate(target);

      const rows = target
        .query<{ name: string; owned: number }, []>(
          'SELECT name, owned FROM projects ORDER BY name',
        )
        .all();

      expect(rows).toEqual([
        { name: 'clone', owned: 1 },
        { name: 'registered', owned: 0 },
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
    }
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
