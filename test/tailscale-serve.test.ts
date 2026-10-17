import { describe, expect, test } from 'bun:test';

import { servedTargets } from '@/integrations/tailscale.ts';

describe('servedTargets', () => {
  const status = {
    TCP: { '3000': { HTTPS: true }, '7420': { HTTPS: true } },
    Web: {
      'vps.tail1a2b3c.ts.net:3000': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
      },
      'vps.tail1a2b3c.ts.net:7420': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } },
      },
      'vps.tail1a2b3c.ts.net:4100': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } },
      },
    },
  };

  test('reads the port and the target of every rule', () => {
    expect(servedTargets(status)).toEqual([
      { port: 3000, target: 'http://127.0.0.1:3000' },
      { port: 4100, target: 'http://127.0.0.1:3001' },
      { port: 7420, target: 'http://127.0.0.1:7420' },
    ]);
  });

  test('answers nothing without a status', () => {
    expect(servedTargets(undefined)).toEqual([]);
    expect(servedTargets({})).toEqual([]);
  });

  test('ignores a rule that does not forward to a proxy', () => {
    const text = {
      Web: {
        'vps.tail1a2b3c.ts.net:4100': { Handlers: { '/': { Text: 'hello' } } },
        'vps.tail1a2b3c.ts.net:4101': { Handlers: {} },
      },
    };

    expect(servedTargets(text)).toEqual([]);
  });
});
