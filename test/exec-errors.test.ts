import { describe, expect, test } from 'bun:test';
import { CoramiError } from '@/core/errors.ts';
import { gateErrorFromLine, gateErrorLine, remoteExecError } from '@/core/exec-errors.ts';

describe('the error line of the gate', () => {
  test('goes back to the error of the server', () => {
    const line = gateErrorLine(
      new CoramiError({
        code: 'sync_pending',
        message: 'The sync is not up to date',
        fix: 'corami sync status',
      }),
    );
    const error = gateErrorFromLine(line);

    expect(error?.code).toBe('sync_pending');
    expect(error?.message).toBe('The sync is not up to date');
    expect(error?.fix).toBe('corami sync status');
  });

  test('ignores a line that is not one of ours', () => {
    expect(gateErrorFromLine('Error: something else')).toBeUndefined();
    expect(gateErrorFromLine('corami-exec-error:{')).toBeUndefined();
    expect(gateErrorFromLine('corami-exec-error:{"code":"nope","message":"x"}')).toBeUndefined();
  });
});

describe('remoteExecError', () => {
  test('reads a refused key as a channel that is off', () => {
    const error = remoteExecError({
      client: 'macbook',
      exitCode: 255,
      stderr: 'me@macbook: Permission denied (publickey).',
    });

    expect(error?.message).toBe('macbook does not allow commands from this server');
    expect(error?.fix).toContain('corami exec setup');
  });

  test('reads a changed host key', () => {
    const error = remoteExecError({
      client: 'macbook',
      exitCode: 255,
      stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.',
    });

    expect(error?.message).toBe('The host key of macbook changed');
  });

  test('reads an unreachable client', () => {
    const error = remoteExecError({
      client: 'macbook',
      exitCode: 255,
      stderr: 'ssh: connect to host macbook port 22: Connection refused',
    });

    expect(error?.code).toBe('server_unreachable');
  });

  test('leaves the failure of the command alone', () => {
    expect(
      remoteExecError({ client: 'macbook', exitCode: 1, stderr: 'build failed' }),
    ).toBeUndefined();
  });
});
