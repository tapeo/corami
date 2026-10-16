import { describe, expect, test } from 'bun:test';
import { findExposedPorts } from '@/core/doctor.ts';

const SS_OUTPUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          127.0.0.1:4101       0.0.0.0:*
LISTEN 0      511              [::1]:7420          [::]:*
LISTEN 0      4096          127.0.0.53%lo:53      0.0.0.0:*
LISTEN 0      128            0.0.0.0:4003         0.0.0.0:*
LISTEN 0      4096                 *:22               *:*
`;

describe('findExposedPorts', () => {
  test('ignores loopback', () => {
    const exposed = findExposedPorts(SS_OUTPUT);
    expect(exposed).not.toContain('127.0.0.1:4101');
    expect(exposed).not.toContain('::1:7420');
    expect(exposed).not.toContain('127.0.0.53:53');
  });

  test('ignores the tailnet addresses', () => {
    const listing = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096    100.64.0.1%tailscale0:7420    0.0.0.0:*
LISTEN 0      4096 [fd7a:115c:a1e0::1]%tailscale0:4100 0.0.0.0:*
`;
    const exposed = findExposedPorts(listing, ['100.64.0.1', 'fd7a:115c:a1e0::1']);
    expect(exposed).toEqual([]);
  });

  test('reports ports bound to every interface', () => {
    const exposed = findExposedPorts(SS_OUTPUT);
    expect(exposed).toContain('0.0.0.0:4003');
    expect(exposed).toContain('*:22');
  });

  test('returns nothing for an empty listing', () => {
    expect(findExposedPorts('')).toEqual([]);
  });
});
