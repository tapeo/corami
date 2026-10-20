import { userInfo } from 'node:os';

import type { CommandContext, CommandResult } from '@/cli/command.ts';
import {
  clientConfig,
  informServer,
  readAuthorizedKeys,
  stopGroup,
  writeAuthorizedKeys,
} from '@/cli/exec-client-config.ts';
import {
  clientOs,
  gateCommand,
  hostKey,
  readSshdConfig,
  reloadSshd,
  tailnetIdentity,
  writeSshdKeysOnly,
} from '@/cli/exec-client-system.ts';
import {
  listPending,
  listRunning,
  removeExecState,
  removePending,
  writeExecState,
} from '@/cli/exec-files.ts';
import { canPrompt, terminalPrompter } from '@/cli/prompt.ts';
import { execKey, probeClient, putClient } from '@/cli/server-client.ts';
import { CoramiError, toCoramiError } from '@/core/errors.ts';
import { authorizedKeyLine, findExecLine, withoutExecLine } from '@/core/exec-ssh-keys.ts';
import { sshdAcceptsPasswords, sshdKeysOnlyText } from '@/core/exec-sshd.ts';
import { execApproverSpec, installService, removeService } from '@/integrations/service.ts';

export async function allow(context: CommandContext): Promise<CommandResult> {
  const { server } = await clientConfig();

  if (!canPrompt(context.output)) {
    throw new CoramiError({
      code: 'usage',
      message: 'exec allow runs only in a terminal on the client',
      fix: 'Open a terminal on the client and run corami exec allow there',
    });
  }

  const prompter = terminalPrompter();

  if (sshdAcceptsPasswords(await readSshdConfig())) {
    prompter.say(
      '✗ sshd accepts passwords: anyone on the same network as this machine can try yours',
    );
    prompter.say('  Fix: corami exec allow writes /etc/ssh/sshd_config.d/100-corami.conf:');
    prompter.say('         PasswordAuthentication no');
    prompter.say('         KbdInteractiveAuthentication no');
    prompter.say('       Your own SSH keys keep working.');

    const proceed = await prompter.confirm('Write it now?', false);

    if (!proceed) {
      throw new CoramiError({
        code: 'usage',
        message: 'The channel stays off while sshd accepts passwords',
        fix: 'Write /etc/ssh/sshd_config.d/100-corami.conf yourself, then run corami exec allow again',
      });
    }

    if (!(await writeSshdKeysOnly(sshdKeysOnlyText()))) {
      throw new CoramiError({
        code: 'capability_missing',
        message: 'Cannot write the configuration of sshd',
        fix: 'Run corami exec allow from a terminal where sudo works',
      });
    }

    await reloadSshd();

    if (sshdAcceptsPasswords(await readSshdConfig())) {
      throw new CoramiError({
        code: 'config_invalid',
        message: 'The configuration of sshd still accepts passwords',
        fix: 'Add Include /etc/ssh/sshd_config.d/*.conf to /etc/ssh/sshd_config, then run corami exec allow again',
      });
    }
  }

  prompter.say('✓ sshd accepts keys only');

  const identity = await tailnetIdentity();
  const key = await hostKey();

  if (key === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'Cannot read the host key of sshd on this machine',
      fix: 'Check that /etc/ssh/ssh_host_ed25519_key.pub exists and is readable',
    });
  }

  prompter.say();
  prompter.say(
    `The server ${server} will be able to ask to run commands on this machine, as you, inside the copies of your projects.`,
  );
  prompter.say(
    'Nothing runs until you allow it: every new command asks first, in a dialog on this machine.',
  );
  prompter.say('You can turn it off at any time with: corami exec deny');
  prompter.say();

  if (!(await prompter.confirm('Allow it?', false))) {
    throw new CoramiError({
      code: 'usage',
      message: 'The channel stays off',
      fix: 'Run corami exec allow when you want the server to reach this machine',
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

  if (serverKey.ips.length === 0) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'The daemon of the server does not know its tailnet address',
      fix: 'Restart the daemon on the server: corami update, or systemctl --user restart corami-daemon',
    });
  }

  const line = authorizedKeyLine({
    gateCommand: await gateCommand(),
    publicKey: serverKey.public_key,
    server,
    addresses: serverKey.ips,
  });
  const existing = await readAuthorizedKeys();

  await writeAuthorizedKeys(`${withoutExecLine(existing, server)}${line}\n`);
  await writeExecState({ server, name: identity.name, since: new Date().toISOString() });

  const registration = {
    name: identity.name,
    ssh_host: identity.dnsName,
    ssh_user: userInfo().username,
    os: clientOs(),
    host_key: key,
    allowed: true,
    updated_at: new Date().toISOString(),
  };

  try {
    await putClient(registration);
    await probeClient(identity.name);
  } catch (error) {
    await writeAuthorizedKeys(withoutExecLine(await readAuthorizedKeys(), server));
    await removeExecState();
    await putClient({ ...registration, allowed: false }).catch(() => undefined);
    throw error;
  }

  const dialog = await installService(execApproverSpec(process.execPath)).catch((error) => ({
    installed: false,
    detail: toCoramiError(error).message,
  }));

  prompter.say(
    `✓ Key of ${server} added, only from ${serverKey.ips.join(', ')} and only for corami exec`,
  );
  prompter.say(`✓ Registered on the server as ${identity.name}`);
  prompter.say(`✓ Checked from the server: ${server} reached this machine`);

  if (dialog.installed) {
    prompter.say('✓ Approval dialog on: new commands ask here, or in corami exec approve');
  } else {
    prompter.say(
      `⚠ Approval dialog not installed (${dialog.detail}): answer with corami exec approve`,
    );
  }

  return {};
}

export async function deny(context: CommandContext): Promise<CommandResult> {
  const { server } = await clientConfig();
  const existing = await readAuthorizedKeys();
  const line = findExecLine(existing, server);
  const running = await listRunning();
  const waiting = await listPending();
  let stopped = 0;

  await writeAuthorizedKeys(withoutExecLine(existing, server));
  await removeExecState();

  for (const command of running) {
    if (stopGroup(command)) {
      stopped += 1;
    }
  }

  for (const request of waiting) {
    await removePending(request.id);
  }

  const dialogRemoved = await removeService(execApproverSpec(process.execPath)).catch(() => false);
  const informed = await informServer(false);

  if (context.output.json) {
    return {
      data: {
        server,
        removed: line !== undefined,
        stopped,
        cancelled: waiting.length,
        dialog_removed: dialogRemoved,
        server_informed: informed,
      },
    };
  }

  const lines = [
    `✓ Key of ${server} removed: the server can no longer run commands here`,
    `✓ Stopped ${stopped} running ${stopped === 1 ? 'command' : 'commands'}`,
  ];

  if (dialogRemoved) {
    lines.push('✓ Approval dialog removed');
  }

  if (waiting.length > 0) {
    lines.push(
      `✓ Cancelled ${waiting.length} waiting ${waiting.length === 1 ? 'request' : 'requests'}`,
    );
  }

  lines.push(
    informed ? '✓ Server informed' : 'Server not reachable: it still lists this machine as allowed',
  );

  return { text: lines.join('\n') };
}
