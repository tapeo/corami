import { hostname } from 'node:os';

import { status as tailscaleStatus } from '@/integrations/tailscale.ts';

export interface TailnetIdentity {
  name: string;
  dnsName: string;
  ips: string[];
}

export async function tailnetIdentity(): Promise<TailnetIdentity> {
  const state = await tailscaleStatus().catch(() => undefined);
  const dnsName = state?.dnsName ?? '';
  const short = dnsName.split('.')[0] ?? '';
  const fallback = hostname().split('.')[0] ?? 'client';

  return {
    name: short === '' ? fallback : short,
    dnsName: dnsName === '' ? fallback : dnsName,
    ips: state?.ips ?? [],
  };
}
