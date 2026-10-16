import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isEnvPath } from '@/cli/commands/import.ts';
import {
  factsMatch,
  localManifest,
  manifestsMatch,
  shellQuote,
  TAR_EXCLUDES,
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
});

describe('tar arguments', () => {
  test('exclude regenerable folders', () => {
    const args = tarExcludeArgs();
    expect(args).toContain('--exclude=./node_modules');
    expect(args).toContain('--exclude=./.next');
    expect(args.length).toBe(TAR_EXCLUDES.length);
  });
});

describe('manifests', () => {
  test('hash the file list and count bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-manifest-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'app', 'page.tsx'), 'x'.repeat(50));
    writeFileSync(join(root, 'node_modules', 'ignored.js'), 'y'.repeat(1000));

    const manifest = localManifest(root);
    expect(manifest.files).toBe(1);
    expect(manifest.bytes).toBe(50);
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
