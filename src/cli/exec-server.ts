import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { clientStatus } from '@/cli/exec-client-status.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import { listClients, listProjects } from '@/cli/server-client.ts';
import { readGlobalConfig, requireServerRole } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { commandRequest, encodeGateRequest } from '@/core/exec-gate.ts';
import { projectForPath } from '@/core/previews.ts';
import { runOnClient } from '@/integrations/ssh-exec.ts';
import { peers } from '@/integrations/tailscale.ts';

export async function remote(context: CommandContext): Promise<CommandResult> {
  await requireServerRole();

  const clientName = stringFlag(context.args, 'on');
  const argv = context.args.rest;

  if (clientName === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing --on',
      fix: 'corami exec --on macbook -- flutter devices',
    });
  }

  if (argv.length === 0) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing the command after --',
      fix: `corami exec --on ${clientName} -- flutter devices`,
    });
  }

  const client = (await listClients()).find((entry) => entry.name === clientName);

  if (client === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `${clientName} is not registered on this server`,
      fix: `On ${clientName}, run corami exec setup`,
    });
  }

  await requireOnline(clientName);

  const project = stringFlag(context.args, 'project') ?? (await projectFromCwd());
  const payload = encodeGateRequest(commandRequest(project, argv));
  const json = booleanFlag(context.args, 'json');
  const started = Date.now();
  const result = await runOnClient(client, payload, { stream: !json });
  const data = {
    client: clientName,
    project,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration_ms: Date.now() - started,
  };

  if (json) {
    return { data, exitCode: result.exitCode };
  }

  return { exitCode: result.exitCode };
}

async function projectFromCwd(): Promise<string> {
  const projects = await listProjects();
  const found = projectForPath(
    process.cwd(),
    projects.map((row) => ({ name: row.name, path: row.path })),
  );

  if (found === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'This folder is not a project of the server',
      fix: 'Run the command from inside the project, or pass --project <name>',
    });
  }

  return found;
}

async function requireOnline(name: string): Promise<void> {
  const list = await peers().catch(() => undefined);

  if (list === undefined || list.length === 0) {
    return;
  }

  const peer = list.find(
    (entry) => entry.hostName === name || entry.dnsName.split('.')[0] === name,
  );

  if (peer === undefined || !peer.online) {
    throw new CoramiError({
      code: 'server_unreachable',
      message: `${name} is offline in the tailnet`,
      fix: `Wake ${name}, or open the lid`,
    });
  }
}

export async function serverStatus(context: CommandContext): Promise<CommandResult> {
  await requireServerRole();

  const clients = await listClients();
  const list = await peers().catch(() => []);
  const rows = clients.map((client) => {
    const peer = list.find(
      (entry) => entry.hostName === client.name || entry.dnsName.split('.')[0] === client.name,
    );

    return {
      name: client.name,
      online: peer === undefined ? '?' : peer.online ? 'yes' : 'no',
      os: client.os,
    };
  });

  if (context.output.json) {
    return { data: { clients: rows } };
  }

  if (rows.length === 0) {
    return { text: 'No clients. On a client, run corami exec setup.' };
  }

  return {
    text: renderTable(rows, [
      { header: 'Client', value: (row) => row.name },
      { header: 'Online', value: (row) => row.online },
      { header: 'OS', value: (row) => row.os },
    ]),
  };
}

export async function status(context: CommandContext): Promise<CommandResult> {
  const role = (await readGlobalConfig().catch(() => undefined))?.role;

  if (role === 'client') {
    return clientStatus(context);
  }

  return serverStatus(context);
}
