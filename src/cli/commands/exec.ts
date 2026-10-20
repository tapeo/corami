import type { CommandSpec } from '@/cli/command.ts';
import { setup } from '@/cli/exec-client.ts';
import { runGate } from '@/cli/exec-gate-run.ts';
import { remote, status } from '@/cli/exec-server.ts';

export const execCommand: CommandSpec = {
  name: 'exec',
  summary: 'Runs a command on a client',
  usage: 'corami exec --on <client> [--project <name>] -- <command>',
  flags: [
    { name: 'on', value: 'client', description: 'Client that runs the command' },
    { name: 'project', value: 'name', description: 'Project whose copy the command runs in' },
  ],
  examples: [
    'corami exec --on macbook -- flutter devices',
    'corami exec --on macbook --project myapp -- flutter run',
    'corami exec status',
  ],
  run: remote,
  actions: [
    {
      name: 'setup',
      summary: 'Connects this client to its server',
      usage: 'corami exec setup',
      examples: ['corami exec setup'],
      run: setup,
    },
    {
      name: 'status',
      summary: 'Shows the clients of the server, or this client and its server',
      usage: 'corami exec status',
      examples: ['corami exec status'],
      run: status,
    },
    {
      name: 'gate',
      summary: 'Runs a request of the server',
      usage: 'corami exec gate',
      hidden: true,
      run: runGate,
    },
  ],
};
