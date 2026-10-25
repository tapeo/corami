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
import { type HeavyEntry, heavyInFolder } from '@/core/local-copy.ts';
import { formatBytes } from '@/core/sizes.ts';
import { MutagenEngine, type SyncSession, syncActivityText } from '@/integrations/mutagen.ts';

const POLL_MS = 500;

export async function runGate(context: CommandContext): Promise<CommandResult> {
  try {
    return await gate(context);
  } catch (error) {
    const coramiError = toCoramiError(error);

    process.stderr.write(`\n${gateErrorText(coramiError)}\n`);

    return { exitCode: coramiError.exitCode };
  }
}

function gateErrorText(error: CoramiError): string {
  if (process.stderr.isTTY !== true) {
    return gateErrorLine(error);
  }

  if (error.fix === undefined) {
    return error.message;
  }

  return `${error.message}\n${error.fix}`;
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
  const session = sessions?.find((entry) => entry.project === request.project);

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
      ...pendingExplanation(request.project, identity.name, session),
    });
  }

  await flushOrFail(engine, request.project, identity.name, session);

  const result = await execute(request, session?.beta ?? process.cwd());

  await engine.flush(request.project).catch(() => undefined);

  return result;
}

export interface PendingExplanation {
  message: string;
  fix: string;
}

export function pendingExplanation(
  project: string,
  client: string,
  session: SyncSession | undefined,
  heavy: HeavyEntry[] = heavyOf(session),
): PendingExplanation {
  const head = `The sync of ${project} on ${client} is not up to date`;

  if (session === undefined) {
    return {
      message: `${head}: the command did not start`,
      fix: `On ${client}, run corami sync status`,
    };
  }

  const conflicts = session.conflicts.length;
  const state =
    conflicts > 0
      ? `${conflicts} conflicts to resolve`
      : syncActivityText(session.status, session.lastError);
  const largest = heavy[0];

  if (largest !== undefined) {
    const where = largest.kind === 'dir' ? `${largest.path}/` : largest.path;
    const others = heavy.length > 1 ? ` and ${heavy.length - 1} more` : '';

    return {
      message: `${head}: ${state}. ${where} is ${formatBytes(largest.bytes)}${others}`,
      fix: `Add ${where} to .coramiignore in the project, then run corami sync refresh ${project} on ${client}`,
    };
  }

  return { message: `${head}: ${state}`, fix: `On ${client}, run corami sync status` };
}

function heavyOf(session: SyncSession | undefined): HeavyEntry[] {
  if (session === undefined) {
    return [];
  }

  return heavyInFolder(session.beta);
}

async function flushOrFail(
  engine: MutagenEngine,
  project: string,
  client: string,
  session: SyncSession | undefined,
): Promise<void> {
  try {
    await engine.flush(project);
  } catch {
    const fresh = (await engine.sessions())?.find((entry) => entry.project === project);

    throw new CoramiError({
      code: 'sync_pending',
      ...pendingExplanation(project, client, fresh ?? session),
    });
  }
}

async function execute(request: GateCommand, cwd: string): Promise<CommandResult> {
  const shell = process.env.SHELL ?? '/bin/sh';
  const terminal = process.stdin.isTTY === true;
  const child = Bun.spawn({
    cmd: [shell, '-lc', 'exec "$@"', 'corami-exec', ...request.argv],
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: !terminal,
  });

  const stopWatching = watchConnection(terminal, () => {
    killGroup(child.pid);
  });

  const exitCode = await child.exited;

  stopWatching();

  return { exitCode };
}

function watchConnection(terminal: boolean, onLost: () => void): () => void {
  const parent = process.ppid;
  const signals: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM'];

  if (!terminal) {
    signals.push('SIGINT');
  }

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
