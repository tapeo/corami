import { describe, expect, test } from 'bun:test';

import {
  commandRequest,
  encodeGateRequest,
  gateCopyDecision,
  gatePayload,
  parseGateRequest,
  probeRequest,
  terminalRefusal,
} from '@/core/exec-gate.ts';

describe('the request of the gate', () => {
  test('goes to the client and comes back whole', () => {
    const encoded = encodeGateRequest(commandRequest('myapp', ['flutter', 'devices']));
    expect(parseGateRequest(encoded)).toEqual({
      v: 1,
      project: 'myapp',
      argv: ['flutter', 'devices'],
    });
  });

  test('keeps the arguments without a shell', () => {
    const argv = ['sh', '-c', 'echo one; echo two'];
    const encoded = encodeGateRequest(commandRequest('myapp', argv));
    const parsed = parseGateRequest(encoded);

    expect(parsed !== undefined && 'argv' in parsed ? parsed.argv : []).toEqual(argv);
  });

  test('carries the probe', () => {
    expect(parseGateRequest(encodeGateRequest(probeRequest()))).toEqual({ v: 1, probe: true });
  });

  test('refuses what is not a request', () => {
    expect(parseGateRequest('not-base64')).toBeUndefined();
    expect(parseGateRequest(Buffer.from('{"v":2}').toString('base64url'))).toBeUndefined();
    expect(
      parseGateRequest(
        Buffer.from(JSON.stringify({ v: 1, project: '../etc', argv: ['ls'] })).toString(
          'base64url',
        ),
      ),
    ).toBeUndefined();
    expect(
      parseGateRequest(
        Buffer.from(JSON.stringify({ v: 1, project: 'myapp', argv: [] })).toString('base64url'),
      ),
    ).toBeUndefined();
  });
});

describe('gatePayload', () => {
  test('reads the payload of SSH_ORIGINAL_COMMAND', () => {
    expect(gatePayload('exec gate abc')).toBe('abc');
  });

  test('refuses anything else', () => {
    expect(gatePayload(undefined)).toBeUndefined();
    expect(gatePayload('rm -rf /')).toBeUndefined();
    expect(gatePayload('exec gate abc extra')).toBeUndefined();
  });
});

describe('gateCopyDecision', () => {
  test('accepts only a copy that is watching', () => {
    expect(gateCopyDecision([{ project: 'myapp', status: 'watching' }], 'myapp')).toBe('ok');
    expect(gateCopyDecision([{ project: 'myapp', status: 'staging-beta' }], 'myapp')).toBe(
      'pending',
    );
  });

  test('tells a missing copy from a sync engine that did not answer', () => {
    expect(gateCopyDecision([], 'myapp')).toBe('missing');
    expect(gateCopyDecision(undefined, 'myapp')).toBe('unavailable');
  });
});

describe('--tty', () => {
  const terminal = { json: false, stdinIsTty: true, stdoutIsTty: true };

  test('is accepted when both ends are a terminal', () => {
    expect(terminalRefusal(terminal)).toBeUndefined();
  });

  test('is refused without a terminal, as when an agent runs it', () => {
    expect(terminalRefusal({ ...terminal, stdinIsTty: false })?.message).toBe(
      '--tty needs a terminal',
    );
    expect(terminalRefusal({ ...terminal, stdoutIsTty: false })?.message).toBe(
      '--tty needs a terminal',
    );
  });

  test('does not combine with --json', () => {
    expect(terminalRefusal({ ...terminal, json: true })?.message).toBe(
      '--tty does not combine with --json',
    );
  });
});
