import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { CLIENT_STEPS, runClientSetup } from '@/cli/commands/setup-client.ts';
import { runGitSetup } from '@/cli/commands/setup-git.ts';
import { runStepAsOwner, stepServerUser } from '@/cli/commands/setup-server-user.ts';
import {
  firewallClosed,
  isRoot,
  progressLine,
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
import { readGlobalConfig, writeGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import {
  DEFAULT_SERVER_USER,
  isValidServerUser,
  type ServerStep,
  stepIdentity,
} from '@/core/server-user.ts';
import { defaultRole, proposedOwner, roleChoices } from '@/core/setup-choices.ts';
import { PROVIDERS } from '@/integrations/ssh.ts';

const STEP_KINDS = [
  'preflight',
  'packages',
  'tailscale',
  'hosts',
  'user',
  'firewall',
  'daemon',
  'git-watch',
  'serve',
  'summary',
] as const;

type StepKind = ServerStep;

// What each step is doing, shown in a terminal while it runs.
const STEP_ACTIVITIES: Record<StepKind, string> = {
  preflight: 'Checking the system',
  packages: 'Checking and installing packages',
  tailscale: 'Installing and connecting Tailscale',
  hosts: 'Checking /etc/hosts',
  user: 'Preparing the account that owns the projects',
  firewall: 'Configuring the firewall',
  daemon: 'Installing and restarting the daemon',
  'git-watch': 'Restarting the git alignment service',
  serve: 'Publishing port 7420 with tailscale serve',
  summary: 'Checking that the daemon runs',
};

const LOGIN_WAIT_MS = 15 * 60_000;

const STEP_RUNNERS: Record<StepKind, (context: StepContext) => Promise<StepResult>> = {
  preflight: stepPreflight,
  packages: stepPackages,
  tailscale: stepTailscale,
  hosts: stepHostsEntry,
  user: stepServerUser,
  firewall: stepFirewall,
  daemon: stepDaemon,
  'git-watch': stepGitWatch,
  serve: stepServe,
  summary: stepSummary,
};

function prompterFor(context: CommandContext): Prompter | undefined {
  return canPrompt(context.output) ? terminalPrompter() : undefined;
}

// `corami setup` without a role: in a terminal it asks what the machine is.
async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const prompter = prompterFor(context);
  const given = context.args.positionals[0];

  if (given !== undefined || prompter === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: given === undefined ? 'Missing setup role' : `Unknown setup target: ${given}`,
      fix: 'On the Linux server: corami setup server. On a client: corami setup client <server>',
    });
  }

  const role = await chooseRole(prompter);

  return role === 'client' ? runClientSetup(context, prompter) : runServerSetup(context, prompter);
}

async function runServerSetup(
  context: CommandContext,
  prompter: Prompter | undefined,
): Promise<{ data?: unknown; text?: string }> {
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

    // The steps of the account are handed to it: run as root they would leave
    // their files and their services in the home of root. A dry run executes
    // nothing, and the account may not exist yet.
    const handoff = base.root && !dryRun && stepIdentity(kind) === 'owner';
    const runStep = () =>
      handoff ? runStepAsOwner(stepContext, kind) : STEP_RUNNERS[kind](stepContext);
    let result =
      prompter === undefined || kind === 'preflight' || kind === 'summary'
        ? await runStep()
        : await runStepInTerminal(
            prompter,
            { name: kind, activity: STEP_ACTIVITIES[kind] },
            runStep,
          );

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

  const { status } = await import('@/integrations/tailscale.ts');
  const started = Date.now();
  const deadline = started + LOGIN_WAIT_MS;

  while (Date.now() < deadline) {
    prompter.progress(
      progressLine(
        'tailscale',
        'Waiting for the approval',
        Date.now() - started,
        process.stdout.columns,
      ),
    );
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
    `Public SSH can be closed: you would enter with ssh ${context.serverUser}@${address}, or from the provider console.`,
  );

  return prompter.confirm('Close public SSH and keep only the tailnet?', false);
}

async function buildStepContext(context: CommandContext, dryRun: boolean): Promise<StepContext> {
  const existing = await readGlobalConfig().catch(() => undefined);
  const serverUser = resolveServerUser(context, existing?.server_user);

  const built: StepContext = {
    root: isRoot(),
    hostname: stringFlag(context.args, 'hostname') ?? 'corami',
    serverUser,
    fqdn: stringFlag(context.args, 'fqdn') ?? existing?.server_host,
    ownerLogin: stringFlag(context.args, 'owner') ?? existing?.owner_login,
    authKey: stringFlag(context.args, 'auth-key') ?? process.env.CORAMI_TAILSCALE_AUTHKEY,
    dryRun,
  };

  // Root keeps in its own configuration the account that owns the projects,
  // so that every later command run as root knows where they belong.
  if (!dryRun && built.root && serverUser !== existing?.server_user) {
    await writeGlobalConfig({
      role: 'server',
      server_user: serverUser,
      ...(built.fqdn === undefined ? {} : { server_host: built.fqdn }),
      ...(built.ownerLogin === undefined ? {} : { owner_login: built.ownerLogin }),
    });
  }

  return built;
}

/** The account that owns the projects: `--user`, then the one saved before. */
function resolveServerUser(context: CommandContext, configured: string | undefined): string {
  const user = stringFlag(context.args, 'user') ?? configured ?? DEFAULT_SERVER_USER;

  if (!isValidServerUser(user)) {
    throw new CoramiError({
      code: 'usage',
      message: `"${user}" cannot be the name of the account that owns the projects`,
      fix: 'A lowercase name of letters, digits, underscores and hyphens, at most 32 characters',
    });
  }

  return user;
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

const DRY_RUN_FLAG = { name: 'dry-run', description: 'Show what it would do' };

export const setupCommand: CommandSpec = {
  name: 'setup',
  summary: 'Installs Corami and its services on the server or on a client',
  usage: 'corami setup [<role>] [options]',
  examples: ['corami setup'],
  actions: [
    {
      name: 'server',
      summary: 'Sets up the Linux server: Tailscale, the account of the projects, HTTPS, services',
      usage: 'corami setup server [--owner <login>] [--user <user>] [--firewall] [--step <step>]',
      flags: [
        {
          name: 'hostname',
          value: 'name',
          description: 'Machine name on Tailscale, default corami',
        },
        { name: 'owner', value: 'login', description: 'Allowed Tailscale login' },
        { name: 'auth-key', value: 'key', description: 'Tailscale authentication key' },
        { name: 'fqdn', value: 'name', description: 'MagicDNS name, when already known' },
        {
          name: 'user',
          value: 'user',
          description: `Account that owns the projects, default ${DEFAULT_SERVER_USER}`,
        },
        {
          name: 'step',
          value: 'step',
          description: `Runs a single step: ${STEP_KINDS.join(', ')}`,
        },
        { name: 'firewall', description: 'Closes public SSH, enter with Tailscale SSH' },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami setup server --owner me@example.com',
        'corami setup server --firewall',
        'corami setup server --step daemon',
      ],
      run: (context) => runServerSetup(context, prompterFor(context)),
    },
    {
      name: 'client',
      summary: 'Connects this machine to the server: SSH, Mutagen and its services',
      usage: 'corami setup client [<server>] [--user <user>] [--step <step>] [--no-mutagen]',
      flags: [
        {
          name: 'user',
          value: 'user',
          description: 'Account on the server, default the one the daemon announces',
        },
        {
          name: 'step',
          value: 'step',
          description: `Runs a single step: ${CLIENT_STEPS.join(', ')}`,
        },
        { name: 'no-mutagen', description: 'Do not install Mutagen and its daemon service' },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami setup client corami.tail1a2b3c.ts.net',
        'corami setup client corami.tail1a2b3c.ts.net --step mutagen-daemon',
      ],
      run: (context) => runClientSetup(context, prompterFor(context)),
    },
    {
      name: 'git',
      summary: 'Gives the server account its SSH key for the git provider',
      usage:
        'corami setup git [--provider <name>] [--identity-name <name>] [--identity-email <email>]',
      flags: [
        {
          name: 'provider',
          value: 'name',
          description: `Provider, default github. One of ${Object.keys(PROVIDERS).join(', ')}`,
        },
        { name: 'identity-name', value: 'name', description: 'Name for the commits' },
        { name: 'identity-email', value: 'email', description: 'Email for the commits' },
        DRY_RUN_FLAG,
      ],
      examples: ['corami setup git', 'corami setup git --provider gitlab'],
      run: runGitSetup,
    },
  ],
  run,
};
