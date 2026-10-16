import { describe, expect, test } from 'bun:test';

import { renderUnit } from '@/integrations/systemd.ts';

describe('renderUnit', () => {
  test('writes a user service with environment', () => {
    const unit = renderUnit({
      name: 'corami-daemon',
      description: 'Corami daemon',
      execStart: '/usr/local/bin/corami daemon',
      environment: { HOME: '/root' },
    });

    expect(unit).toContain('ExecStart=/usr/local/bin/corami daemon');
    expect(unit).toContain('Environment=HOME=/root');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('Restart=on-failure');
  });

  test('adds the user only for system units', () => {
    const withUser = renderUnit({
      name: 'a',
      description: 'a',
      execStart: 'true',
      user: 'corami',
    });
    const withoutUser = renderUnit({ name: 'a', description: 'a', execStart: 'true' });

    expect(withUser).toContain('User=corami');
    expect(withoutUser).not.toContain('User=');
  });
});
