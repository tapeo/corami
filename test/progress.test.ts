import { describe, expect, test } from 'bun:test';
import { progressLine } from '@/cli/commands/setup-steps.ts';
import { barLine, formatBytes } from '@/cli/progress.ts';

const base = {
  step: 'transfer',
  activity: 'Sending the files',
  unit: 'bytes' as const,
  elapsedMs: 12_000,
  width: 80,
};

describe('formatBytes', () => {
  test('a unit of its own until a thousand', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  test('a decimal under a hundred, none above', () => {
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(48_100_000)).toBe('48.1 MB');
    expect(formatBytes(100_000_000)).toBe('100 MB');
  });
});

describe('barLine', () => {
  test('counts bytes with a bar, a percentage and the amount', () => {
    const line = barLine({ ...base, done: 48_100_000, total: 100_000_000 });

    expect(line.startsWith('running  transfer')).toBe(true);
    expect(line).toContain('[███████░░░░░░░░░]');
    expect(line).toContain(' 48%');
    expect(line).toContain('48.1 MB/100 MB');
    expect(line).toContain('12s');
    // A wrapped line cannot be erased, so the line never fills the terminal.
    expect(line.length).toBeLessThan(80);
  });

  test('stops at 99: the line goes away when the phase ends', () => {
    const line = barLine({ ...base, done: 120_000_000, total: 100_000_000 });

    expect(line).toContain(' 99%');
    expect(line).not.toContain('100%');
  });

  test('without a total it is the line of a phase that only takes time', () => {
    const generic = progressLine('transfer', 'Sending the files', 12_000, 80);

    expect(barLine({ ...base, done: 10, total: undefined })).toBe(generic);
    expect(barLine({ ...base, done: 10, total: 0 })).toBe(generic);
  });

  test('a width of nothing counts as eighty columns', () => {
    const line = barLine({ ...base, done: 50, total: 100, width: 0 });

    expect(line).toBe(barLine({ ...base, done: 50, total: 100 }));
  });

  test('a narrow terminal keeps the percentage and drops the bar', () => {
    const line = barLine({ ...base, done: 48, total: 100, unit: 'files', width: 40 });

    expect(line).not.toContain('[');
    expect(line).toContain('48%');
    expect(line.length).toBeLessThan(40);
  });

  test('counts files and objects without a unit', () => {
    const line = barLine({ ...base, done: 12, total: 40, unit: 'files', elapsedMs: 1000 });

    expect(line).toContain('12/40');
    expect(line).toContain(' 30%');
    expect(line).toContain('1s');
  });
});
