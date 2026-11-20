import { describe, expect, test } from 'bun:test';

import { EventEmitter } from 'node:events';

import {
  failure,
  flushOutput,
  renderNextSteps,
  renderOrphanCopies,
  renderSteps,
  renderTable,
  success,
  write,
} from '@/cli/output.ts';
import { CoramiError, exitCodeFor, toCoramiError } from '@/core/errors.ts';

class FakeStream extends EventEmitter {
  readonly written: string[] = [];

  constructor(readonly acceptsWrite: boolean) {
    super();
  }

  write(text: string): boolean {
    this.written.push(text);
    return this.acceptsWrite;
  }
}

function fakeStream(acceptsWrite: boolean): NodeJS.WriteStream & FakeStream {
  return new FakeStream(acceptsWrite) as unknown as NodeJS.WriteStream & FakeStream;
}

describe('write and flushOutput', () => {
  test('a write the stream takes ends with the flush', async () => {
    const stream = fakeStream(true);

    write(stream, 'text');
    await flushOutput();

    expect(stream.written).toEqual(['text']);
  });

  test('a buffered write waits for the drain', async () => {
    const stream = fakeStream(false);

    write(stream, 'text');
    const flushed = flushOutput();

    stream.emit('drain');
    await flushed;
  });

  test('a buffered write does not wait forever when the reader is gone', async () => {
    const stream = fakeStream(false);

    write(stream, 'text');
    const flushed = flushOutput();

    stream.emit('error', new Error('write EPIPE'));
    await flushed;
  });

  test('a stream that closes also ends the wait', async () => {
    const stream = fakeStream(false);

    write(stream, 'text');
    const flushed = flushOutput();

    stream.emit('close');
    await flushed;
  });

  test('a broken stream takes no more text', async () => {
    const stream = fakeStream(false);

    write(stream, 'first');
    stream.emit('error', new Error('write EPIPE'));
    await flushOutput();

    write(stream, 'second');
    expect(stream.written).toEqual(['first']);
  });
});

describe('envelope', () => {
  test('wraps successful data', () => {
    expect(success({ version: '0.0.1' })).toEqual({ ok: true, data: { version: '0.0.1' } });
  });

  test('carries code, message and fix', () => {
    const envelope = failure(
      new CoramiError({
        code: 'capability_missing',
        message: 'Command not found: flutter',
        fix: 'Install flutter on the server',
      }),
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('capability_missing');
    expect(envelope.error.fix).toBe('Install flutter on the server');
  });
});

describe('exit codes', () => {
  test('maps capability_missing to 3', () => {
    expect(exitCodeFor('capability_missing')).toBe(3);
  });

  test('maps sync_conflict to 4', () => {
    expect(exitCodeFor('sync_conflict')).toBe(4);
  });

  test('maps server_unreachable to 5', () => {
    expect(exitCodeFor('server_unreachable')).toBe(5);
  });

  test('maps usage to 2', () => {
    expect(exitCodeFor('usage')).toBe(2);
  });
});

describe('toCoramiError', () => {
  test('keeps a CoramiError as is', () => {
    const error = new CoramiError({ code: 'project_exists', message: 'already there' });
    expect(toCoramiError(error)).toBe(error);
  });

  test('wraps a plain error', () => {
    const wrapped = toCoramiError(new Error('boom'));
    expect(wrapped.code).toBe('generic');
    expect(wrapped.message).toBe('boom');
  });
});

describe('renderTable', () => {
  test('aligns columns', () => {
    const table = renderTable(
      [
        { name: 'shop-app', port: 4101 },
        { name: 'landing', port: 4200 },
      ],
      [
        { header: 'Project', value: (row) => row.name },
        { header: 'Port', value: (row) => String(row.port) },
      ],
    );

    expect(table.split('\n')).toEqual(['Project   Port', 'shop-app  4101', 'landing   4200']);
  });
});

describe('renderSteps', () => {
  test('puts the detail of a step under the table', () => {
    const lines = renderSteps([
      { step: 'key', status: 'done', summary: 'Key created', detail: '~/.ssh/id_ed25519.pub' },
      { step: 'verify', status: 'failed', summary: 'Connection refused' },
    ]);

    expect(lines[0]?.split('\n')[0]).toMatch(/^Step +Result +Detail$/);
    expect(lines.slice(1)).toEqual(['key: ~/.ssh/id_ed25519.pub']);
  });
});

describe('renderNextSteps', () => {
  test('one step on one line, several as a list, none as nothing', () => {
    expect(renderNextSteps(['corami sync add myapp'])).toEqual([
      '',
      'Next step: corami sync add myapp',
    ]);
    expect(renderNextSteps(['corami sync add a', 'corami sync add b'])).toEqual([
      '',
      'Next steps:',
      '  corami sync add a',
      '  corami sync add b',
    ]);
    expect(renderNextSteps([])).toEqual([]);
  });
});

describe('renderOrphanCopies', () => {
  test('names the copy and the command that stops it', () => {
    expect(renderOrphanCopies([{ project: 'site', local: '/Users/me/corami/site' }])).toEqual([
      'Copy of a removed project: site at /Users/me/corami/site. corami sync stop site stops the sync and keeps the files.',
    ]);
    expect(renderOrphanCopies([])).toEqual([]);
  });
});
