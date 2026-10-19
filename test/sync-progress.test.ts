import { describe, expect, test } from 'bun:test';
import { syncProgress } from '@/integrations/mutagen.ts';

/** A session as v0.18.1 writes it, with the fields this file reads. */
function session(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      name: 'corami-app',
      status: 'scanning',
      successfulCycles: 0,
      alpha: { connected: true, scanned: true, files: 40, totalFileSize: 1200 },
      beta: { connected: true, scanned: true, files: 0, totalFileSize: 0 },
      ...overrides,
    },
  ]);
}

describe('syncProgress', () => {
  test('a scan is a wait, with what it is doing', () => {
    expect(syncProgress(session(), 'app')).toEqual({
      state: 'waiting',
      activity: 'Scanning the files',
    });
  });

  test('staging the files counts bytes when the size is known', () => {
    const raw = session({
      status: 'staging-beta',
      beta: {
        connected: true,
        scanned: true,
        stagingProgress: {
          receivedFiles: 3,
          expectedFiles: 10,
          receivedSize: 100,
          totalReceivedSize: 300,
        },
      },
    });

    expect(syncProgress(raw, 'app')).toEqual({
      state: 'count',
      activity: 'Writing the files here',
      received: 300,
      total: 1200,
      unit: 'bytes',
    });
  });

  test('without a size on the other side it counts files', () => {
    const raw = session({
      status: 'staging-beta',
      alpha: { connected: true, scanned: true, files: 10, totalFileSize: 0 },
      beta: {
        connected: true,
        scanned: true,
        stagingProgress: { receivedFiles: 3, expectedFiles: 10 },
      },
    });

    expect(syncProgress(raw, 'app')).toEqual({
      state: 'count',
      activity: 'Writing the files here',
      received: 3,
      total: 10,
      unit: 'files',
    });
  });

  test('a completed cycle is done, with the files of the copy', () => {
    const raw = session({
      status: 'watching',
      successfulCycles: 1,
      beta: { connected: true, scanned: true, files: 40, totalFileSize: 1200 },
    });

    expect(syncProgress(raw, 'app')).toEqual({
      state: 'done',
      activity: 'The first sync is complete',
      files: 40,
    });
  });

  test('a counted cycle is not a complete copy while the files are still written', () => {
    // Seen on a real import: the count goes up while beta is still staging.
    const raw = session({
      status: 'staging-beta',
      successfulCycles: 1,
      alpha: { connected: true, scanned: true, files: 2001, totalFileSize: 25_184_717 },
      beta: {
        connected: true,
        scanned: true,
        stagingProgress: {
          receivedFiles: 2000,
          expectedFiles: 2001,
          totalReceivedSize: 11_665_408,
        },
      },
    });

    // A single big file leaves the files at 0 for the whole transfer: the
    // bytes received are what moves, and they are real.
    expect(syncProgress(raw, 'app')).toEqual({
      state: 'count',
      activity: 'Writing the files here',
      received: 11_665_408,
      total: 25_184_717,
      unit: 'bytes',
    });
  });

  test('a halted session says why it stopped', () => {
    const raw = session({
      status: 'halted-on-root-emptied',
      lastError: 'root emptied',
    });

    expect(syncProgress(raw, 'app')).toEqual({
      state: 'halted',
      activity: 'root emptied',
    });
  });

  test('a retry says it, and keeps waiting', () => {
    const raw = session({
      status: 'connecting-alpha',
      lastError: 'transport: connection lost\nsecond line',
    });

    const progress = syncProgress(raw, 'app');
    expect(progress?.state).toBe('waiting');
    expect(progress?.activity).toBe('Retrying: transport: connection lost');
  });

  test('another project, no session and broken output are no answer', () => {
    expect(syncProgress(session(), 'other')).toBeUndefined();
    expect(syncProgress('[]', 'app')).toBeUndefined();
    expect(syncProgress('not json', 'app')).toBeUndefined();
  });
});
