import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { encodeGateRequest, probeRequest } from '@/core/exec-gate.ts';
import { withKnownHost } from '@/core/exec-ssh-keys.ts';
import { validProjectName } from '@/core/projects.ts';
import { type ClientRow, getClient, listClients, upsertClient } from '@/core/state.ts';
import { ensureExecKey } from '@/integrations/ssh.ts';
import { runOnClient } from '@/integrations/ssh-exec.ts';
import { status as tailscaleStatus } from '@/integrations/tailscale.ts';

export interface ExecApiResult {
  status: number;
  body: unknown;
}

export async function handleExecRoute(
  request: Request,
  rest: string[],
): Promise<ExecApiResult | undefined> {
  if (rest.length !== 1 || rest[0] !== 'key' || request.method !== 'GET') {
    return undefined;
  }

  const publicKey = await ensureExecKey();
  const tailscale = await tailscaleStatus().catch(() => undefined);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        public_key: publicKey,
        ip: tailscale?.ipv4 ?? null,
        ips: tailscale?.ips ?? [],
      },
    },
  };
}

export async function handleClientsRoute(
  request: Request,
  rest: string[],
): Promise<ExecApiResult | undefined> {
  if (rest.length === 0) {
    if (request.method !== 'GET') {
      return methodNotAllowed();
    }

    return { status: 200, body: { ok: true, data: { clients: listClients() } } };
  }

  const name = rest[0] ?? '';

  if (!validProjectName(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid client name: ${name}`,
      fix: 'A client name is the short hostname in the tailnet: letters, digits, dot, dash and underscore',
    });
  }

  if (rest.length === 1 && request.method === 'PUT') {
    return registerClient(name, await readBody(request));
  }

  if (rest.length === 2 && rest[1] === 'probe' && request.method === 'POST') {
    return probeClient(name);
  }

  return undefined;
}

async function registerClient(name: string, body: Record<string, unknown>): Promise<ExecApiResult> {
  const sshHost = textField(body, 'ssh_host');
  const sshUser = textField(body, 'ssh_user');
  const os = textField(body, 'os');
  const hostKey = textField(body, 'host_key');

  if (sshHost === '' || sshUser === '' || os === '' || hostKey === '') {
    throw new CoramiError({
      code: 'usage',
      message: 'The registration of a client needs ssh_host, ssh_user, os and host_key',
      fix: 'On the client, run corami exec allow again',
    });
  }

  await writeKnownHost(sshHost, hostKey);

  const row: ClientRow = {
    name,
    ssh_host: sshHost,
    ssh_user: sshUser,
    os,
    host_key: hostKey,
    allowed: body.allowed === true,
    updated_at: new Date().toISOString(),
  };

  upsertClient(row);

  return { status: 200, body: { ok: true, data: row } };
}

async function probeClient(name: string): Promise<ExecApiResult> {
  const client = getClient(name);

  if (client === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Client not found: ${name}`,
      fix: 'On the client, run corami exec allow',
    });
  }

  if (!client.allowed) {
    throw new CoramiError({
      code: 'usage',
      message: `${name} does not allow commands from this server`,
      fix: `On ${name}, run corami exec allow`,
    });
  }

  await runOnClient(client, encodeGateRequest(probeRequest()), { timeoutMs: 20_000 });

  return { status: 200, body: { ok: true, data: { reached: true } } };
}

async function writeKnownHost(host: string, hostKey: string): Promise<void> {
  const path = paths().execKnownHosts;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const existing = existsSync(path) ? await Bun.file(path).text() : '';
  const next = withKnownHost(existing, host, hostKey);

  await Bun.write(path, next);
}

function textField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();

  if (text.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function methodNotAllowed(): ExecApiResult {
  return {
    status: 405,
    body: { ok: false, error: { code: 'usage', message: 'Method not allowed' } },
  };
}
