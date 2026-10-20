import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { shortName, tailnetIdentity } from '@/cli/exec-client-system.ts';
import type { RunningCommand } from '@/cli/exec-files.ts';
import { listClients, putClient } from '@/cli/server-client.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { sshDir } from '@/integrations/ssh.ts';

export async function clientConfig(): Promise<{ server: string }> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'client') {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'corami exec allow, deny and status run on a client',
      fix: 'Run corami setup client <server> on this machine first',
    });
  }

  return { server: shortName(config.server_host ?? '') };
}

export function authorizedKeysPath(): string {
  return join(sshDir(), 'authorized_keys');
}

export async function readAuthorizedKeys(): Promise<string> {
  try {
    return await Bun.file(authorizedKeysPath()).text();
  } catch {
    return '';
  }
}

export async function writeAuthorizedKeys(text: string): Promise<void> {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  await Bun.write(authorizedKeysPath(), text);
  chmodSync(authorizedKeysPath(), 0o600);
}

export async function informServer(allowed: boolean): Promise<boolean> {
  const identity = await tailnetIdentity().catch(() => undefined);

  if (identity === undefined) {
    return false;
  }

  try {
    const clients = await listClients();
    const client = clients.find((entry) => entry.name === identity.name);

    if (client === undefined) {
      return true;
    }

    await putClient({ ...client, allowed, updated_at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

export function stopGroup(command: RunningCommand): boolean {
  try {
    process.kill(-command.pgid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(command.pgid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
