import { run } from '@/core/exec.ts';
import type { TailnetPeer } from '@/core/setup-choices.ts';

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  online: boolean;
  dnsName?: string | undefined;
  tailnetName?: string | undefined;
  ipv4?: string | undefined;
  loginName?: string | undefined;
}

export async function isInstalled(): Promise<boolean> {
  const result = await run('tailscale', ['version']);
  return result.ok;
}

export async function status(): Promise<TailscaleStatus> {
  if (!(await isInstalled())) {
    return { installed: false, running: false, online: false };
  }

  const result = await run('tailscale', ['status', '--json']);

  if (!result.ok) {
    return { installed: true, running: false, online: false };
  }

  const parsed = parseJson(result.stdout);

  if (parsed === undefined) {
    return { installed: true, running: false, online: false };
  }

  const self = parsed.Self;
  const dnsName = readString(self, 'DNSName');
  const online = readBoolean(self, 'Online');
  const tailnetName = readTailnetName(dnsName);

  return {
    installed: true,
    running: true,
    online,
    dnsName: normalizeDnsName(dnsName),
    tailnetName,
    ipv4: readFirstIpv4(self),
    loginName: readSelfLogin(parsed),
  };
}

/** The other machines of the tailnet, from `tailscale status --json`. */
export async function peers(): Promise<TailnetPeer[]> {
  const result = await run('tailscale', ['status', '--json']);

  return result.ok ? readPeers(parseJson(result.stdout)) : [];
}

export function readPeers(status: Record<string, unknown> | undefined): TailnetPeer[] {
  const peerMap = status?.Peer;

  if (!isRecord(peerMap)) {
    return [];
  }

  return Object.values(peerMap).map((peer) => ({
    dnsName: normalizeDnsName(readString(peer, 'DNSName')) ?? '',
    hostName: readString(peer, 'HostName') ?? '',
    os: readString(peer, 'OS') ?? '',
    online: readBoolean(peer, 'Online'),
  }));
}

// The login of the account that signed this machine in: `Self.UserID` points
// into the `User` map.
export function readSelfLogin(status: Record<string, unknown> | undefined): string | undefined {
  const self = status?.Self;
  const users = status?.User;

  if (!isRecord(self) || !isRecord(users)) {
    return undefined;
  }

  const id = self.UserID;

  if (typeof id !== 'number' && typeof id !== 'string') {
    return undefined;
  }

  return readString(users[String(id)], 'LoginName');
}

/** Whether Tailscale SSH is on for this machine; undefined when it cannot be read. */
export async function sshEnabled(): Promise<boolean | undefined> {
  const result = await run('tailscale', ['debug', 'prefs']);

  if (!result.ok) {
    return undefined;
  }

  const prefs = parseJson(result.stdout);

  return prefs === undefined ? undefined : prefs.RunSSH === true;
}

export async function up(options: { hostname?: string; ssh?: boolean } = {}): Promise<void> {
  const args = ['up'];

  if (options.ssh !== false) {
    args.push('--ssh');
  }

  if (options.hostname !== undefined) {
    args.push('--hostname', options.hostname);
  }

  await run('tailscale', args);
}

/** Makes `user` the operator of this node, so that it can run `tailscale serve`. */
export async function setOperator(user: string): Promise<{ ok: boolean; detail: string }> {
  const result = await run('tailscale', ['set', `--operator=${user}`]);
  const output = `${result.stderr}${result.stdout}`.trim();

  return {
    ok: result.ok,
    detail: output.split('\n').slice(0, 3).join(' '),
  };
}

export async function serveHttps(
  port: number,
  target = `http://127.0.0.1:${port}`,
): Promise<{ ok: boolean; detail: string }> {
  const result = await run('tailscale', ['serve', '--bg', `--https=${port}`, target]);
  const output = `${result.stderr}${result.stdout}`.trim();

  return {
    ok: result.ok,
    detail: output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 3)
      .join(' '),
  };
}

export async function serveOff(port: number): Promise<{ ok: boolean; detail: string }> {
  const result = await run('tailscale', ['serve', `--https=${port}`, 'off']);

  return {
    ok: result.ok,
    detail: `${result.stderr}${result.stdout}`.trim(),
  };
}

export async function serveStatus(): Promise<Record<string, unknown> | undefined> {
  const result = await run('tailscale', ['serve', 'status', '--json']);

  if (!result.ok) {
    return undefined;
  }

  return parseJson(result.stdout);
}

export interface ServeTarget {
  port: number;
  target: string;
}

/**
 * The HTTPS rules of this machine, from `tailscale serve status --json`: the
 * public port and the local address it forwards to.
 */
export function servedTargets(status: Record<string, unknown> | undefined): ServeTarget[] {
  if (status === undefined) {
    return [];
  }

  const web = isRecord(status.Web) ? status.Web : {};
  const targets: ServeTarget[] = [];

  for (const [hostname, entry] of Object.entries(web)) {
    const port = publicPortOf(hostname);

    if (port === undefined || !isRecord(entry)) {
      continue;
    }

    const handlers = isRecord(entry.Handlers) ? entry.Handlers : {};
    const root = handlers['/'];

    if (!isRecord(root) || typeof root.Proxy !== 'string') {
      continue;
    }

    targets.push({ port, target: root.Proxy });
  }

  return targets.sort((left, right) => left.port - right.port);
}

function publicPortOf(hostname: string): number | undefined {
  const port = hostname.slice(hostname.lastIndexOf(':') + 1);
  return /^\d+$/.test(port) ? Number(port) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean {
  if (typeof source !== 'object' || source === null) {
    return false;
  }

  return (source as Record<string, unknown>)[key] === true;
}

function readFirstIpv4(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const addresses = (source as Record<string, unknown>).TailscaleIPs;

  if (!Array.isArray(addresses)) {
    return undefined;
  }

  for (const address of addresses) {
    if (typeof address === 'string' && !address.includes(':')) {
      return address;
    }
  }

  return undefined;
}

function normalizeDnsName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.replace(/\.$/, '');
}

function readTailnetName(dnsName: string | undefined): string | undefined {
  const normalized = normalizeDnsName(dnsName);

  if (normalized === undefined) {
    return undefined;
  }

  const parts = normalized.split('.');

  if (parts.length < 2) {
    return undefined;
  }

  return parts.slice(1).join('.');
}
