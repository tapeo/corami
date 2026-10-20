import type { CommandSpec } from '@/cli/command.ts';
import { allow, deny } from '@/cli/exec-client.ts';
import { runGate } from '@/cli/exec-gate-run.ts';
import { approve, rule, rules } from '@/cli/exec-rules-cli.ts';
import { remote, status } from '@/cli/exec-server.ts';

export const execCommand: CommandSpec = {
  name: 'exec',
  summary: 'Runs a command on a client, or lets the server do it',
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
      name: 'allow',
      summary: 'Lets this server run commands here, in a terminal on the client',
      usage: 'corami exec allow',
      examples: ['corami exec allow'],
      run: allow,
    },
    {
      name: 'deny',
      summary: 'Stops the server from running commands here',
      usage: 'corami exec deny',
      examples: ['corami exec deny'],
      run: deny,
    },
    {
      name: 'approve',
      summary: 'Answers the commands that are waiting here',
      usage: 'corami exec approve',
      examples: ['corami exec approve'],
      run: approve,
    },
    {
      name: 'rule',
      summary: 'Adds or removes a rule of this client',
      usage: 'corami exec rule allow|deny|rm [--project <name>] -- <command>',
      arguments: 1,
      flags: [{ name: 'project', value: 'name', description: 'Limit the rule to a project' }],
      examples: [
        'corami exec rule allow -- flutter devices',
        "corami exec rule allow --project myapp -- flutter build '*'",
        "corami exec rule rm -- flutter build '*'",
      ],
      run: rule,
    },
    {
      name: 'rules',
      summary: 'Lists the rules of this client',
      usage: 'corami exec rules',
      examples: ['corami exec rules'],
      run: rules,
    },
    {
      name: 'status',
      summary: 'Shows the channel: on the client, or the registered clients on the server',
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
