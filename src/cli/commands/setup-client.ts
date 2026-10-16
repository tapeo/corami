import { join } from 'node:path';

import type { CommandContext, FlagSpec } from '@/cli/command.ts';
import { runStepInTerminal, type StepResult } from '@/cli/commands/setup-steps.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import type { Prompter } from '@/cli/prompt.ts';
import { homeDirectory, readGlobalConfig, writeGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import { ensureTool, findTool, MUTAGEN } from '@/core/pinned-tools.ts';
import { serverUser } from '@/core/server-user.ts';
import { serverCandidates } from '@/core/setup-choices.ts';
import { installDaemonService } from '@/integrations/mutagen.ts';
import { gitWatchSpec, installService } from '@/integrations/service.ts';
import { peers as tailnetPeers, status as tailscaleStatus } from '@/integrations/tailscale.ts';

export const CLIENT_STEPS = [
  'tailscale',
  'daemon',
  'ssh',
  'mutagen',
  'mutagen-daemon',
  'config',
  'git-watch',
] as const;

type ClientStep = (typeof CLIENT_STEPS)[number];

interface ClientContext {
  server: string;
  /** The account that owns the projects on the server, resolved along the way. */
  user?: string | undefined;
  dryRun: boolean;
  skipMutagen: boolean;
  health?: Record<string, unknown> | undefined;
}

export const CLIENT_FLAGS: FlagSpec[] = [
  {
    name: 'user',
    value: 'user',
    description: 'User on the server, default the one the server announces',
  },
  { name: 'no-mutagen', description: 'Do not install Mutagen and its daemon service' },
  { name: 'step', value: 'step', description: `Runs a single step: ${CLIENT_STEPS.join(', ')}` },
  { name: 'dry-run', description: 'Check without installing or writing anything' },
  { name: 'json', description: 'JSON output' },
];

const STEP_RUNNERS: Record<ClientStep, (context: ClientContext) => Promise<StepResult>> = {
  tailscale: stepTailscale,
  daemon: stepDaemon,
  ssh: stepSsh,
  mutagen: stepMutagen,
  'mutagen-daemon': stepMutagenDaemon,
  config: stepConfig,
  'git-watch': stepGitWatch,
};

// What each step is doing, shown in a terminal while it runs.
const STEP_ACTIVITIES: Record<ClientStep, string> = {
  tailscale: 'Checking Tailscale on this machine',
  daemon: 'Reaching the daemon on the server',
  ssh: 'Checking SSH over Tailscale',
  mutagen: `Checking and installing Mutagen ${MUTAGEN.version}`,
  'mutagen-daemon': 'Installing the Mutagen daemon service',
  config: 'Saving the client configuration',
  'git-watch': 'Restarting the git alignment service',
};

/**
 * Connects this machine to the server as a client: `corami setup client
 * <server>`. `server` is the first positional of `context`; with `prompter`,
 * in a terminal, it can be left out and is looked for in the tailnet.
 */
export async function runClientSetup(
  context: CommandContext,
  prompter?: Prompter,
): Promise<{ data?: unknown; text?: string }> {
  const given = context.args.positionals[0];

  if (given === undefined && prompter === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing server host',
      fix: 'corami setup client corami.tail1a2b3c.ts.net',
    });
  }

  const only = stringFlag(context.args, 'step');
  const planned = only === undefined ? CLIENT_STEPS : CLIENT_STEPS.filter((kind) => kind === only);

  if (planned.length === 0) {
    throw new CoramiError({
      code: 'usage',
      message: `Unknown step: ${only ?? ''}`,
      fix: `Available steps: ${CLIENT_STEPS.join(', ')}`,
    });
  }

  const clientContext: ClientContext = {
    server: given ?? '',
    dryRun: booleanFlag(context.args, 'dry-run'),
    skipMutagen: negatedFlag(context.args, 'mutagen'),
  };

  if (given !== undefined) {
    clientContext.user = await resolveUser(clientContext, stringFlag(context.args, 'user'));
  }

  const steps: StepResult[] = [];
  const runStep = (kind: ClientStep) => {
    const step = () => STEP_RUNNERS[kind](clientContext);
    return prompter === undefined
      ? step()
      : runStepInTerminal(prompter, { name: kind, activity: STEP_ACTIVITIES[kind] }, step);
  };

  // Without a server the tailnet is searched, which needs Tailscale first.
  if (given === undefined && prompter !== undefined) {
    const tailscale = await runStep('tailscale');
    steps.push(tailscale);

    if (tailscale.status === 'failed') {
      return { text: render(steps, true, false) };
    }

    clientContext.server = await chooseServer(prompter);
    clientContext.user = await resolveUser(clientContext, stringFlag(context.args, 'user'));
  }

  for (const kind of planned) {
    if (steps.some((step) => step.step === kind)) {
      continue;
    }

    const result = await runStep(kind);
    steps.push(result);

    if (result.status === 'failed' && only === undefined) {
      break;
    }
  }

  const localRoot = join(homeDirectory(), 'corami');

  if (context.output.json) {
    return {
      data: {
        server: clientContext.server,
        user: clientContext.user,
        local_root: localRoot,
        steps,
      },
    };
  }

  return {
    text: render(steps, clientContext.dryRun || only !== undefined, prompter === undefined),
  };
}

// The account that owns the projects on the server: `--user`, then the one
// the daemon announces in its health answer, then the one saved by an earlier
// setup, then root for a server that announces nothing. The SSH of the sync
// and the step `ssh` use it; a server whose account changed is followed
// without running the setup again.
async function resolveUser(context: ClientContext, flag: string | undefined): Promise<string> {
  const health =
    context.health ?? (await fetchHealth(`https://${context.server}:7420`).catch(() => undefined));
  const announced = typeof health?.user === 'string' ? health.user : undefined;
  const configured = (await readGlobalConfig().catch(() => undefined))?.server_user;

  return serverUser({ flag, configured: announced ?? configured }) ?? 'root';
}

// The server already configured comes first, then the machines of the tailnet
// where a Corami daemon answers, then a name typed by hand.
async function chooseServer(prompter: Prompter): Promise<string> {
  const configured = (await readGlobalConfig().catch(() => undefined))?.server_host;

  if (configured !== undefined && (await prompter.confirm(`Connect to ${configured}?`, true))) {
    return configured;
  }

  prompter.say('Looking for a Corami server in your tailnet...');

  const found = await discoverServers();
  const others = found.filter((server) => server !== configured);

  if (others.length === 1) {
    const [server = ''] = others;

    if (await prompter.confirm(`Found ${server}. Connect to it?`, true)) {
      return server;
    }
  }

  if (others.length > 1) {
    const typed = 'other';
    const picked = await prompter.choose('Which server?', [
      ...others.map((server) => ({ label: server, value: server })),
      { label: 'Another one, typed by hand', value: typed },
    ]);

    if (picked !== typed) {
      return picked;
    }
  }

  if (others.length === 0) {
    prompter.say('No Corami server answered in your tailnet.');
  }

  for (;;) {
    const server = await prompter.ask(
      'Name of the server, as in tailscale status (machine.tailnet.ts.net):',
    );

    if (server !== '') {
      return server;
    }
  }
}

async function discoverServers(): Promise<string[]> {
  const candidates = serverCandidates(await tailnetPeers());
  const answers = await Promise.all(
    candidates.map(async (server) => {
      const health = await fetchHealth(`https://${server}:7420`, 5_000);
      return health?.name === 'corami' ? server : undefined;
    }),
  );

  return answers.filter((server) => server !== undefined);
}

async function stepTailscale(): Promise<StepResult> {
  const local = await tailscaleStatus();

  if (!local.installed || !local.online) {
    return {
      step: 'tailscale',
      status: 'failed',
      summary: 'Tailscale is not connected on this machine',
      detail:
        'Install Tailscale, sign in with the account of the server, check that tailscale status works in this terminal, then run this again',
    };
  }

  return {
    step: 'tailscale',
    status: 'done',
    summary: 'Tailscale connected',
    detail: local.dnsName,
  };
}

async function stepDaemon(context: ClientContext): Promise<StepResult> {
  const base = `https://${context.server}:7420`;
  const health = await fetchHealth(base);

  if (health === undefined) {
    return {
      step: 'daemon',
      status: 'failed',
      summary: `Cannot reach ${base}/v1/health`,
      detail: 'Check that the server is up and this machine is in the same tailnet',
    };
  }

  context.health = health;

  return {
    step: 'daemon',
    status: 'done',
    summary: `Daemon reachable, version ${String(health.version ?? 'unknown')}`,
    detail: health.fqdn === undefined ? undefined : String(health.fqdn),
  };
}

async function stepSsh(context: ClientContext): Promise<StepResult> {
  const user = context.user ?? 'root';
  const target = `${user}@${context.server}`;
  const ssh = await run('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    target,
    'true',
  ]);

  if (!ssh.ok) {
    return {
      step: 'ssh',
      status: 'failed',
      summary: `SSH over Tailscale failed for ${target}`,
      detail: (ssh.stderr || ssh.stdout).trim().split('\n').slice(0, 2).join(' '),
    };
  }

  return { step: 'ssh', status: 'done', summary: `SSH over Tailscale works as ${user}` };
}

async function stepMutagen(context: ClientContext): Promise<StepResult> {
  if (context.skipMutagen) {
    return { step: 'mutagen', status: 'skipped', summary: 'Skipped with --no-mutagen' };
  }

  if (context.dryRun) {
    return {
      step: 'mutagen',
      status: 'skipped',
      summary: `Would install Mutagen ${MUTAGEN.version}`,
    };
  }

  const mutagen = await ensureTool(MUTAGEN);

  return {
    step: 'mutagen',
    status: 'done',
    summary: mutagen.installed
      ? `Mutagen installed (${MUTAGEN.version})`
      : 'Mutagen already present',
    detail: `${mutagen.path}${mutagen.version === undefined ? '' : `, ${mutagen.version}`}`,
  };
}

async function stepMutagenDaemon(context: ClientContext): Promise<StepResult> {
  if (context.skipMutagen) {
    return { step: 'mutagen-daemon', status: 'skipped', summary: 'Skipped with --no-mutagen' };
  }

  if (context.dryRun) {
    return {
      step: 'mutagen-daemon',
      status: 'skipped',
      summary: 'Would install the Mutagen daemon as a service',
    };
  }

  const binary = await findTool(MUTAGEN);

  if (binary === undefined) {
    return {
      step: 'mutagen-daemon',
      status: 'failed',
      summary: 'Mutagen is not installed',
      detail: 'Run corami setup client <server> --step mutagen first',
    };
  }

  const result = await installDaemonService(binary);

  return {
    step: 'mutagen-daemon',
    status: result.installed ? 'done' : 'failed',
    summary: result.installed
      ? `Mutagen daemon installed as a service (${result.detail})`
      : 'The Mutagen daemon could not be installed as a service',
    detail: result.installed ? result.path : result.detail,
  };
}

async function stepConfig(context: ClientContext): Promise<StepResult> {
  if (context.dryRun) {
    return { step: 'config', status: 'skipped', summary: 'Would save the client configuration' };
  }

  const health = context.health ?? (await fetchHealth(`https://${context.server}:7420`));
  const existing = await readGlobalConfig().catch(() => undefined);

  await writeGlobalConfig({
    ...(existing ?? { role: 'client' }),
    role: 'client',
    server_host: context.server,
    ...(context.user === undefined ? {} : { server_user: context.user }),
    ...(typeof health?.owner_login === 'string' ? { owner_login: health.owner_login } : {}),
  });

  return {
    step: 'config',
    status: 'done',
    summary: 'Client configuration saved',
    detail: join(homeDirectory(), '.corami', 'config.json'),
  };
}

async function stepGitWatch(context: ClientContext): Promise<StepResult> {
  if (context.dryRun) {
    return {
      step: 'git-watch',
      status: 'skipped',
      summary: 'Would install the git alignment service',
    };
  }

  const result = await installService(gitWatchSpec(process.execPath));

  return {
    step: 'git-watch',
    status: result.installed ? 'done' : 'failed',
    summary: result.installed
      ? `Git alignment service installed (${result.detail})`
      : 'The git alignment service could not be installed',
    detail: result.installed
      ? result.path
      : `${result.detail}. Run corami git watch by hand, or install it again after fixing the cause.`,
  };
}

async function fetchHealth(
  base: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${base}/v1/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);

  if (response?.ok !== true) {
    return undefined;
  }

  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: Record<string, unknown>;
  };
  return body.data;
}

// `withSteps` is false in a terminal, where every step was printed as it
// ended: only the closing note is left.
function render(steps: StepResult[], partial: boolean, withSteps: boolean): string {
  const lines: string[] = [];

  if (withSteps) {
    lines.push(
      renderTable(steps, [
        { header: 'Step', value: (row) => row.step },
        { header: 'Result', value: (row) => row.status },
        { header: 'Detail', value: (row) => row.summary },
      ]),
    );

    for (const step of steps) {
      if (step.detail !== undefined) {
        lines.push(`${step.step}: ${step.detail}`);
      }
    }
  }

  const failed = steps.some((step) => step.status === 'failed');

  if (!failed && !partial) {
    lines.push('', 'Next step: corami sync <project> to get the code locally.');
  }

  return lines.join('\n');
}
