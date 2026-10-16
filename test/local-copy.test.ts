import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDuration, renderCandidates } from '@/cli/commands/sync.ts';
import { directorySize, findLocalOnlyFiles, isSensitiveName, localGit } from '@/core/local-copy.ts';
import { collectConflicts, parseSessions, sessionName } from '@/integrations/mutagen.ts';

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

describe('sensitive names', () => {
  test('matches env files and keys', () => {
    expect(isSensitiveName('.env')).toBe(true);
    expect(isSensitiveName('.env.local')).toBe(true);
    expect(isSensitiveName('upload.jks')).toBe(true);
    expect(isSensitiveName('AuthKey_ABC.p8')).toBe(true);
  });

  test('does not match ordinary files', () => {
    expect(isSensitiveName('page.tsx')).toBe(false);
    expect(isSensitiveName('README.md')).toBe(false);
  });

  test('honours extra patterns', () => {
    expect(isSensitiveName('notes.txt', ['notes.txt'])).toBe(true);
  });
});

describe('local only files', () => {
  test('finds secrets and skips regenerable folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, '.env.local'), 'SECRET=1');
    writeFileSync(join(root, 'node_modules', '.env'), 'ignored');
    writeFileSync(join(root, 'app', 'page.tsx'), 'ok');

    const found = findLocalOnlyFiles(root);
    expect(found.map((entry) => entry.path)).toEqual(['.env.local']);
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
      conflicts: [{ path: 'app/page.tsx' }],
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

  test('reads problems from the endpoints', () => {
    const record = { beta: { transitionProblems: ['cannot create root'] } };
    expect(collectConflicts(record)).toEqual([]);
  });

  test('builds the session name', () => {
    expect(sessionName('demo')).toBe('corami-demo');
  });
});
