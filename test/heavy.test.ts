import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyInventory, HEAVY_LIMITS, heavyEntries, heavyInFolder } from '@/core/local-copy.ts';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function inventoryOf(entries: Array<{ path: string; kind: 'file' | 'dir'; bytes: number }>) {
  return { synced: entries.map((entry) => ({ ...entry })), localOnly: [] };
}

describe('heavy entries', () => {
  test('a file over the limit is named with its apparent size', () => {
    const heavy = heavyEntries(
      inventoryOf([
        { path: 'app.ts', kind: 'file', bytes: 4 * MB },
        { path: '.build/cache.v1', kind: 'file', bytes: 38 * GB },
      ]),
    );

    expect(heavy).toEqual([
      { path: '.build', kind: 'dir', bytes: 38 * GB },
      { path: '.build/cache.v1', kind: 'file', bytes: 38 * GB },
    ]);
  });

  test('a folder is the sum of the files it holds', () => {
    const heavy = heavyEntries(
      inventoryOf([
        { path: 'assets', kind: 'dir', bytes: 0 },
        ...Array.from({ length: 6 }, (_, index) => ({
          path: `assets/clip-${index}.mov`,
          kind: 'file' as const,
          bytes: 400 * MB,
        })),
      ]),
    );

    expect(heavy).toEqual([{ path: 'assets', kind: 'dir', bytes: 6 * 400 * MB }]);
  });

  test('a folder is counted at every level, the file too', () => {
    const heavy = heavyEntries(
      inventoryOf([
        { path: 'out', kind: 'dir', bytes: 0 },
        { path: 'out/build', kind: 'dir', bytes: 0 },
        { path: 'out/build/data.bin', kind: 'file', bytes: 2 * GB },
      ]),
    );

    expect(heavy.map((entry) => entry.path)).toEqual(['out', 'out/build', 'out/build/data.bin']);
  });

  test('light folders and ignored ones are not reported', () => {
    expect(
      heavyEntries(
        inventoryOf([
          { path: 'src', kind: 'dir', bytes: 0 },
          { path: 'src/index.ts', kind: 'file', bytes: 100 },
        ]),
      ),
    ).toEqual([]);
  });

  test('the largest first, at most the limit', () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `big-${index}.bin`,
      kind: 'file' as const,
      bytes: (index + 1) * GB,
    }));

    const heavy = heavyEntries(inventoryOf(entries));

    expect(heavy.length).toBe(HEAVY_LIMITS.limit);
    expect(heavy[0]?.bytes).toBe(8 * GB);
  });

  test('a regenerable folder never reaches the list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-heavy-'));

    mkdirSync(join(root, '.build', 'CompilationCache'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.build', 'CompilationCache', 'data.v1'), 'x'.repeat(1000));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');

    const inventory = copyInventory(root);

    expect(inventory.synced.map((entry) => entry.path)).toEqual(['src', 'src/index.ts']);
    expect(heavyInFolder(root, { fileBytes: 10, folderBytes: 10, limit: 5 })).toEqual([
      { path: 'src', kind: 'dir', bytes: 11 },
      { path: 'src/index.ts', kind: 'file', bytes: 11 },
    ]);
  });
});
