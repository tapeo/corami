import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { tailnetIdentity } from '@/cli/exec-client-system.ts';
import { CoramiError, toCoramiError } from '@/core/errors.ts';
import { gateErrorLine } from '@/core/exec-errors.ts';
import {
  type GateCommand,
  gateCopyDecision,
  gatePayload,
  parseGateRequest,
} from '@/core/exec-gate.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

const POLL_MS = 500;

export async function runGate(context: CommandContext): Promise<CommandResult> {
  try {
    return await gate(context);
  } catch (error) {
    const coramiError = toCoramiError(error);

    process.stderr.write(`\n${gateErrorLine(coramiError)}\n`);

    return { exitCode: coramiError.exitCode };
  }
}

async function gate(_context: CommandContext): Promise<CommandResult> {
  const payload = gatePayload(process.env.SSH_ORIGINAL_COMMAND);

  if (payload === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'The gate runs only through ssh, from the server',
      fix: 'On the client, run corami exec setup',
    });
  }

  const request = parseGateRequest(payload);

  if (request === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'The request of the server is not valid',
      fix: 'Run corami exec on the server again',
    });
  }

  if ('probe' in request) {
    return { exitCode: 0 };
  }

  return runCommand(request);
}

async function runCommand(request: GateCommand): Promise<CommandResult> {
  const engine = new MutagenEngine();
  const sessions = await engine.sessions();
  const copy = gateCopyDecision(sessions, request.project);
  const identity = await tailnetIdentity();

  if (copy === 'unavailable') {
    throw new CoramiError({
      code: 'capability_missing',
      message: 'Mutagen did not answer on this client',
      fix: 'corami doctor checks the sync engine on this machine',
    });
  }

  if (copy === 'missing') {
    throw new CoramiError({
      code: 'config_invalid',
      message: `${identity.name} has no copy of ${request.project}`,
      fix: `On ${identity.name}, run corami project add <folder> --from-server --name ${request.project}`,
    });
  }

  if (copy === 'pending') {
    throw new CoramiError({
      code: 'sync_pending',
      message: `The sync of ${request.project} on ${identity.name} is not up to date: the command did not start`,
      fix: `Run corami sync status on ${identity.name}`,
    });
  }

  await flushOrFail(engine, request.project, identity.name);

  const session = sessions?.find((entry) => entry.project === request.project);
  const result = await execute(request, session?.beta ?? process.cwd());

  await engine.flush(request.project).catch(() => undefined);

  return result;
}

async function flushOrFail(engine: MutagenEngine, project: string, client: string): Promise<void> {
  try {
    await engine.flush(project);
  } catch {
    throw new CoramiError({
      code: 'sync_pending',
      message: `The sync of ${project} on ${client} is not up to date: the command did not start`,
      fix: `Run corami sync status on ${client}`,
    });
  }
}

async function execute(request: GateCommand, cwd: string): Promise<CommandResult> {
  const shell = process.env.SHELL ?? '/bin/sh';
  const child = Bun.spawn({
    cmd: [shell, '-lc', 'exec "$@"', 'corami-exec', ...request.argv],
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  });

  const stopWatching = watchConnection(() => {
    killGroup(child.pid);
  });

  const exitCode = await child.exited;

  stopWatching();

  return { exitCode };
}

function watchConnection(onLost: () => void): () => void {
  const parent = process.ppid;
  const signals: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM', 'SIGINT'];
  let fired = false;
  const fire = () => {
    if (fired) {
      return;
    }

    fired = true;
    onLost();
  };
  const timer = setInterval(() => {
    if (process.ppid !== parent) {
      fire();
    }
  }, POLL_MS);

  for (const signal of signals) {
    process.on(signal, fire);
  }

  return () => {
    clearInterval(timer);

    for (const signal of signals) {
      process.off(signal, fire);
    }
  };
}

function killGroup(pid: number): void {
  signalGroup(pid, 'SIGTERM');

  setTimeout(() => {
    signalGroup(pid, 'SIGKILL');
  }, 5_000).unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}
