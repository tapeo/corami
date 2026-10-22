import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import {
  IGNORE_FILE,
  ignoreDrift,
  ignoresFor,
  keptIgnores,
  parseIgnores,
  projectIgnores,
  refreshPlan,
  sameIgnores,
} from '@/core/ignore-file.ts';
import { DEFAULT_IGNORES, GIT_IGNORES } from '@/integrations/mutagen.ts';

describe('the ignore file', () => {
  test('reads one pattern per line, comments and blank lines skipped', () => {
    const lines = parseIgnores(
      ['# a comment', '', ' .build/ ', '*.xcuserstate', 'tmp/**'].join('\n'),
    );

    expect(lines).toEqual([
      { line: 3, pattern: '.build/' },
      { line: 4, pattern: '*.xcuserstate' },
      { line: 5, pattern: 'tmp/**' },
    ]);
  });

  test('refuses a negation with the line number', () => {
    const error = (() => {
      try {
        parseIgnores('.build/\n!keep.me\n');
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(CoramiError);
    expect((error as CoramiError).message).toContain('line 2');
    expect((error as CoramiError).message).toContain('negation');
  });

  test('refuses an absolute path and a parent folder', () => {
    expect(() => parseIgnores('/etc/passwd')).toThrow(/leading \//);
    expect(() => parseIgnores('a/../b')).toThrow(/parent folder/);
  });

  test('a folder without the file has no project patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'corami-ignore-'));

    expect(projectIgnores(root)).toEqual([]);
    expect(ignoresFor(root)).toEqual([...GIT_IGNORES, ...DEFAULT_IGNORES]);
  });

  test('a worktree keeps the vcs exclusion and no corami files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'corami-ignore-'));
    writeFileSync(join(root, '.git'), 'gitdir: /tmp/other\n');

    expect(ignoresFor(root)).toEqual(DEFAULT_IGNORES);
  });

  test('the full list is the default one followed by the project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'corami-ignore-'));
    await writeFile(join(root, IGNORE_FILE), '.build/\nCoverageReports/\n');

    expect(projectIgnores(root)).toEqual(['.build/', 'CoverageReports/']);
    expect(ignoresFor(root).slice(-2)).toEqual(['.build/', 'CoverageReports/']);
    expect(ignoresFor(root).slice(0, GIT_IGNORES.length)).toEqual(GIT_IGNORES);
    expect(ignoresFor(root).slice(GIT_IGNORES.length, -2)).toEqual(DEFAULT_IGNORES);
  });
});

describe('kept ignores', () => {
  test('keeps what the session excludes and the current list does not', () => {
    expect(keptIgnores(['a/', 'b/'], ['a/', 'old/', 'b/'])).toEqual(['old/']);
  });

  test('drops the legacy vcs marker when the git exchange replaces it', () => {
    const expected = ['/.git/*', '!/.git/corami/', '*/**/.git', 'a/'];

    expect(keptIgnores(expected, ['.git/', 'a/', 'old/'])).toEqual(['old/']);
  });

  test('keeps the vcs marker of a worktree, where no exchange replaces it', () => {
    expect(keptIgnores(['a/'], ['.git/', 'a/'])).toEqual(['.git/']);
  });
});

describe('ignore drift', () => {
  test('compares without the order', () => {
    expect(sameIgnores(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIgnores(['a'], ['a', 'b'])).toBe(false);
    expect(sameIgnores(['a', 'a'], ['a', 'b'])).toBe(false);
  });

  test('names what is missing and what is no longer ignored', () => {
    const drift = ignoreDrift(['node_modules/', 'old/'], ['node_modules/', '.build/']);

    expect(drift.missing).toEqual(['.build/']);
    expect(drift.extra).toEqual(['old/']);
  });

  test('a session created before a rule is missing that rule', () => {
    const session = ['node_modules/', '.dart_tool/'];
    const expected = [...DEFAULT_IGNORES];

    expect(ignoreDrift(session, expected).missing).toContain('.build/');
  });
});

describe('the plan of a refresh', () => {
  test('a session already current is left alone', () => {
    const expected = ['a', 'b'];

    expect(refreshPlan(expected, expected, false)).toEqual({
      current: true,
      refuse: false,
      missing: [],
      extra: [],
    });
  });

  test('a missing pattern is added without asking', () => {
    const plan = refreshPlan(['a'], ['a', '.build/'], false);

    expect(plan.current).toBe(false);
    expect(plan.refuse).toBe(false);
    expect(plan.missing).toEqual(['.build/']);
  });

  test('a path the session leaves out is not carried again without --force', () => {
    const plan = refreshPlan(['a', '.env'], ['a'], false);

    expect(plan.refuse).toBe(true);
    expect(plan.extra).toEqual(['.env']);
    expect(refreshPlan(['a', '.env'], ['a'], true).refuse).toBe(false);
  });
});
