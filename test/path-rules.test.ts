import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactUrl, shellQuote } from '@/core/exec.ts';
import { classifyPath, copyInventory, PATH_RULES, symlinkPortable } from '@/core/local-copy.ts';
import {
  archiveList,
  localManifest,
  manifestDiff,
  manifestOf,
  manifestsMatch,
  parseManifest,
  remoteManifest,
  remoteManifestCommand,
} from '@/core/transfer.ts';
import { DEFAULT_IGNORES, mutagenPattern } from '@/integrations/mutagen.ts';

describe('classifyPath', () => {
  const cases: Array<[string, ReturnType<typeof classifyPath>]> = [
    ['src/index.ts', 'synced'],
    ['README.md', 'synced'],
    ['.env', 'synced'],
    ['.env.local', 'synced'],
    ['upload.jks', 'synced'],
    ['android/app/upload.jks', 'synced'],
    ['android/key.properties', 'synced'],
    ['signing/certificate.p12', 'synced'],
    ['node_modules', 'synced'],
    ['node_modules/left-pad/index.js', 'regenerable'],
    ['packages/web/node_modules/left-pad/index.js', 'regenerable'],
    ['build/app.aab', 'regenerable'],
    ['ios/Pods/Headers/foo.h', 'regenerable'],
    ['.build/CompilationCache.noindex/generic/v1.1/data.v1', 'regenerable'],
    ['packages/app/.build/debug/app', 'regenerable'],
    ['DerivedData/Build/Products/Debug-iphoneos/app.app/app', 'regenerable'],
    [
      'Sorumi.xcodeproj/xcuserdata/matteo.xcuserdatad/UserInterfaceState.xcuserstate',
      'regenerable',
    ],
    ['.DS_Store', 'regenerable'],
    ['src/._page.tsx', 'regenerable'],
    ['android/local.properties', 'local_only'],
    ['ios/Flutter/Generated.xcconfig', 'local_only'],
    ['ios/Flutter/flutter_export_environment.sh', 'local_only'],
    ['ios/.symlinks/plugins/camera', 'local_only'],
    ['deep/ios/.symlinks/plugins/camera', 'local_only'],
    ['.flutter-plugins', 'regenerable'],
  ];

  for (const [path, expected] of cases) {
    test(`${path} is ${expected}`, () => {
      expect(classifyPath(path)).toBe(expected);
    });
  }

  test('a name rule reaches every level', () => {
    expect(classifyPath('a/b/c/deep.p12')).toBe('synced');
    expect(classifyPath('x/y/node_modules/z.js')).toBe('regenerable');
  });

  test('a path rule reaches every level', () => {
    expect(classifyPath('android/local.properties')).toBe('local_only');
    expect(classifyPath('apps/demo/android/local.properties')).toBe('local_only');
    expect(classifyPath('deep/ios/Flutter/Generated.xcconfig')).toBe('local_only');
    expect(classifyPath('apps/demo/ios/Flutter/flutter_export_environment.sh')).toBe('local_only');
  });

  test('a folder rule only matches a folder', () => {
    expect(classifyPath('build')).toBe('synced');
    expect(classifyPath('build', true)).toBe('regenerable');
    expect(classifyPath('.build', true)).toBe('regenerable');
    expect(classifyPath('Sorumi.xcodeproj/xcuserdata', true)).toBe('regenerable');
    expect(classifyPath('apps/demo/ios/.symlinks')).toBe('synced');
    expect(classifyPath('apps/demo/ios/.symlinks', true)).toBe('local_only');
  });
});

describe('path rules', () => {
  test('one pattern per rule and no duplicates', () => {
    const patterns = PATH_RULES.map((rule) => rule.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe('symlinkPortable', () => {
  const portable: Array<[string, string]> = [
    ['link', 'file'],
    ['link', './file'],
    ['app/ios/link', '../shared/file'],
    ['app/ios/link', '../../file'],
    ['app/ios/link', 'a/../../file'],
  ];

  for (const [path, target] of portable) {
    test(`${path} -> ${target} travels`, () => {
      expect(symlinkPortable(path, target)).toBe(true);
    });
  }

  const local: Array<[string, string]> = [
    ['link', ''],
    ['link', '/Users/matteo/.pub-cache'],
    ['link', '../outside'],
    ['app/link', '../../outside'],
    ['link', 'a:b'],
    ['link', 'a\\b'],
    ['link', 'x'.repeat(248)],
  ];

  for (const [path, target] of local) {
    test(`${path} -> ${target} stays here`, () => {
      expect(symlinkPortable(path, target)).toBe(false);
    });
  }

  test('a target of 247 characters still travels', () => {
    expect(symlinkPortable('link', 'x'.repeat(247))).toBe(true);
  });
});

describe('mutagenPattern', () => {
  test('a path rule matches at any depth, a name rule as before', () => {
    const patterns = new Map(PATH_RULES.map((rule) => [rule.pattern, mutagenPattern(rule)]));

    expect(patterns.get('ios/.symlinks')).toBe('**/ios/.symlinks/');
    expect(patterns.get('android/local.properties')).toBe('**/android/local.properties');
    expect(patterns.get('node_modules')).toBe('node_modules/');
    expect(patterns.get('.DS_Store')).toBe('.DS_Store');
  });

  test('the session ignores carry one of each', () => {
    expect(DEFAULT_IGNORES).toContain('**/ios/.symlinks/');
    expect(DEFAULT_IGNORES).toContain('.build/');
    expect(DEFAULT_IGNORES).toContain('DerivedData/');
    expect(DEFAULT_IGNORES).toContain('xcuserdata/');
    expect(DEFAULT_IGNORES).not.toContain('.git/');
  });
});

describe('the inventory of a copy', () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'corami-inventory-'));
    const outside = join(root, '..', `corami-outside-${Date.now()}`);

    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'big.bin'), 'x'.repeat(100));

    const dirs = [
      'src',
      'apps/demo/android',
      'apps/demo/ios/.symlinks/plugins/camera',
      'apps/demo/ios/Flutter',
      'node_modules/left-pad',
      'empty',
    ];

    for (const dir of dirs) {
      mkdirSync(join(root, dir), { recursive: true });
    }

    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'upload.jks'), 'key');
    writeFileSync(join(root, 'apps', 'demo', 'android', 'local.properties'), 'sdk.dir=/opt');
    writeFileSync(join(root, 'apps', 'demo', 'ios', 'Flutter', 'Generated.xcconfig'), 'x');
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'ignored');
    writeFileSync(
      join(root, 'apps', 'demo', 'ios', '.symlinks', 'plugins', 'camera', 'Podfile'),
      'pod',
    );

    symlinkSync(outside, join(root, 'pub-cache'));
    symlinkSync(join(outside, 'big.bin'), join(root, 'external.bin'));
    symlinkSync('src/index.ts', join(root, 'index.ts'));

    return root;
  }

  test('a link to another folder is one entry, never a walk of that folder', async () => {
    const root = await fixture();
    const inventory = copyInventory(root);

    expect(inventory.localOnly.map((entry) => entry.path)).toContain('pub-cache');
    expect(inventory.synced.map((entry) => entry.path)).not.toContain('pub-cache/big.bin');
    expect(inventory.synced.some((entry) => entry.path.startsWith('pub-cache/'))).toBe(false);
    expect(inventory.localOnly.map((entry) => entry.path)).toContain('external.bin');
    expect(inventory.synced.map((entry) => entry.path)).toContain('index.ts');
    expect(lstatSync(join(root, 'index.ts')).isSymbolicLink()).toBe(true);
  });

  test('a folder of this machine is one entry, with the links it holds', async () => {
    const root = await fixture();
    const inventory = copyInventory(root);

    const symlinks = inventory.localOnly.find((entry) => entry.path === 'apps/demo/ios/.symlinks');

    expect(symlinks?.kind).toBe('dir');
    expect(inventory.localOnly.some((entry) => entry.path.includes('.symlinks/plugins'))).toBe(
      false,
    );
    expect(inventory.localOnly.map((entry) => entry.path)).toContain(
      'apps/demo/android/local.properties',
    );
    expect(inventory.localOnly.map((entry) => entry.path)).toContain(
      'apps/demo/ios/Flutter/Generated.xcconfig',
    );
  });

  test('keys, env files and empty folders travel, regenerable folders do not', async () => {
    const root = await fixture();
    const inventory = copyInventory(root);
    const paths = inventory.synced.map((entry) => entry.path);

    expect(paths).toContain('.env');
    expect(paths).toContain('upload.jks');
    expect(paths).toContain('empty');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
  });

  test('the root history is not content of the project, a submodule gitlink is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-gitlink-'));
    mkdirSync(join(root, 'modules', 'lib'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /Users/me/.git/modules/project');
    writeFileSync(join(root, 'modules', 'lib', '.git'), 'gitdir: ../../.git/modules/lib');
    writeFileSync(join(root, 'README.md'), 'readme');

    const inventory = copyInventory(root);
    const paths = inventory.synced.map((entry) => entry.path);

    expect(paths).not.toContain('.git');
    expect(paths).toContain('modules/lib/.git');
    expect(archiveList(root, inventory).filter((path) => path === '.git')).toHaveLength(1);
  });

  test('a FIFO is not content a copy carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-fifo-'));
    const made = Bun.spawnSync(['mkfifo', join(root, 'pipe')], { stderr: 'pipe' });

    if (made.exitCode !== 0) {
      return;
    }

    expect(copyInventory(root).synced).toEqual([]);
  });
});

describe('the archive of an import', () => {
  test('the archive and the manifest hold the same entries, links included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-archive-'));
    const outside = await mkdtemp(join(tmpdir(), 'corami-archive-outside-'));
    const unpacked = await mkdtemp(join(tmpdir(), 'corami-archive-unpacked-'));
    const archive = join(await mkdtemp(join(tmpdir(), 'corami-archive-tgz-')), 'copy.tgz');

    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, 'apps', 'demo', 'ios', '.symlinks'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'notes.txt'), 'notes');
    writeFileSync(join(outside, 'big.bin'), 'x'.repeat(100));
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'ignored');
    writeFileSync(join(root, 'apps', 'demo', 'ios', '.symlinks', 'Podfile'), 'pod');
    symlinkSync(outside, join(root, 'pub-cache'));
    symlinkSync('src/index.ts', join(root, 'index.ts'));

    const inventory = copyInventory(root);
    const manifest = manifestOf(inventory);
    const list = archiveList(root, inventory);

    const packed = Bun.spawnSync(
      ['tar', '-czf', archive, '-C', root, '--null', '--no-recursion', '-T', '-'],
      { stdin: new TextEncoder().encode(`${list.join('\0')}\0`), stderr: 'pipe' },
    );
    expect(packed.exitCode).toBe(0);

    const extracted = Bun.spawnSync(['tar', '-xzf', archive, '-C', unpacked], { stderr: 'pipe' });
    expect(extracted.exitCode).toBe(0);

    expect(readlinkSync(join(unpacked, 'index.ts'))).toBe('src/index.ts');
    expect(() => lstatSync(join(unpacked, 'pub-cache'))).toThrow();
    expect(() => lstatSync(join(unpacked, 'apps', 'demo', 'ios', '.symlinks'))).toThrow();
    expect(() => lstatSync(join(unpacked, 'node_modules'))).toThrow();

    const remote = await remoteManifest('host', 'user', unpacked, async (script) => {
      const found = Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe' });

      return { ok: found.exitCode === 0, stdout: found.stdout.toString() };
    });

    expect(remote).toBeDefined();

    if (remote !== undefined) {
      expect(manifestsMatch(manifest, remote)).toBe(true);
    }
  });

  test('the fallback of the remote manifest agrees with printfs-less find', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-fallback-'));
    mkdirSync(join(root, 'dir'), { recursive: true });
    writeFileSync(join(root, 'dir', 'file.txt'), 'hello');
    symlinkSync('dir/file.txt', join(root, 'link'));

    const script = remoteManifestCommand(root, false);
    const found = Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe' });
    const manifest = parseManifest(found.stdout.toString());

    expect(found.exitCode).toBe(0);
    expect(manifest.files).toBe(1);
    expect(manifest.links).toBe(1);
    expect(manifest.dirs).toBe(1);
    expect(manifest.entries).toContain('l\tlink\tdir/file.txt');
  });

  test('quotes the path of the archive on the server', () => {
    expect(shellQuote("/home/it's/projects/app")).toBe("'/home/it'\\''s/projects/app'");
  });
});

describe('manifests', () => {
  test('count files, links and folders of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    mkdirSync(join(root, 'empty'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'x'.repeat(20));
    writeFileSync(join(root, '.env'), 'SECRET=1');
    symlinkSync('notes.txt', join(root, 'shortcut'));

    const manifest = localManifest(root);
    expect(manifest.files).toBe(2);
    expect(manifest.links).toBe(1);
    expect(manifest.dirs).toBe(1);
    expect(manifest.bytes).toBe(28);
  });

  test('a link and a file of the same name are not the same entry', async () => {
    const file = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    const link = await mkdtemp(join(tmpdir(), 'corami-manifest-'));

    writeFileSync(join(file, 'name'), 'hello');
    symlinkSync('elsewhere', join(link, 'name'));

    expect(manifestsMatch(localManifest(file), localManifest(link))).toBe(false);
  });

  test('the difference names the paths, not just the counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-diff-'));
    writeFileSync(join(root, 'here.txt'), 'here');
    writeFileSync(join(root, 'both.txt'), 'both');

    const other = await mkdtemp(join(tmpdir(), 'corami-diff-'));
    writeFileSync(join(other, 'both.txt'), 'both');
    writeFileSync(join(other, 'there.txt'), 'there');
    writeFileSync(join(other, 'extra.txt'), 'extra');

    const diff = manifestDiff(localManifest(root), localManifest(other));
    expect(diff).toContain('only here: here.txt');
    expect(diff).toContain('only on the server: extra.txt, there.txt');
  });

  test('compare manifests on every count', () => {
    const manifest = { files: 2, links: 0, dirs: 1, bytes: 10, hash: 'abc', entries: [] };
    expect(manifestsMatch(manifest, { ...manifest })).toBe(true);
    expect(manifestsMatch(manifest, { ...manifest, files: 3 })).toBe(false);
    expect(manifestsMatch(manifest, { ...manifest, links: 1 })).toBe(false);
    expect(manifestsMatch(manifest, { ...manifest, dirs: 2 })).toBe(false);
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
