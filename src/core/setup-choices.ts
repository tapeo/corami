import type { Role } from '@/core/config.ts';

export interface TailnetPeer {
  dnsName: string;
  hostName: string;
  os: string;
  online: boolean;
}

export function roleChoices(platform: string): Role[] {
  return platform === 'linux' ? ['server', 'client'] : ['client'];
}

export function defaultRole(platform: string, configured: Role | undefined): Role {
  const choices = roleChoices(platform);

  if (configured !== undefined && choices.includes(configured)) {
    return configured;
  }

  return choices[0] ?? 'client';
}

export function serverCandidates(peers: TailnetPeer[]): string[] {
  return peers
    .filter((peer) => peer.online && peer.os === 'linux' && peer.dnsName !== '')
    .sort((left, right) => {
      const leftCorami = left.hostName.startsWith('corami') ? 0 : 1;
      const rightCorami = right.hostName.startsWith('corami') ? 0 : 1;

      return leftCorami - rightCorami || left.dnsName.localeCompare(right.dnsName);
    })
    .map((peer) => peer.dnsName);
}

export function proposedOwner(login: string | undefined): string | undefined {
  if (login === undefined || login === '' || login === 'tagged-devices') {
    return undefined;
  }

  return login;
}

export function isTailnetOnlyFirewall(ufwStatus: string): boolean {
  return /^Status: active$/m.test(ufwStatus) && /tailscale0\s+ALLOW/.test(ufwStatus);
}

export function parseYesNo(answer: string, fallback: boolean): boolean | undefined {
  const normalized = answer.trim().toLowerCase();

  if (normalized === '') {
    return fallback;
  }

  if (normalized === 'y' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'n' || normalized === 'no') {
    return false;
  }

  return undefined;
}

export function parseChoice(answer: string, count: number, fallback: number): number | undefined {
  const normalized = answer.trim();

  if (normalized === '') {
    return fallback;
  }

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const index = Number(normalized) - 1;

  return index >= 0 && index < count ? index : undefined;
}
