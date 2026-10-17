import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assetNameFor, isNewer, parseSemver, parseVersion, replaceBinary } from '@/core/release.ts';

describe('versions', () => {
  test('reads the tag without its v', () => {
    expect(parseVersion('v0.7.1')).toBe('0.7.1');
    expect(parseVersion('0.7.1')).toBe('0.7.1');
  });

  test('orders releases', () => {
    expect(isNewer('0.7.1', '0.7.0')).toBe(true);
    expect(isNewer('0.8.0', '0.7.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.7.0', '0.7.0')).toBe(false);
    expect(isNewer('0.6.9', '0.7.0')).toBe(false);
  });

  test('a build of the source tree is older than any release', () => {
    expect(isNewer('0.7.1', 'dev')).toBe(true);
    expect(isNewer('dev', '0.7.1')).toBe(false);
    expect(isNewer('dev', 'dev')).toBe(false);
  });

  test('a release comes after its prereleases', () => {
    expect(isNewer('1.0.0', '1.0.0-rc1')).toBe(true);
    expect(isNewer('1.0.0-rc1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-rc2', '1.0.0-rc1')).toBe(true);
  });

  test('parts that are not numbers count as zero', () => {
    expect(parseSemver('dev')).toEqual({ numbers: [0, 0, 0], prerelease: undefined });
    expect(parseSemver('0.7.1-rc1')).toEqual({ numbers: [0, 7, 1], prerelease: 'rc1' });
  });

  test('names the asset of every platform', () => {
    expect(assetNameFor('linux', 'x64')).toBe('corami-linux-x64');
    expect(assetNameFor('darwin', 'arm64')).toBe('corami-darwin-arm64');
    expect(assetNameFor('win32', 'x64')).toBe('corami-windows-x64.exe');
    expect(assetNameFor('win32', 'arm64')).toBe('corami-windows-arm64.exe');
  });
});

describe('replacing the binary', () => {
  test('puts the new binary in place and removes the backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'corami-replace-'));
    const current = join(root, 'corami');
    const downloaded = join(root, 'corami.new');
    writeFileSync(current, 'old');
    writeFileSync(downloaded, 'new');

    replaceBinary(current, downloaded);

    expect(readFileSync(current, 'utf8')).toBe('new');
    expect(() => readFileSync(`${current}.old`, 'utf8')).toThrow();
  });

  test('keeps the next to the one it replaces when the new one is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'corami-replace-'));
    const current = join(root, 'corami');
    const downloaded = join(root, 'corami.new');
    writeFileSync(current, 'old');

    // The downloaded binary was removed between the checks: the rename fails,
    // and what was there must come back.
    expect(() => replaceBinary(current, downloaded)).toThrow();
    expect(readFileSync(current, 'utf8')).toBe('old');
  });
});
