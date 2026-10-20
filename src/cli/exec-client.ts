import { userInfo } from 'node:os';

import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { clientConfig, readAuthorizedKeys, writeAuthorizedKeys } from '@/cli/exec-client-config.ts';
import { clientOs, gateCommand, hostKey, tailnetIdentity } from '@/cli/exec-client-system.ts';
import { execKey, probeClient, putClient } from '@/cli/server-client.ts';
import { CoramiError } from '@/core/errors.ts';
import { authorizedKeyLine, withoutExecLine } from '@/core/exec-ssh-keys.ts';

export async function setup(context: CommandContext): Promise<CommandResult> {
  const { server } = await clientConfig();
  const identity = await tailnetIdentity();
  const key = await hostKey();

  if (key === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'Cannot read the host key of sshd on this machine',
      fix: 'Check that /etc/ssh/ssh_host_ed25519_key.pub exists and is readable',
    });
  }

  const serverKey = await execKey();

  if (serverKey.public_key === '') {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'The daemon of the server did not give its exec key',
      fix: 'Restart the daemon on the server: corami update, or systemctl --user restart corami-daemon',
    });
  }

  const gate = await gateCommand();
  const line = authorizedKeyLine({ gateCommand: gate, publicKey: serverKey.public_key, server });
  const existing = await readAuthorizedKeys();

  await writeAuthorizedKeys(`${withoutExecLine(existing, server)}${line}\n`);

  const registration = {
    name: identity.name,
    ssh_host: identity.dnsName,
    ssh_user: userInfo().username,
    os: clientOs(),
    host_key: key,
    updated_at: new Date().toISOString(),
  };

  try {
    await putClient(registration);
    await probeClient(identity.name);
  } catch (error) {
    await writeAuthorizedKeys(withoutExecLine(await readAuthorizedKeys(), server));
    throw error;
  }

  const data = { server, name: identity.name, gate };

  if (context.output.json) {
    return { data };
  }

  return {
    text: [
      `✓ Key of ${server} added to authorized_keys, limited to ${gate}`,
      `✓ Registered on the server as ${identity.name}`,
      `✓ Checked from the server: ${server} reached this machine`,
    ].join('\n'),
  };
}
