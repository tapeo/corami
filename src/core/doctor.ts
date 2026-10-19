import { run } from '@/core/exec.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  summary: string;
  detail?: string | undefined;
  fix?: string | undefined;
}

export async function checkTailscale(): Promise<CheckResult[]> {
  const version = await run('tailscale', ['version']);

  if (!version.ok) {
    return [
      {
        id: 'tailscale.installed',
        status: 'skip',
        summary: 'tailscale not installed',
        fix: 'Run corami setup server to install and configure it',
      },
    ];
  }

  const status = await run('tailscale', ['status', '--json']);

  if (!status.ok) {
    return [
      { id: 'tailscale.installed', status: 'ok', summary: 'tailscale installed' },
      {
        id: 'tailscale.connected',
        status: 'fail',
        summary: 'tailscale not connected',
        fix: 'Run tailscale up --ssh --hostname <name>',
      },
    ];
  }

  const parsed = parseJson(status.stdout);

  if (parsed === undefined) {
    return [
      {
        id: 'tailscale.status',
        status: 'fail',
        summary: 'tailscale status is not valid JSON',
      },
    ];
  }

  const self = parsed.Self;
  const dnsName = readString(self, 'DNSName');
  const online = readBoolean(self, 'Online');

  return [
    { id: 'tailscale.installed', status: 'ok', summary: 'tailscale installed' },
    {
      id: 'tailscale.connected',
      status: online ? 'ok' : 'warn',
      summary: online ? 'tailscale connected' : 'tailscale not online',
      detail: dnsName,
    },
  ];
}

export async function checkServeRules(): Promise<CheckResult[]> {
  const status = await run('tailscale', ['serve', 'status', '--json']);

  if (!status.ok) {
    return [
      {
        id: 'serve.rules',
        status: 'skip',
        summary: 'no tailscale serve rules',
      },
    ];
  }

  const parsed = parseJson(status.stdout);

  if (parsed === undefined) {
    return [
      {
        id: 'serve.rules',
        status: 'warn',
        summary: 'tailscale serve status is not valid JSON',
      },
    ];
  }

  const count = countEndpoints(parsed);

  return [
    {
      id: 'serve.rules',
      status: 'ok',
      summary: count === 0 ? 'no serve rules yet' : `${count} serve endpoints`,
    },
  ];
}

export async function checkListeningPorts(): Promise<CheckResult[]> {
  if (process.platform !== 'linux') {
    return [
      {
        id: 'net.exposed_ports',
        status: 'skip',
        summary: 'exposed port check runs on the server',
      },
    ];
  }

  const ss = await run('ss', ['-ltnp']);

  if (!ss.ok) {
    return [
      {
        id: 'net.exposed_ports',
        status: 'skip',
        summary: 'ss not available',
      },
    ];
  }

  const exposed = findExposedPorts(ss.stdout, await tailnetAddresses());

  if (exposed.length === 0) {
    return [
      {
        id: 'net.exposed_ports',
        status: 'ok',
        summary: 'no ports exposed outside localhost',
      },
    ];
  }

  return [
    {
      id: 'net.exposed_ports',
      status: 'fail',
      summary: `${exposed.length} ports listening outside 127.0.0.1`,
      detail: exposed.join(', '),
      fix: 'Bind the service to 127.0.0.1. Docker containers publish ports on 0.0.0.0 by default',
    },
  ];
}

export async function checkPinnedTools(): Promise<CheckResult[]> {
  const { findTool, MUTAGEN } = await import('@/core/pinned-tools.ts');
  const found = await findTool(MUTAGEN);
  const installed = found !== undefined;
  const results: CheckResult[] = [
    {
      id: 'mutagen.installed',
      status: installed ? 'ok' : 'skip',
      summary: installed ? 'mutagen installed' : 'mutagen not installed',
      detail: found,
      fix: installed ? undefined : 'Installed by corami setup client on this machine',
    },
  ];

  return results;
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

function countEndpoints(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return 0;
  }

  return Object.keys(value).length;
}

async function tailnetAddresses(): Promise<string[]> {
  const result = await run('tailscale', ['status', '--json']);

  if (!result.ok) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as { Self?: { TailscaleIPs?: unknown } };
    const ips = parsed.Self?.TailscaleIPs;

    if (!Array.isArray(ips)) {
      return [];
    }

    return ips.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function splitAddress(local: string): { address: string; port: string } | undefined {
  const match = local.match(/^(.*):(\d+)$/);

  if (match === null) {
    return undefined;
  }

  let address = match[1] ?? '';
  const port = match[2] ?? '';
  const zone = address.indexOf('%');

  if (zone !== -1) {
    address = address.slice(0, zone);
  }

  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }

  return { address, port };
}

function isLoopback(address: string): boolean {
  return address.startsWith('127.') || address === '::1';
}

export function findExposedPorts(ssOutput: string, ignore: string[] = []): string[] {
  const exposed: string[] = [];

  for (const line of ssOutput.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('State')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    const local = parts[3];

    if (local === undefined) {
      continue;
    }

    const parsed = splitAddress(local);

    if (parsed === undefined) {
      continue;
    }

    if (isLoopback(parsed.address) || ignore.includes(parsed.address)) {
      continue;
    }

    const shown = parsed.address.includes(':') ? `[${parsed.address}]` : parsed.address;
    exposed.push(`${shown}:${parsed.port}`);
  }

  return exposed;
}
