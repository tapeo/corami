import { describe, expect, test } from 'bun:test';

import { renderUnit } from '@/integrations/systemd.ts';

describe('renderUnit', () => {
  test('writes a service with environment', () => {
    const unit = renderUnit(
      {
        name: 'corami-daemon',
        description: 'Corami daemon',
        execStart: '/usr/local/bin/corami daemon',
        environment: { HOME: '/root' },
      },
      'system',
    );

    expect(unit).toContain('ExecStart=/usr/local/bin/corami daemon');
    expect(unit).toContain('Environment=HOME=/root');
    expect(unit).toContain('Restart=on-failure');
  });

  test('a system unit starts with multi-user.target, after the network', () => {
    const unit = renderUnit({ name: 'a', description: 'a', execStart: 'true' }, 'system');

    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('Wants=network-online.target');
  });

  test('a user unit starts with default.target, the only boot target of the user manager', () => {
    const unit = renderUnit({ name: 'a', description: 'a', execStart: 'true' }, 'user');

    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('multi-user.target');
    expect(unit).not.toContain('network-online.target');
  });

  test('adds the user only for system units', () => {
    const withUser = renderUnit(
      { name: 'a', description: 'a', execStart: 'true', user: 'corami' },
      'system',
    );
    const withoutUser = renderUnit({ name: 'a', description: 'a', execStart: 'true' }, 'user');

    expect(withUser).toContain('User=corami');
    expect(withoutUser).not.toContain('User=');
  });
});
