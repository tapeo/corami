import type { Role } from '@/core/config.ts';

// The pure decisions behind the questions of `corami setup` in a terminal: the
// roles a machine can take, the servers proposed to a client, how an answer is
// read. The prompts themselves live in `src/cli/prompt.ts`.

export interface TailnetPeer {
  dnsName: string;
  hostName: string;
  os: string;
  online: boolean;
}

/** The roles this platform can take: the server runs on Linux only. */
export function roleChoices(platform: string): Role[] {
  return platform === 'linux' ? ['server', 'client'] : ['client'];
}

/**
 * The role proposed first: the one already configured on this machine, else
 * the server on Linux, where the setup usually runs on a fresh VPS.
 */
export function defaultRole(platform: string, configured: Role | undefined): Role {
  const choices = roleChoices(platform);

  if (configured !== undefined && choices.includes(configured)) {
    return configured;
  }

  return choices[0] ?? 'client';
}

/**
 * The peers worth asking for a Corami daemon: online Linux machines with a
 * MagicDNS name, the ones whose name starts with `corami` first.
 */
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

/**
 * The login proposed as owner of the daemon: the account that signed the
 * server in. A node signed in with a tagged key belongs to no person.
 */
export function proposedOwner(login: string | undefined): string | undefined {
  if (login === undefined || login === '' || login === 'tagged-devices') {
    return undefined;
  }

  return login;
}

/** True when `ufw status` shows the firewall of `--firewall` already in place. */
export function isTailnetOnlyFirewall(ufwStatus: string): boolean {
  return /^Status: active$/m.test(ufwStatus) && /tailscale0\s+ALLOW/.test(ufwStatus);
}

/** A yes or no answer; an empty one takes the default, anything else is unclear. */
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

/**
 * The index picked from a numbered list, counted from 1 on screen; an empty
 * answer takes the default.
 */
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
