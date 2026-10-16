import { describe, expect, test } from 'bun:test';

import { progressLine, stepLine } from '@/cli/commands/setup-steps.ts';

describe('setup progress', () => {
  test('a running step shows what it does, aligned with the result line', () => {
    const running = progressLine('git-watch', 'Restarting the git alignment service', 500);
    const ended = stepLine({ step: 'git-watch', status: 'done', summary: 'Installed' });

    expect(running).toBe('running  git-watch       Restarting the git alignment service...');
    expect(running.indexOf('Restarting')).toBe(ended.indexOf('Installed'));
  });

  test('the seconds appear once the wait is noticed', () => {
    expect(progressLine('serve', 'Publishing', 1999)).toBe(
      'running  serve           Publishing...',
    );
    expect(progressLine('serve', 'Publishing', 42_300)).toBe(
      'running  serve           Publishing... 42s',
    );
  });

  test('a narrow terminal cuts the activity and keeps the seconds', () => {
    const line = progressLine('git-watch', 'Restarting the git alignment service', 42_300, 40);

    expect(line).toBe('running  git-watch       Restart... 42s');
    expect(line.length).toBeLessThan(40);
  });

  test('an unknown terminal width counts as 80 columns', () => {
    const activity = 'Restarting the git alignment service';

    expect(progressLine('git-watch', activity, 0, 0)).toBe(progressLine('git-watch', activity, 0));
  });
});
