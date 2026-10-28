import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDuration, renderCandidates } from '@/cli/commands/sync.ts';
import { applyRemoval, planRemoval, type RemovalEngine } from '@/cli/commands/sync-remove.ts';
import { CoramiError } from '@/core/errors.ts';
import { directorySize, findLocalOnlyFiles, localGit } from '@/core/local-copy.ts';
import type { SyncSession } from '@/integrations/mutagen.ts';
import {
  collectConflicts,
  parseSessions,
  pollingCurrent,
  sessionName,
} from '@/integrations/mutagen.ts';

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  await child.exited;
}

describe('parseDuration', () => {
  test('reads minutes, hours and days', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  test('rejects unknown units', () => {
    expect(parseDuration('30y')).toBeUndefined();
    expect(parseDuration('nope')).toBeUndefined();
  });
});

describe('prune candidates', () => {
  const days = (count: number): string => new Date(Date.now() - count * 86_400_000).toISOString();

  test('lists the copies and asks for --yes', () => {
    const text = renderCandidates(
      [
        { project: 'old', local: '/Users/me/corami/old', bytes: 2048, lastActivity: days(40) },
        {
          project: 'used',
          local: '/Users/me/corami/used',
          bytes: 1024,
          lastActivity: days(30),
          blocked: 'local_only_files: .env.local',
        },
      ],
      false,
    );

    expect(text).toContain('old: /Users/me/corami/old (2 KB), last change 40 days ago');
    expect(text).toContain('blocked: local_only_files: .env.local');
    expect(text).toContain('No copy removed: run again with --yes to remove them.');
  });

  test('says nothing was removed with --dry-run', () => {
    const text = renderCandidates(
      [{ project: 'old', local: '/tmp/old', bytes: 10, lastActivity: days(40) }],
      true,
    );

    expect(text).toContain('No copy removed (--dry-run).');
  });

  test('handles an empty list', () => {
    expect(renderCandidates([], false)).toBe('No local copy idle for longer than --unused.');
  });
});

describe('local only files', () => {
  test('finds the files of this machine and skips regenerable folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'android'), { recursive: true });
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'android', 'local.properties'), 'sdk.dir=/opt/android');
    writeFileSync(join(root, '.env.local'), 'SECRET=1');
    writeFileSync(join(root, 'node_modules', '.env'), 'ignored');
    writeFileSync(join(root, 'app', 'page.tsx'), 'ok');

    const found = findLocalOnlyFiles(root);
    expect(found.map((entry) => entry.path)).toEqual(['android/local.properties']);
  });

  test('counts a link by its own size, never by what it points at', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    const outside = await mkdtemp(join(tmpdir(), 'corami-outside-'));

    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(10));
    writeFileSync(join(root, 'node_modules', 'big.js'), 'y'.repeat(1_000));
    writeFileSync(join(outside, 'huge.bin'), 'z'.repeat(10_000));
    symlinkSync(outside, join(root, 'pub-cache'));

    const found = findLocalOnlyFiles(root);

    expect(found.map((entry) => entry.path)).toEqual(['pub-cache']);
    expect(found[0]?.kind).toBe('link');
    expect(directorySize(root)).toBe(10 + Buffer.byteLength(outside));
  });

  test('reports every entry, not the first two hundred', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-many-'));
    for (let index = 0; index < 250; index += 1) {
      const android = join(root, 'apps', `app-${index}`, 'android');
      mkdirSync(android, { recursive: true });
      writeFileSync(join(android, 'local.properties'), 'sdk.dir=/opt');
    }

    expect(findLocalOnlyFiles(root, 1_000)).toHaveLength(250);
  });

  test('measures the size without counting regenerable folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-size-'));
    mkdirSync(join(root, '.next'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(100));
    writeFileSync(join(root, '.next', 'big.bin'), 'y'.repeat(10_000));

    expect(directorySize(root)).toBe(100);
  });
});

describe('local git', () => {
  test('reports nothing when the copy has no git directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-git-'));

    expect(await localGit(root)).toBeUndefined();
  });

  test('counts commits and stashes that nowhere else has', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-git-'));
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.email', 'a@a']);
    await git(root, ['config', 'user.name', 'a']);
    writeFileSync(join(root, 'f.txt'), 'one');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'one']);
    await git(root, ['stash', 'push', '-q', '-m', 'wip']);
    writeFileSync(join(root, 'f.txt'), 'two');
    await git(root, ['commit', '-qam', 'two']);

    const state = await localGit(root);
    expect(state?.branch).toBe('main');
    expect(state?.onlyLocal).toBe(2);
  });

  test('counts zero for a repository with no commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-git-'));
    await git(root, ['init', '-q', '-b', 'main']);

    const state = await localGit(root);
    expect(state?.branch).toBe('no commits');
    expect(state?.onlyLocal).toBe(0);
  });
});

describe('mutagen parsing', () => {
  const raw = JSON.stringify([
    {
      name: 'corami-next-demo',
      status: 'watching',
      mode: 'two-way-safe',
      alpha: { protocol: 'ssh', user: 'root', host: 'vps', path: '~/projects/next-demo' },
      beta: { protocol: 'local', path: '/Users/me/corami/next-demo' },
      conflicts: [
        {
          root: 'app/page.tsx',
          alphaChanges: [{ path: 'app/page.tsx', old: null, new: { kind: 'file' } }],
          betaChanges: [{ path: 'app/page.tsx', old: null, new: { kind: 'file' } }],
        },
      ],
    },
    { name: 'other-session', status: 'watching' },
  ]);

  test('keeps only our sessions', () => {
    const sessions = parseSessions(raw);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.project).toBe('next-demo');
  });

  test('describes the endpoints and conflicts', () => {
    const session = parseSessions(raw)[0];
    expect(session?.alpha).toBe('root@vps:~/projects/next-demo');
    expect(session?.beta).toBe('/Users/me/corami/next-demo');
    expect(session?.conflicts).toEqual(['app/page.tsx']);
  });

  test('reads the exclusions and the server endpoint', () => {
    const record = [
      {
        name: 'corami-demo',
        status: 'watching',
        alpha: { protocol: 'ssh', user: 'corami', host: 'vps', path: '/home/corami/projects/demo' },
        beta: { protocol: 'local', path: '/Users/me/demo' },
        ignore: { paths: ['node_modules/', '.build/'] },
      },
    ];

    const [session] = parseSessions(JSON.stringify(record));
    expect(session?.ignore).toEqual(['node_modules/', '.build/']);
    expect(session?.serverHost).toBe('vps');
    expect(session?.serverUser).toBe('corami');
    expect(session?.serverPath).toBe('/home/corami/projects/demo');
  });

  test('a session without exclusions has an empty list', () => {
    const record = [{ name: 'corami-demo', status: 'watching', alpha: {}, beta: {} }];
    const [session] = parseSessions(JSON.stringify(record));

    expect(session?.ignore).toEqual([]);
    expect(session?.serverHost).toBe('');
  });

  test('reads problems from the endpoints', () => {
    const record = { beta: { transitionProblems: ['cannot create root'] } };
    expect(collectConflicts(record)).toEqual([]);
  });

  test('names a link of this machine as such, not as a broken session', () => {
    const record = [
      {
        name: 'corami-demo',
        status: 'watching',
        alpha: { path: '/home/me/demo' },
        beta: {
          path: '/Users/me/demo',
          scanProblems: [
            { path: 'pub-cache', error: 'target is absolute' },
            { path: 'ios/flutter', error: 'target is absolute' },
          ],
        },
      },
    ];

    const [session] = parseSessions(JSON.stringify(record));
    expect(session?.localLinks).toEqual(['pub-cache', 'ios/flutter']);
    expect(session?.lastError).toBeUndefined();
  });

  test('keeps a problem that is not about a link', () => {
    const record = [
      {
        name: 'corami-demo',
        status: 'watching',
        alpha: { path: '/home/me/demo' },
        beta: {
          path: '/Users/me/demo',
          scanProblems: [{ path: 'dist', error: 'permission denied' }],
        },
      },
    ];

    const [session] = parseSessions(JSON.stringify(record));
    expect(session?.lastError).toContain('permission denied');
  });

  test('builds the session name', () => {
    expect(sessionName('demo')).toBe('corami-demo');
  });

  test('reads the watch polling interval of the session', () => {
    const record = [
      {
        name: 'corami-demo',
        status: 'watching',
        watch: { pollingInterval: 2 },
        alpha: {},
        beta: {},
      },
    ];
    const [session] = parseSessions(JSON.stringify(record));

    expect(session?.pollingInterval).toBe(2);
  });

  test('a session created without an interval polls at the Mutagen default', () => {
    const record = [{ name: 'corami-demo', status: 'watching', watch: {}, alpha: {}, beta: {} }];
    const [session] = parseSessions(JSON.stringify(record));

    expect(session?.pollingInterval).toBe(10);
  });
});

describe('removal checks', () => {
  const watching: SyncSession = {
    name: 'corami-demo',
    project: 'demo',
    status: 'watching',
    mode: 'two-way-safe',
    alpha: 'corami@vps:~/projects/demo',
    beta: '/tmp/copy',
    conflicts: [],
    lastError: undefined,
    localLinks: [],
    ignore: [],
    pollingInterval: 2,
    serverHost: 'vps',
    serverUser: 'corami',
    serverPath: '~/projects/demo',
  };

  function fakeEngine(session: SyncSession | undefined, failFlush = false): RemovalEngine {
    return {
      status: async () => session,
      flush: async () => {
        if (failFlush) {
          throw new CoramiError({ code: 'sync_pending', message: 'flush failed' });
        }
      },
      terminate: async () => undefined,
    };
  }

  test('a session at the old watch interval is not current', () => {
    expect(pollingCurrent(watching)).toBe(true);
    expect(pollingCurrent({ ...watching, pollingInterval: 10 })).toBe(false);
  });

  test('an unflushed copy is blocked before anything is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-removal-'));

    const plan = await planRemoval(
      { project: 'demo', localPath: root },
      fakeEngine(watching, true),
    );

    expect(plan.checks.some((check) => check.status === 'blocked')).toBe(true);
    const error = await applyRemoval(plan, false, fakeEngine(watching)).catch((caught) => caught);

    expect(error).toBeInstanceOf(CoramiError);
    expect((error as CoramiError).code).toBe('sync_pending');
    expect(existsSync(root)).toBe(true);
  });

  test('a session that is not watching is blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-removal-'));
    const paused = { ...watching, status: 'disconnected from alpha', lastError: 'connection lost' };

    const plan = await planRemoval({ project: 'demo', localPath: root }, fakeEngine(paused));

    expect(plan.checks.find((check) => check.step === 'sync')?.status).toBe('blocked');
    expect(plan.checks.find((check) => check.step === 'sync')?.code).toBe('sync_pending');
  });

  test('a healthy copy of an untouched folder goes through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-removal-'));
    writeFileSync(join(root, 'app.ts'), 'code');

    const plan = await planRemoval({ project: 'demo', localPath: root }, fakeEngine(watching));

    expect(plan.checks.filter((check) => check.status === 'blocked')).toEqual([]);

    const result = await applyRemoval(plan, false, fakeEngine(watching));
    expect(result.removed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test('a link to another folder blocks the removal as a file of this machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-removal-'));
    const outside = await mkdtemp(join(tmpdir(), 'corami-removal-outside-'));
    symlinkSync(outside, join(root, 'pub-cache'));

    const plan = await planRemoval({ project: 'demo', localPath: root }, fakeEngine(watching));
    const blocked = plan.checks.find((check) => check.step === 'local_only');

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.paths).toEqual([`pub-cache -> ${outside}`]);
    expect(readlinkSync(join(root, 'pub-cache'))).toBe(outside);
  });

  test('a file only this machine has blocks the removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-removal-'));
    mkdirSync(join(root, 'android'), { recursive: true });
    writeFileSync(join(root, 'android', 'local.properties'), 'sdk.dir=/opt/android');

    const plan = await planRemoval({ project: 'demo', localPath: root }, fakeEngine(watching));
    const blocked = plan.checks.find((check) => check.step === 'local_only');

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.code).toBe('local_only_files');

    const error = await applyRemoval(plan, false, fakeEngine(watching)).catch((caught) => caught);
    expect((error as CoramiError).code).toBe('local_only_files');
    expect(existsSync(root)).toBe(true);
  });
});
