import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { commandPath, run, shellQuote } from '@/core/exec.ts';
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

export async function readSshdConfig(): Promise<string> {
  const effective = await run('sshd', ['-T'], { timeoutMs: 10_000 });

  if (effective.ok && effective.stdout.trim() !== '') {
    return effective.stdout;
  }

  return expandIncludes(readConfigFile('/etc/ssh/sshd_config'), 0);
}

function readConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function expandIncludes(text: string, depth: number): string {
  if (depth > 3) {
    return text;
  }

  const lines: string[] = [];

  for (const line of text.split('\n')) {
    const match = /^\s*Include\s+([^\s#]+)/i.exec(line);

    if (match === null) {
      lines.push(line);
      continue;
    }

    const files = includeFiles(match[1] ?? '');

    if (files.length === 0) {
      lines.push(line);
      continue;
    }

    for (const file of files) {
      lines.push(expandIncludes(readConfigFile(file), depth + 1));
    }
  }

  return lines.join('\n');
}

function includeFiles(pattern: string): string[] {
  if (!pattern.includes('*')) {
    return existsSync(pattern) ? [pattern] : [];
  }

  const folder = dirname(pattern);
  const glob = new RegExp(
    `^${basename(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
  );

  try {
    return readdirSync(folder)
      .filter((name) => glob.test(name))
      .sort()
      .map((name) => join(folder, name));
  } catch {
    return [];
  }
}

export async function writeSshdKeysOnly(content: string): Promise<boolean> {
  ensureExecDir();

  const source = join(paths().exec, 'sshd.conf');

  await Bun.write(source, content);

  const installed = await runInteractive('sudo', [
    'install',
    '-m',
    '644',
    source,
    '/etc/ssh/sshd_config.d/100-corami.conf',
  ]);

  return installed === 0;
}

export async function reloadSshd(): Promise<void> {
  if (process.platform === 'darwin') {
    await runInteractive('sudo', ['launchctl', 'kickstart', '-k', 'system/com.openssh.sshd']);
    return;
  }

  const reloaded = await runInteractive('sudo', ['systemctl', 'reload', 'sshd']);

  if (reloaded !== 0) {
    await runInteractive('sudo', ['systemctl', 'reload', 'ssh']);
  }
}

async function runInteractive(command: string, args: string[]): Promise<number> {
  try {
    const child = Bun.spawn({
      cmd: [command, ...args],
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    return await child.exited;
  } catch {
    return 127;
  }
}

export function ensureExecDir(): void {
  mkdirSync(paths().exec, { recursive: true, mode: 0o700 });
}
