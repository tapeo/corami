import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { shortName } from '@/cli/exec-client-system.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { sshDir } from '@/integrations/ssh.ts';

export async function clientConfig(): Promise<{ server: string }> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'client') {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'corami exec setup and status run on a client',
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
