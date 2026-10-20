import { existsSync } from 'node:fs';

import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { notifyApproval, tailnetIdentity } from '@/cli/exec-client-system.ts';
import {
  appendExecLog,
  ensureExecDirs,
  newExecId,
  readDecision,
  readRules,
  removePending,
  removeRunning,
  writePending,
  writeRunning,
} from '@/cli/exec-files.ts';
import { paths } from '@/core/config.ts';
import { CoramiError, toCoramiError } from '@/core/errors.ts';
import { gateErrorLine } from '@/core/exec-errors.ts';
import {
  type GateCommand,
  gateCopyDecision,
  gatePayload,
  parseGateRequest,
} from '@/core/exec-gate.ts';
import { decide, ruleText } from '@/core/exec-rules.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

const APPROVAL_TIMEOUT_MS = 600_000;
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
      fix: 'On the client, run corami exec allow',
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

  ensureExecDirs();

  return runCommand(request);
}

async function runCommand(request: GateCommand): Promise<CommandResult> {
  const identity = await tailnetIdentity();
  const rules = await readRules();
  const choice = decide(rules, request.project, request.argv);

  if (choice.decision === 'deny') {
    const rule = choice.rule === undefined ? '' : ` (rule: ${ruleText(choice.rule)})`;

    logDecision(request, 'deny', choice.rule?.decision, Date.now(), 1);

    throw new CoramiError({
      code: 'generic',
      message: `${identity.name} denies this command: ${request.argv.join(' ')}${rule}`,
    });
  }

  if (choice.decision === 'ask') {
    await waitForApproval(request, identity.name);
  }

  const engine = new MutagenEngine();
  const sessions = await engine.sessions();
  const copy = gateCopyDecision(sessions, request.project);
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

  try {
    await engine.flush(request.project);
  } catch {
    throw new CoramiError({
      code: 'sync_pending',
      message: `The sync of ${request.project} on ${identity.name} is not up to date: the command did not start`,
      fix: `Run corami sync status on ${identity.name}`,
    });
  }

  const session = sessions?.find((entry) => entry.project === request.project);
  const result = await execute(
    request,
    session?.beta ?? process.cwd(),
    choice.decision,
    choice.rule?.decision,
  );

  await engine.flush(request.project).catch(() => undefined);

  return result;
}

async function waitForApproval(request: GateCommand, client: string): Promise<void> {
  const id = newExecId();
  const started = Date.now();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };

  process.on('SIGHUP', interrupt);
  process.on('SIGTERM', interrupt);

  await writePending({
    id,
    project: request.project,
    argv: request.argv,
    created_at: new Date().toISOString(),
    pid: process.pid,
  });

  notifyApproval(request.project, request.argv);
  process.stderr.write(`Waiting for approval on ${client}: ${request.argv.join(' ')}\n`);

  try {
    for (;;) {
      const decision = await readDecision(id);

      if (decision !== undefined) {
        await removePending(id);

        if (decision.decision === 'allow') {
          return;
        }

        logDecision(request, 'deny', 'ask', started, 1);

        throw new CoramiError({
          code: 'generic',
          message: `Denied on ${client}: ${request.argv.join(' ')}`,
        });
      }

      if (!existsSync(pendingFile(id))) {
        throw new CoramiError({
          code: 'generic',
          message: `The request for ${request.argv.join(' ')} disappeared on ${client}`,
          fix: `On ${client}, run corami exec approve`,
        });
      }

      if (interrupted) {
        await removePending(id);

        throw new CoramiError({
          code: 'generic',
          message: 'The connection closed while waiting for approval',
        });
      }

      if (Date.now() - started >= APPROVAL_TIMEOUT_MS) {
        await removePending(id);

        throw new CoramiError({
          code: 'generic',
          message: `Not approved on ${client} within 10 minutes: ${request.argv.join(' ')}`,
          fix: `On ${client}, run corami exec approve, or add a rule with corami exec rule allow -- ${request.argv.join(' ')}`,
        });
      }

      await Bun.sleep(POLL_MS);
    }
  } finally {
    process.off('SIGHUP', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

async function execute(
  request: GateCommand,
  cwd: string,
  decision: string,
  ruleDecision: string | undefined,
): Promise<CommandResult> {
  const id = newExecId();
  const shell = process.env.SHELL ?? '/bin/sh';
  const started = Date.now();
  const child = Bun.spawn({
    cmd: [shell, '-lc', 'exec "$@"', 'corami-exec', ...request.argv],
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  });

  const kill = () => {
    killGroup(child.pid);
  };

  process.on('SIGHUP', kill);
  process.on('SIGTERM', kill);
  process.on('SIGINT', kill);

  await writeRunning({
    id,
    project: request.project,
    program: request.argv[0] ?? '',
    pgid: child.pid,
    started_at: new Date().toISOString(),
  });

  const exitCode = await child.exited;

  process.off('SIGHUP', kill);
  process.off('SIGTERM', kill);
  process.off('SIGINT', kill);
  await removeRunning(id);

  try {
    appendExecLog({
      at: new Date().toISOString(),
      project: request.project,
      program: request.argv[0] ?? '',
      decision,
      rule: ruleDecision,
      duration_ms: Date.now() - started,
      exit_code: exitCode,
    });
  } catch {
    return { exitCode };
  }

  return { exitCode };
}

function logDecision(
  request: GateCommand,
  decision: string,
  rule: string | undefined,
  started: number,
  exitCode: number,
): void {
  try {
    appendExecLog({
      at: new Date().toISOString(),
      project: request.project,
      program: request.argv[0] ?? '',
      decision,
      rule,
      duration_ms: Date.now() - started,
      exit_code: exitCode,
    });
  } catch {
    return;
  }
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

function pendingFile(id: string): string {
  return `${paths().execPending}/${id}.json`;
}
