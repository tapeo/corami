import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { CLIENT_STEPS, runClientSetup } from '@/cli/commands/setup-client.ts';
import {
  firewallClosed,
  isRoot,
  runStepInTerminal,
  type StepContext,
  type StepResult,
  stepDaemon,
  stepFirewall,
  stepGitWatch,
  stepHostsEntry,
  stepLine,
  stepPackages,
  stepPreflight,
  stepServe,
  stepSummary,
  stepTailscale,
} from '@/cli/commands/setup-steps.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import { canPrompt, type Prompter, terminalPrompter } from '@/cli/prompt.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { defaultRole, proposedOwner, roleChoices } from '@/core/setup-choices.ts';

const STEP_KINDS = [
  'preflight',
  'packages',
  'tailscale',
  'hosts',
  'firewall',
  'daemon',
  'git-watch',
  'serve',
  'summary',
] as const;

type StepKind = (typeof STEP_KINDS)[number];

const LOGIN_WAIT_MS = 15 * 60_000;

const STEP_RUNNERS: Record<StepKind, (context: StepContext) => Promise<StepResult>> = {
  preflight: stepPreflight,
  packages: stepPackages,
  tailscale: stepTailscale,
  hosts: stepHostsEntry,
  firewall: stepFirewall,
  daemon: stepDaemon,
  'git-watch': stepGitWatch,
  serve: stepServe,
  summary: stepSummary,
};

async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const prompter = canPrompt(context.output) ? terminalPrompter() : undefined;
  const target =
    context.args.positionals[0] ??
    (prompter === undefined ? undefined : await chooseRole(prompter));

  if (target === 'git') {
    const { setupGitCommand } = await import('@/cli/commands/setup-git.ts');
    return setupGitCommand.run({
      ...context,
      args: { ...context.args, positionals: context.args.positionals.slice(1) },
    });
  }

  if (target === 'client') {
    return runClientSetup(
      {
        ...context,
        args: { ...context.args, positionals: context.args.positionals.slice(1) },
      },
      prompter,
    );
  }

  if (target !== 'server') {
    throw new CoramiError({
      code: 'usage',
      message: target === undefined ? 'Missing setup role' : `Unknown setup target: ${target}`,
      fix: 'On the Linux server: corami setup server. On a client: corami setup client <server>',
    });
  }

  const dryRun = booleanFlag(context.args, 'dry-run');
  const only = stringFlag(context.args, 'step');
  const withFirewall = booleanFlag(context.args, 'firewall');
  const steps = only === undefined ? STEP_KINDS : STEP_KINDS.filter((kind) => kind === only);

  if (steps.length === 0) {
    throw new CoramiError({
      code: 'usage',
      message: `Unknown step: ${only ?? ''}`,
      fix: `Available steps: ${STEP_KINDS.join(', ')}`,
    });
  }

  const base = await buildStepContext(context, dryRun);
  const results: StepResult[] = [];
  let stepContext = base;

  for (const kind of steps) {
    // The firewall runs on request: `--firewall`, `--step firewall`, or a yes
    // to the question asked in a terminal.
    if (
      kind === 'firewall' &&
      only === undefined &&
      !withFirewall &&
      (prompter === undefined || !(await offerFirewall(prompter, stepContext)))
    ) {
      continue;
    }

    const runStep = () => STEP_RUNNERS[kind](stepContext);
    let result =
      prompter === undefined || kind === 'preflight' || kind === 'summary'
        ? await runStep()
        : await runStepInTerminal(prompter, runStep);

    if (prompter !== undefined && (kind === 'preflight' || kind === 'summary')) {
      prompter.say(stepLine(result));
    }

    if (prompter !== undefined && result.status === 'waiting' && result.detail !== undefined) {
      result = await waitForLogin(prompter, result.detail, runStep);
    }

    results.push(result);

    stepContext = await withUpdatedContext(stepContext, result);

    if (prompter !== undefined && kind === 'tailscale' && result.status === 'done') {
      stepContext = await confirmOwner(prompter, stepContext);
    }

    if (
      (result.status === 'failed' || result.status === 'waiting') &&
      only === undefined &&
      kind !== 'summary'
    ) {
      break;
    }
  }

  if (context.output.json) {
    return { data: { fqdn: stepContext.fqdn, steps: results } };
  }

  return { text: render(results, stepContext.fqdn, prompter === undefined) };
}

async function chooseRole(prompter: Prompter): Promise<string> {
  const choices = roleChoices(process.platform);

  if (choices.length === 1) {
    prompter.say('Only a Linux machine can be the server: setting up this machine as a client.');
    return 'client';
  }

  const configured = (await readGlobalConfig().catch(() => undefined))?.role;
  const fallback = defaultRole(process.platform, configured);

  return prompter.choose(
    'What is this machine?',
    [
      { label: 'The server: it keeps the projects and runs your agents', value: 'server' },
      { label: 'A client: it keeps a synced copy of the projects', value: 'client' },
    ],
    choices.indexOf(fallback),
  );
}

// The login link of Tailscale stays valid after `tailscale up` returns: the
// setup waits for the approval and then runs the step again.
async function waitForLogin(
  prompter: Prompter,
  loginUrl: string,
  runStep: () => Promise<StepResult>,
): Promise<StepResult> {
  prompter.say('');
  prompter.say(`Open this address to connect the server to Tailscale: ${loginUrl}`);
  prompter.say('Waiting for the approval...');

  const { status } = await import('@/integrations/tailscale.ts');
  const deadline = Date.now() + LOGIN_WAIT_MS;

  while (Date.now() < deadline) {
    await Bun.sleep(2000);

    const current = await status().catch(() => undefined);

    if (current?.online === true) {
      const result = await runStep();
      prompter.say(stepLine(result));
      return result;
    }
  }

  return {
    step: 'tailscale',
    status: 'waiting',
    summary: 'Login to Tailscale not approved in time',
    detail: loginUrl,
  };
}

// The owner proposed is the account that signed the server in. A login
// already given with `--owner`, or saved by an earlier setup, is kept.
async function confirmOwner(prompter: Prompter, context: StepContext): Promise<StepContext> {
  if (context.ownerLogin !== undefined || context.dryRun) {
    return context;
  }

  const { status } = await import('@/integrations/tailscale.ts');
  const login = proposedOwner((await status().catch(() => undefined))?.loginName);

  if (
    login !== undefined &&
    (await prompter.confirm(`Allow only ${login} to reach the daemon?`, true))
  ) {
    return { ...context, ownerLogin: login };
  }

  const other = await prompter.ask(
    'Tailscale login allowed to reach the daemon (empty: every device in the tailnet):',
  );

  return { ...context, ownerLogin: other === '' ? undefined : other };
}

// Asked only when closing public SSH cannot lock the user out: root, Tailscale
// SSH on, and the firewall not in place yet.
async function offerFirewall(prompter: Prompter, context: StepContext): Promise<boolean> {
  if (!context.root || context.dryRun) {
    return false;
  }

  const { sshEnabled } = await import('@/integrations/tailscale.ts');

  if ((await sshEnabled()) !== true || (await firewallClosed())) {
    return false;
  }

  const address = context.fqdn ?? '<machine>.<tailnet>.ts.net';

  prompter.say('');
  prompter.say(
    `Public SSH can be closed: you would enter with ssh ${context.coramiUser ?? 'root'}@${address}, or from the provider console.`,
  );

  return prompter.confirm('Close public SSH and keep only the tailnet?', false);
}

async function buildStepContext(context: CommandContext, dryRun: boolean): Promise<StepContext> {
  const existing = await readGlobalConfig().catch(() => undefined);

  return {
    root: isRoot(),
    hostname: stringFlag(context.args, 'hostname') ?? 'corami',
    fqdn: stringFlag(context.args, 'fqdn') ?? existing?.server_host,
    ownerLogin: stringFlag(context.args, 'owner') ?? existing?.owner_login,
    authKey: stringFlag(context.args, 'auth-key') ?? process.env.CORAMI_TAILSCALE_AUTHKEY,
    coramiUser: stringFlag(context.args, 'user'),
    dryRun,
  };
}

async function withUpdatedContext(context: StepContext, result: StepResult): Promise<StepContext> {
  if ((result.step === 'daemon' || result.step === 'git-watch') && result.scope !== undefined) {
    return { ...context, daemonScope: result.scope };
  }

  if (result.step !== 'tailscale' || result.status !== 'done' || context.fqdn !== undefined) {
    return context;
  }

  const { status } = await import('@/integrations/tailscale.ts');
  const current = await status();

  return { ...context, fqdn: current.dnsName, ownerLogin: context.ownerLogin };
}

// `withSteps` is false in a terminal, where every step was printed as it
// ended: only the closing notes are left.
function render(results: StepResult[], fqdn: string | undefined, withSteps: boolean): string {
  const lines: string[] = [];

  if (withSteps) {
    lines.push(
      renderTable(results, [
        { header: 'Step', value: (row) => row.step },
        { header: 'Result', value: (row) => row.status },
        { header: 'Detail', value: (row) => row.summary },
      ]),
    );

    for (const result of results) {
      if (result.detail !== undefined) {
        lines.push(`${result.step}: ${result.detail}`);
      }
    }
  }

  const login = results.find(
    (result) => result.status === 'waiting' && result.detail !== undefined,
  );

  if (login?.detail !== undefined) {
    lines.push(
      '',
      `Open this address to connect Tailscale: ${login.detail}`,
      'Then run again: corami setup server',
    );
  }

  if (fqdn !== undefined) {
    lines.push(
      '',
      `The daemon answers at https://${fqdn}:7420`,
      `To connect a client, run there: corami setup client ${fqdn}`,
    );
  }

  return lines.join('\n');
}

export const setupCommand: CommandSpec = {
  name: 'setup',
  summary: 'Installs Corami and its services on the server or on a client',
  usage: 'corami setup [server|client|git] [options]',
  flags: [
    {
      name: 'hostname',
      value: 'name',
      description: 'Server: machine name on Tailscale, default corami',
    },
    { name: 'owner', value: 'login', description: 'Server: allowed Tailscale login' },
    { name: 'auth-key', value: 'key', description: 'Server: Tailscale authentication key' },
    { name: 'fqdn', value: 'name', description: 'Server: MagicDNS name, when already known' },
    {
      name: 'user',
      value: 'user',
      description: 'Server: user that runs the daemon. Client: user on the server. Default root',
    },
    {
      name: 'step',
      value: 'step',
      description: `Runs a single step. Server: ${STEP_KINDS.join(', ')}. Client: ${CLIENT_STEPS.join(', ')}`,
    },
    { name: 'firewall', description: 'Server: closes public SSH, enter with Tailscale SSH' },
    { name: 'no-mutagen', description: 'Client: do not install Mutagen and its daemon service' },
    { name: 'dry-run', description: 'Show what it would do' },
    { name: 'json', description: 'JSON output' },
  ],
  examples: [
    'corami setup',
    'corami setup server --owner me@example.com',
    'corami setup server --firewall',
    'corami setup server --step daemon',
    'corami setup client corami.tail1a2b3c.ts.net',
    'corami setup client corami.tail1a2b3c.ts.net --step mutagen-daemon',
  ],
  run,
};
