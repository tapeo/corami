import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { tailnetIdentity } from '@/cli/exec-client-system.ts';
import {
  appendExecLog,
  ensureExecDirs,
  isPending,
  newExecId,
  readDecision,
  readGrants,
  readRules,
  removePending,
  removeRunning,
  writePending,
  writeRunning,
} from '@/cli/exec-files.ts';
import { CoramiError, toCoramiError } from '@/core/errors.ts';
import { APPROVAL_WAIT_MS, approvalSeconds } from '@/core/exec-approval.ts';
import { gateErrorLine } from '@/core/exec-errors.ts';
import {
  type GateCommand,
  gateCopyDecision,
  gatePayload,
  parseGateRequest,
} from '@/core/exec-gate.ts';
import { activeGrant } from '@/core/exec-grants.ts';
import { decide, type ExecChoice, ruleText } from '@/core/exec-rules.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

const POLL_MS = 500;

type Approval = 'answer' | 'grant';

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

  let approval: Approval | undefined;

  if (choice.decision === 'ask') {
    approval = await waitForApproval(request, identity.name);
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
    loggedRule(choice, approval),
  );

  await engine.flush(request.project).catch(() => undefined);

  return result;
}

async function waitForApproval(request: GateCommand, client: string): Promise<Approval> {
  if (await granted(request.project)) {
    return 'grant';
  }

  const id = newExecId();
  const command = request.argv.join(' ');
  const started = Date.now();
  let lost = false;
  const stopWatching = watchConnection(() => {
    lost = true;
  });

  await writePending({
    id,
    project: request.project,
    argv: request.argv,
    created_at: new Date().toISOString(),
  });

  process.stderr.write(`Waiting for approval on ${client}: ${command}\n`);

  try {
    for (;;) {
      const decision = await readDecision(id);

      if (decision?.decision === 'allow') {
        return 'answer';
      }

      if (decision?.decision === 'deny') {
        logDecision(request, 'deny', 'ask', started, 1);

        throw new CoramiError({ code: 'generic', message: `Denied on ${client}: ${command}` });
      }

      if (await granted(request.project)) {
        return 'grant';
      }

      if (!isPending(id)) {
        throw new CoramiError({
          code: 'generic',
          message: `The request was cancelled on ${client}: ${command}`,
        });
      }

      if (lost) {
        throw new CoramiError({
          code: 'generic',
          message: 'The connection closed while waiting for approval',
        });
      }

      if (Date.now() - started >= APPROVAL_WAIT_MS) {
        throw new CoramiError({
          code: 'generic',
          message: `Not answered on ${client} within ${approvalSeconds()} seconds: ${command}`,
          fix: `Run the command again and answer the dialog on ${client}, or keep corami exec approve open there. corami doctor on ${client} checks the dialog`,
        });
      }

      await Bun.sleep(POLL_MS);
    }
  } finally {
    stopWatching();
    await removePending(id);
  }
}

async function granted(project: string): Promise<boolean> {
  return activeGrant(await readGrants(), project) !== undefined;
}

function loggedRule(choice: ExecChoice, approval: Approval | undefined): string | undefined {
  if (approval === 'grant') {
    return 'grant';
  }

  return choice.rule?.decision;
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

  const stopWatching = watchConnection(() => {
    killGroup(child.pid);
  });

  await writeRunning({
    id,
    project: request.project,
    program: request.argv[0] ?? '',
    pgid: child.pid,
    started_at: new Date().toISOString(),
  });

  const exitCode = await child.exited;

  stopWatching();
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
