import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { commandPath, shellQuote } from '@/core/exec.ts';
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

export function shortName(host: string): string {
  return host.split('.')[0] ?? host;
}

export function clientOs(): string {
  if (process.platform === 'darwin') {
    return 'macOS';
  }

  if (process.platform === 'linux') {
    return 'Linux';
  }

  return process.platform;
}

export async function hostKey(): Promise<string | undefined> {
  const candidates = [
    '/etc/ssh/ssh_host_ed25519_key.pub',
    '/etc/ssh/ssh_host_ecdsa_key.pub',
    '/etc/ssh/ssh_host_rsa_key.pub',
  ];

  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8').trim();

      if (text !== '') {
        return text;
      }
    } catch {}
  }

  return undefined;
}

export async function gateCommand(): Promise<string> {
  const installed = join(paths().bin, 'corami');

  if (existsSync(installed)) {
    return `${shellQuote(installed)} exec gate`;
  }

  const onPath = await commandPath('corami');

  if (onPath !== undefined) {
    return `${shellQuote(onPath)} exec gate`;
  }

  const script = process.argv[1];

  if (script !== undefined && script !== '') {
    return `${shellQuote(process.execPath)} ${shellQuote(resolve(script))} exec gate`;
  }

  throw new CoramiError({
    code: 'capability_missing',
    message: 'Cannot find the corami binary to give the gate to sshd',
    fix: 'Install corami in ~/.corami/bin, or run corami from its installed path',
  });
}
