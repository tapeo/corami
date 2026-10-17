import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactUrl, shellQuote } from '@/core/exec.ts';
import type { PathClass } from '@/core/local-copy.ts';
import {
  classifyPath,
  findLocalOnlyFiles,
  isSensitiveName,
  PATH_RULES,
  patternsOf,
} from '@/core/local-copy.ts';
import { findExcludeArgs, localManifest, remoteManifest, tarExcludeArgs } from '@/core/transfer.ts';

describe('classifyPath', () => {
  const cases: Array<[string, PathClass]> = [
    ['src/index.ts', 'synced'],
    ['README.md', 'synced'],
    ['.env', 'env'],
    ['.env.local', 'env'],
    ['apps/web/.env.production', 'env'],
    ['upload.jks', 'key'],
    ['android/app/upload.jks', 'key'],
    ['certs/deep/keystore.keystore', 'key'],
    ['release/AuthKey_AB12.p8', 'key'],
    ['signing/certificate.p12', 'key'],
    ['fastlane/service-account-prod.json', 'key'],
    // A path alone says nothing about being a folder: the callers that walk
    // the tree ask `isRegenerableFolder` for the folders.
    ['node_modules', 'synced'],
    ['node_modules/left-pad/index.js', 'regenerable'],
    ['packages/web/node_modules/left-pad/index.js', 'regenerable'],
    ['build/app.aab', 'regenerable'],
    ['ios/Pods/Headers/foo.h', 'regenerable'],
    ['.DS_Store', 'regenerable'],
    ['src/._page.tsx', 'regenerable'],
    ['android/key.properties', 'key'],
    ['android/local.properties', 'local_only'],
    ['ios/Flutter/Generated.xcconfig', 'local_only'],
    ['ios/Flutter/flutter_export_environment.sh', 'local_only'],
    ['ios/.symlinks/plugins/camera', 'local_only'],
    ['deep/ios/.symlinks/plugins/camera', 'synced'],
    ['.flutter-plugins', 'regenerable'],
  ];

  for (const [path, expected] of cases) {
    test(`${path} is ${expected}`, () => {
      expect(classifyPath(path)).toBe(expected);
    });
  }

  test('a name rule reaches every level', () => {
    expect(classifyPath('a/b/c/server.p12')).toBe('key');
    expect(classifyPath('x/y/node_modules/z.js')).toBe('regenerable');
  });

  test('a path rule stays at the root', () => {
    expect(classifyPath('android/key.properties')).toBe('key');
    expect(classifyPath('apps/demo/android/key.properties')).toBe('synced');
    expect(classifyPath('deep/ios/Flutter/Generated.xcconfig')).toBe('synced');
  });

  test('a pattern is not a name of the rules', () => {
    expect(classifyPath('notes.txt', ['notes.txt'])).toBe('key');
    expect(classifyPath('notes.txt')).toBe('synced');
  });
});

describe('path rules', () => {
  test('one pattern per rule and no duplicates', () => {
    const patterns = patternsOf('regenerable', 'key', 'env', 'local_only');
    expect(new Set(patterns).size).toBe(patterns.length);
    expect(patterns.length).toBe(PATH_RULES.length);
  });

  test('the sensitive names come from the rules', () => {
    expect(isSensitiveName('.env')).toBe(true);
    expect(isSensitiveName('upload.jks')).toBe(true);
    expect(isSensitiveName('android/key.properties')).toBe(true);
    expect(isSensitiveName('key.properties')).toBe(false);
    expect(isSensitiveName('node_modules')).toBe(false);
    expect(isSensitiveName('local.properties')).toBe(false);
  });
});

describe('local only files', () => {
  test('reports keys and local files, not regenerable folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-only-'));
    mkdirSync(join(root, 'android', 'app'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'android', 'app', 'upload.jks'), 'key');
    writeFileSync(join(root, 'android', 'key.properties'), 'sdk');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'node_modules', '.env'), 'ignored');
    writeFileSync(join(root, 'app.ts'), 'ok');

    const found = findLocalOnlyFiles(root);
    expect(found.map((entry) => entry.path).sort()).toEqual([
      '.env',
      'android/app/upload.jks',
      'android/key.properties',
    ]);
    expect(found.find((entry) => entry.path.endsWith('upload.jks'))?.class).toBe('key');
    expect(found.find((entry) => entry.path.endsWith('key.properties'))?.class).toBe('key');
    expect(found.find((entry) => entry.path === '.env')?.class).toBe('env');
  });
});

describe('the archive of an import', () => {
  test('the tar exclusions cover every path the walk reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-archive-'));
    const dirs = [
      'android',
      'android/app',
      'node_modules/left-pad',
      'app/node_modules/left-pad',
      'ios/Pods/Headers',
      'ios/.symlinks/plugins',
      'ios/Flutter',
      'src',
    ];
    const files = [
      'src/index.ts',
      'README.md',
      'app/main.ts',
      '.env',
      'android/key.properties',
      'android/app/upload.jks',
      'node_modules/left-pad/index.js',
      'app/node_modules/left-pad/index.js',
      'ios/Pods/Headers/foo.h',
      'ios/.symlinks/plugins/camera/index.js',
      'ios/Flutter/Generated.xcconfig',
      'signing.p12',
      'notes.txt',
    ];

    for (const dir of dirs) {
      mkdirSync(join(root, dir), { recursive: true });
    }

    for (const file of files) {
      const full = join(root, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, file);
    }

    const included = ['notes.txt'];
    const manifest = localManifest(root, included);

    // The same files the archive carries: tar writes them, find counts them.
    const archive = '/tmp/corami-archive-test.tgz';
    const packed = Bun.spawnSync(['tar', '-czf', archive, ...tarExcludeArgs(), '-C', root, '.'], {
      stderr: 'pipe',
    });
    expect(packed.exitCode).toBe(0);

    const listed = Bun.spawnSync(['tar', '-tzf', archive], { stderr: 'pipe' });
    const packedFiles = listed.stdout
      .toString()
      .split('\n')
      .map((line) => line.replace(/^\.\//, ''))
      .filter((line) => line !== '' && !line.endsWith('/'))
      .sort();

    const remote = await remoteManifest('host', 'user', root, async (script) => {
      const found = Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe' });

      return { ok: found.exitCode === 0, stdout: found.stdout.toString() };
    });

    expect(remote).toBeDefined();
    expect(packedFiles).toEqual([
      '.env',
      'README.md',
      'android/app/upload.jks',
      'android/key.properties',
      'app/main.ts',
      'notes.txt',
      'signing.p12',
      'src/index.ts',
    ]);
    expect(remote?.files).toBe(manifest.files);
    expect(remote?.hash).toBe(manifest.hash);
  });

  test('quotes the path of the archive on the server', () => {
    expect(shellQuote("/home/it's/projects/app")).toBe("'/home/it'\\''s/projects/app'");
  });
});

describe('manifest exclusions', () => {
  test('the find patterns mirror the tar patterns', () => {
    const tar = tarExcludeArgs();
    const find = findExcludeArgs().join(' ');

    for (const pattern of ['node_modules', 'Pods', '.DS_Store', 'android/local.properties']) {
      const inTar = tar.some((entry) => entry.includes(pattern));
      const inFind = find.includes(pattern);
      expect(inTar).toBe(inFind);
    }
  });

  test('the keys go with the import and stay out of the exclusions', () => {
    const tar = tarExcludeArgs();
    const find = findExcludeArgs().join(' ');

    expect(tar.some((entry) => entry.includes('jks'))).toBe(false);
    expect(find.includes('jks')).toBe(false);
    expect(tar.some((entry) => entry.includes('key.properties'))).toBe(false);
  });

  test('a key enters the archive even when an include pattern asks for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-include-'));
    writeFileSync(join(root, 'notes.txt'), 'note');
    writeFileSync(join(root, 'release.p12'), 'key');

    const manifest = localManifest(root, ['notes.txt', 'release.p12']);
    const packed = Bun.spawnSync(
      ['tar', '-czf', '/tmp/corami-include-test.tgz', ...tarExcludeArgs(), '-C', root, '.'],
      { stderr: 'pipe' },
    );
    expect(packed.exitCode).toBe(0);

    const listed = Bun.spawnSync(['tar', '-tzf', '/tmp/corami-include-test.tgz'], {
      stderr: 'pipe',
    });
    const carried = listed.stdout
      .toString()
      .split('\n')
      .map((line) => line.replace(/^\.\//, ''))
      .filter((line) => line !== '' && !line.endsWith('/'))
      .sort();

    expect(carried).toEqual(['notes.txt', 'release.p12']);
    expect(manifest.files).toBe(2);
  });
});

describe('redactUrl', () => {
  test('takes the credentials out of a url', () => {
    expect(redactUrl('https://token@github.com/me/app.git')).toBe('https://github.com/me/app.git');
    expect(redactUrl('https://user:pass@host/me/app.git')).toBe('https://host/me/app.git');
  });

  test('leaves a url without credentials alone', () => {
    expect(redactUrl('git@github.com:me/app.git')).toBe('git@github.com:me/app.git');
    expect(redactUrl('https://github.com/me/app.git')).toBe('https://github.com/me/app.git');
  });
});
