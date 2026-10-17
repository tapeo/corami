import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { remoteExtractCommand } from '@/cli/commands/import.ts';
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

describe('sync ignores', () => {
  test('cover what the sync rebuilds and what belongs to one machine', () => {
    expect(DEFAULT_IGNORES).toContain('node_modules/');
    expect(DEFAULT_IGNORES).toContain('android/local.properties');
    expect(DEFAULT_IGNORES).toContain('ios/Flutter/Generated.xcconfig');
  });

  test('nothing about keys or env files: they are files of the project', () => {
    for (const pattern of ['*.jks', '*.p12', '*service-account*.json', '.env', '.env.*']) {
      expect(DEFAULT_IGNORES).not.toContain(pattern);
    }
  });
});

describe('tar arguments', () => {
  test('exclude regenerable folders at any depth, and by name', () => {
    const args = tarExcludeArgs();
    expect(args).toContain('--exclude=node_modules');
    expect(args).toContain('--exclude=ephemeral');
    expect(args).toContain('--exclude=./android/local.properties');
  });

  test('carry keys and env files: they are files of the project', () => {
    const args = tarExcludeArgs();
    for (const pattern of [
      '.jks',
      'keystore',
      '.p8',
      '.p12',
      'service-account',
      'key.properties',
      '.env',
    ]) {
      expect(args.some((arg) => arg.includes(pattern))).toBe(false);
    }
  });
});

describe('remote manifest arguments', () => {
  test('match the tar exclusions', () => {
    const args = findExcludeArgs().join(' ');
    expect(args).toContain("-name 'node_modules'");
    expect(args).toContain("-path '*/node_modules/*'");
    expect(args).toContain("-path './android/local.properties'");
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
    expect(manifest.bytes).toBe(1050);
  });

  test('counts every file of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    writeFileSync(join(root, 'notes.txt'), 'x'.repeat(20));
    writeFileSync(join(root, '.env'), 'SECRET=1');

    expect(localManifest(root).files).toBe(2);
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
