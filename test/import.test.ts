import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isEnvPath, remoteExtractCommand } from '@/cli/commands/import.ts';
import { shellQuote } from '@/core/exec.ts';
import { MUTAGEN } from '@/core/pinned-tools.ts';
import { checksumFor } from '@/core/release.ts';
import {
  factsMatch,
  findExcludeArgs,
  localManifest,
  manifestsMatch,
  tarExcludeArgs,
} from '@/core/transfer.ts';
import { DEFAULT_IGNORES } from '@/integrations/mutagen.ts';

describe('env detection', () => {
  test('recognises env files at any depth', () => {
    expect(isEnvPath('.env')).toBe(true);
    expect(isEnvPath('.env.local')).toBe(true);
    expect(isEnvPath('apps/web/.env.production')).toBe(true);
  });

  test('does not confuse other files', () => {
    expect(isEnvPath('environment.ts')).toBe(false);
    expect(isEnvPath('service-account.json')).toBe(false);
  });
});

describe('sync ignores', () => {
  test('cover secrets by name', () => {
    expect(DEFAULT_IGNORES).toContain('*.p12');
    expect(DEFAULT_IGNORES).toContain('*service-account*.json');
    expect(DEFAULT_IGNORES).toContain('.env.*');
  });

  test('cover what only one machine may keep', () => {
    expect(DEFAULT_IGNORES).toContain('android/key.properties');
    expect(DEFAULT_IGNORES).toContain('node_modules/');
  });
});

describe('tar arguments', () => {
  test('exclude regenerable folders at any depth, and by name', () => {
    const args = tarExcludeArgs();
    expect(args).toContain('--exclude=node_modules');
    expect(args).toContain('--exclude=ephemeral');
    expect(args).toContain('--exclude=./android/local.properties');
    expect(args.some((arg) => arg.includes('.env'))).toBe(false);
  });

  test('the keys and the env files go with the import', () => {
    const args = tarExcludeArgs();
    expect(args.some((arg) => arg.includes('.jks'))).toBe(false);
    expect(args.some((arg) => arg.includes('key.properties'))).toBe(false);
  });
});

describe('remote manifest arguments', () => {
  test('match the tar exclusions', () => {
    const args = findExcludeArgs().join(' ');
    expect(args).toContain("-name 'node_modules'");
    expect(args).toContain("-path '*/node_modules/*'");
    expect(args).toContain("-path './android/local.properties'");
    expect(args.includes('jks')).toBe(false);
    expect(args.includes('key.properties')).toBe(false);
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

    // page.tsx and android.jks: the keys travel with the import.
    const manifest = localManifest(root);
    expect(manifest.files).toBe(2);
    expect(manifest.bytes).toBe(1050);
  });

  test('counts a file the user asked for with the include patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    writeFileSync(join(root, 'notes.txt'), 'x'.repeat(20));

    expect(localManifest(root).files).toBe(1);
    expect(localManifest(root, ['notes.txt']).files).toBe(1);
  });

  test('compare manifests and git facts', () => {
    const manifest = { files: 2, bytes: 10, hash: 'abc' };
    expect(manifestsMatch(manifest, { ...manifest })).toBe(true);
    expect(manifestsMatch(manifest, { ...manifest, files: 3 })).toBe(false);
  });

  test('compare git facts without the dirty count', () => {
    const facts = { head: 'abc', refs: 3, stashes: 1, dirty: 2 };
    expect(factsMatch(facts, { ...facts, dirty: 0 })).toBe(true);
    expect(factsMatch(facts, { ...facts, refs: 2 })).toBe(false);
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
    const command = remoteExtractCommand('/home/corami/projects/demo', []);
    expect(command).toContain("mkdir -p '/home/corami/projects/demo'");
    expect(command).toContain("tar -xzf - --no-same-owner -C '/home/corami/projects/demo'");
    expect(command.includes('chmod')).toBe(false);
  });

  test('closes the keys to everyone else', () => {
    const command = remoteExtractCommand('/home/corami/projects/demo', [
      '.env',
      'android/key.properties',
    ]);
    expect(command).toContain("chmod 600 -- './.env' './android/key.properties'");
  });

  test('a path with a quote stays one word', () => {
    const command = remoteExtractCommand('/home/corami/projects/demo', ["it's a key.p8"]);
    expect(command).toContain(`chmod 600 -- './it'\\''s a key.p8'`);
  });
});
