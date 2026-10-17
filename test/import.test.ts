import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { remoteExtractCommand, restoreLocalFiles, runImport } from '@/cli/commands/import.ts';
import { CoramiError } from '@/core/errors.ts';
import { shellQuote } from '@/core/exec.ts';
import { copyInventory } from '@/core/local-copy.ts';
import { MUTAGEN } from '@/core/pinned-tools.ts';
import { checksumFor } from '@/core/release.ts';
import {
  archiveList,
  factsMatch,
  localManifest,
  manifestsMatch,
  remoteFolderState,
  remoteFolderStateCommand,
} from '@/core/transfer.ts';
import { DEFAULT_IGNORES } from '@/integrations/mutagen.ts';

/** A git command of a test fixture: it throws when git refuses. */
function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stderr: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  }
}

describe('sync ignores', () => {
  test('cover what the sync rebuilds and what belongs to one machine', () => {
    expect(DEFAULT_IGNORES).toContain('node_modules/');
    expect(DEFAULT_IGNORES).toContain('**/android/local.properties');
    expect(DEFAULT_IGNORES).toContain('**/ios/Flutter/Generated.xcconfig');
    expect(DEFAULT_IGNORES).toContain('**/ios/.symlinks/');
  });

  test('nothing about keys or env files: they are files of the project', () => {
    for (const pattern of ['*.jks', '*.p12', '*service-account*.json', '.env', '.env.*']) {
      expect(DEFAULT_IGNORES).not.toContain(pattern);
    }
  });
});

describe('the archive', () => {
  test('carries the history and leaves the regenerable folders out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-archive-git-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};\n');

    git(root, ['init', '-q']);
    git(root, ['-c', 'user.name=test', '-c', 'user.email=test@test', 'add', '.']);
    git(root, ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'first']);

    const inventory = copyInventory(root);
    const list = archiveList(root, inventory);
    const archive = `${root}.tgz`;
    const packed = Bun.spawnSync(
      ['tar', '-czf', archive, '-C', root, '--null', '--no-recursion', '-T', '-'],
      { stdin: new TextEncoder().encode(`${list.join('\0')}\0`), stderr: 'pipe' },
    );
    expect(packed.exitCode).toBe(0);

    const listed = Bun.spawnSync(['tar', '-tzf', archive], { stderr: 'pipe' });
    const paths = listed.stdout
      .toString()
      .split('\n')
      .map((line) => line.replace(/^\.\//, ''))
      .filter((line) => line !== '');

    expect(paths).toContain('.git/HEAD');
    expect(paths).toContain('src/index.ts');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);

    // The manifest leaves the history out on both sides: git is compared on
    // its own, so counting its files would make the two sides disagree.
    expect(localManifest(root).files).toBe(1);
  });

  test('carry keys and env files: they are files of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-archive-keys-'));
    writeFileSync(join(root, 'upload.jks'), 'key');
    writeFileSync(join(root, 'service-account.json'), '{}');
    writeFileSync(join(root, '.env'), 'SECRET=1');

    const paths = archiveList(root);

    expect(paths).toContain('upload.jks');
    expect(paths).toContain('service-account.json');
    expect(paths).toContain('.env');
  });
});

describe('the copy that comes back', () => {
  test('a link keeps its target and a folder of this machine keeps its links', async () => {
    const backup = await mkdtemp(join(tmpdir(), 'corami-backup-'));
    const target = await mkdtemp(join(tmpdir(), 'corami-copy-'));
    const outside = await mkdtemp(join(tmpdir(), 'corami-outside-'));

    mkdirSync(join(backup, 'android'), { recursive: true });
    mkdirSync(join(backup, 'ios', '.symlinks', 'plugins'), { recursive: true });
    writeFileSync(join(backup, 'android', 'local.properties'), 'sdk.dir=/opt');
    symlinkSync(outside, join(backup, 'pub-cache'));
    symlinkSync(
      '/Users/me/.pub-cache/camera',
      join(backup, 'ios', '.symlinks', 'plugins', 'camera'),
    );

    const entries = copyInventory(backup).localOnly;
    expect(restoreLocalFiles(backup, target, entries)).toBe(entries.length);

    expect(readlinkSync(join(target, 'pub-cache'))).toBe(outside);
    expect(lstatSync(join(target, 'ios', '.symlinks')).isDirectory()).toBe(true);
    expect(readlinkSync(join(target, 'ios', '.symlinks', 'plugins', 'camera'))).toBe(
      '/Users/me/.pub-cache/camera',
    );
  });
});

describe('manifests', () => {
  test('hash the file list and count bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'app', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'app', 'page.tsx'), 'x'.repeat(50));
    writeFileSync(join(root, 'node_modules', 'ignored.js'), 'y'.repeat(1000));
    writeFileSync(join(root, 'app', 'node_modules', 'deep.js'), 'y'.repeat(1000));
    writeFileSync(join(root, 'android.jks'), 'y'.repeat(1000));

    // page.tsx and android.jks: a key is a file of the project like the others.
    const manifest = localManifest(root);
    expect(manifest.files).toBe(2);
    expect(manifest.dirs).toBe(1);
    expect(manifest.bytes).toBe(1050);
  });

  test('counts every file of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    writeFileSync(join(root, 'notes.txt'), 'x'.repeat(20));
    writeFileSync(join(root, '.env'), 'SECRET=1');

    expect(localManifest(root).files).toBe(2);
  });

  test('compare manifests and git facts', () => {
    const manifest = { files: 2, links: 0, dirs: 1, bytes: 10, hash: 'abc', entries: [] };
    expect(manifestsMatch(manifest, { ...manifest })).toBe(true);
    expect(manifestsMatch(manifest, { ...manifest, files: 3 })).toBe(false);
  });

  test('compare git facts without the dirty count', () => {
    const facts = { head: 'abc', refs: 3, stashes: 1, dirty: 2 };
    expect(factsMatch(facts, { ...facts, dirty: 0 })).toBe(true);
    expect(factsMatch(facts, { ...facts, refs: 2 })).toBe(false);
  });
});

describe('the folder of the import on the server', () => {
  test('the check names a folder that does not exist, and one with something in it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-server-folder-'));
    const empty = join(root, 'empty');
    const taken = join(root, 'taken');
    const missing = join(root, 'missing');
    mkdirSync(empty);
    mkdirSync(taken);
    writeFileSync(join(taken, 'notes.txt'), 'x');

    const runner = async (script: string) => {
      const result = Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe' });

      return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
    };

    expect(await remoteFolderState('host', 'user', empty, runner)).toBe('empty');
    expect(await remoteFolderState('host', 'user', taken, runner)).toBe('taken');
    expect(await remoteFolderState('host', 'user', missing, runner)).toBe('missing');
    // A check that cannot answer is not a free folder.
    expect(
      await remoteFolderState('host', 'user', empty, async () => ({ ok: false, stdout: '' })),
    ).toBeUndefined();
  });

  test('the command quotes the folder as one word', () => {
    const command = remoteFolderStateCommand("/home/it's/projects/app");

    expect(command).toContain("test -e '/home/it'\\''s/projects/app'");
    expect(command).toContain("ls -A '/home/it'\\''s/projects/app'");
  });
});

describe('shell quoting', () => {
  test('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('checksums', () => {
  test('reads the sha256 of one asset', () => {
    const text = ['aaa  corami-linux-x64', 'bbb  *corami-darwin-arm64', ''].join('\n');

    expect(checksumFor(text, 'corami-linux-x64')).toBe('aaa');
    expect(checksumFor(text, 'corami-darwin-arm64')).toBe('bbb');
    expect(checksumFor(text, 'corami-windows-x64.exe')).toBeUndefined();
  });

  test('the pinned tools carry the sum of every asset they install', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const arch of ['x64', 'arm64']) {
        const asset = MUTAGEN.asset(platform, arch);
        expect(MUTAGEN.checksums(asset)).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('the command the server runs to unpack the archive', () => {
  test('unpacks into the folder of the project', () => {
    const command = remoteExtractCommand('/home/corami/projects/demo');
    expect(command).toContain("mkdir -p '/home/corami/projects/demo'");
    expect(command).toContain("tar -xzf - --no-same-owner -C '/home/corami/projects/demo'");
    expect(command.includes('chmod')).toBe(false);
  });

  test('a path with a quote stays one word', () => {
    const command = remoteExtractCommand("/home/it's/projects/demo");
    expect(command).toContain("mkdir -p '/home/it'\\''s/projects/demo'");
  });
});

describe('an import that stops', () => {
  test('a folder that is not a repository is a usage error, with its steps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'corami-home-'));
    const folder = await mkdtemp(join(tmpdir(), 'corami-import-'));
    mkdirSync(join(home, '.corami'), { recursive: true });
    writeFileSync(
      join(home, '.corami', 'config.json'),
      JSON.stringify({
        role: 'client',
        server_host: 'corami.example.ts.net',
        server_user: 'corami',
      }),
    );
    writeFileSync(join(folder, 'notes.txt'), 'x');

    const previous = process.env.HOME;
    process.env.HOME = home;

    try {
      // The git step is the first one, so no daemon and no sync engine are
      // asked: the command stops here with the step that failed.
      const error = await runImport({
        project: 'probe',
        localPath: folder,
        dryRun: false,
        output: { json: true, color: false },
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(CoramiError);
      expect((error as CoramiError).code).toBe('usage');
      expect((error as CoramiError).message).toContain('Import of probe stopped at git');
      expect(
        (error as CoramiError).details?.steps as Array<{ step: string; status: string }>,
      ).toContainEqual(expect.objectContaining({ step: 'git', status: 'failed' }));
    } finally {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
    }
  });
});
