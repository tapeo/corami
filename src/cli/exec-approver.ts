import type { CommandContext, CommandResult } from '@/cli/command.ts';
import {
  isPending,
  listPending,
  type PendingRequest,
  readRules,
  writeDecision,
  writeRules,
} from '@/cli/exec-files.ts';
import { canPrompt, type Prompter, terminalPrompter } from '@/cli/prompt.ts';
import { CoramiError, toCoramiError } from '@/core/errors.ts';
import { commandPath, run } from '@/core/exec.ts';
import {
  type ApprovalChoice,
  alwaysArgv,
  approvalOptions,
  approvalQuestion,
  type DialogTool,
  dialogChoice,
  dialogCommand,
  graphicalEnv,
  hasDisplay,
} from '@/core/exec-approval.ts';
import { addRule, newRule } from '@/core/exec-rules.ts';

const POLL_MS = 500;

type Report = (line: string) => void;

interface Presenter {
  ask(request: PendingRequest, signal: AbortSignal): Promise<ApprovalChoice | undefined>;
}

interface DialogSetup {
  tool: DialogTool;
  env: Record<string, string | undefined>;
}

export async function approve(context: CommandContext): Promise<CommandResult> {
  if (!canPrompt(context.output)) {
    throw new CoramiError({
      code: 'usage',
      message: 'exec approve runs only in a terminal on the client',
      fix: 'Open a terminal on the client, also over ssh, and run corami exec approve there',
    });
  }

  const prompter = terminalPrompter();

  prompter.say('Waiting for the requests of the server. Ctrl-C stops.');

  return answerLoop(terminalPresenter(prompter), (line) => prompter.say(line));
}

export async function approver(_context: CommandContext): Promise<CommandResult> {
  const report = (line: string) => {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };

  return answerLoop(dialogPresenter(report), report);
}

async function answerLoop(presenter: Presenter, report: Report): Promise<never> {
  let seen = new Set<string>();

  for (;;) {
    const pending = await listPending();
    const ids = new Set(pending.map((request) => request.id));

    seen = new Set([...seen].filter((id) => ids.has(id)));

    const next = pending.find((request) => !seen.has(request.id));

    if (next === undefined) {
      await Bun.sleep(POLL_MS);
      continue;
    }

    seen.add(next.id);

    try {
      report(await present(presenter, next));
    } catch (error) {
      report(toCoramiError(error).message);
    }
  }
}

async function present(presenter: Presenter, request: PendingRequest): Promise<string> {
  const controller = new AbortController();
  const watcher = setInterval(() => {
    if (!isPending(request.id)) {
      controller.abort();
    }
  }, POLL_MS);
  let choice: ApprovalChoice | undefined;

  try {
    choice = await presenter.ask(request, controller.signal);
  } finally {
    clearInterval(watcher);
  }

  const command = request.argv.join(' ');

  if (choice === undefined || controller.signal.aborted) {
    return `Not answered here: ${command}`;
  }

  return answerRequest(request, choice);
}

async function answerRequest(request: PendingRequest, choice: ApprovalChoice): Promise<string> {
  const command = request.argv.join(' ');

  if (choice === 'deny') {
    if (!writeDecision(request.id, { decision: 'deny' })) {
      return `Not answered here: ${command}`;
    }

    return `✓ Denied: ${command}`;
  }

  if (!writeDecision(request.id, { decision: 'allow' })) {
    return `Not answered here: ${command}`;
  }

  if (choice === 'once') {
    return `✓ Allowed once: ${command}`;
  }

  const argv = alwaysArgv(request.argv);

  await writeRules(addRule(await readRules(), newRule('allow', argv, request.project)));

  return `✓ Allowed, rule added: allow ${argv.join(' ')}`;
}

function terminalPresenter(prompter: Prompter): Presenter {
  return {
    async ask(request, signal) {
      prompter.say();

      for (const line of approvalQuestion(request)) {
        prompter.say(line);
      }

      prompter.say();

      try {
        return await prompter.choose(
          'What do you allow?',
          approvalOptions(request.argv),
          0,
          signal,
        );
      } catch {
        return undefined;
      }
    },
  };
}

function dialogPresenter(report: Report): Presenter {
  return {
    async ask(request, signal) {
      const setup = await dialogSetup(report);

      if (setup === undefined) {
        return undefined;
      }

      const options = approvalOptions(request.argv);
      const child = Bun.spawn({
        cmd: dialogCommand(setup.tool, approvalQuestion(request).join('\n'), options),
        env: setup.env,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const close = () => {
        child.kill();
      };

      signal.addEventListener('abort', close, { once: true });

      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);

      signal.removeEventListener('abort', close);

      if (signal.aborted) {
        return undefined;
      }

      return dialogChoice(setup.tool, exitCode, stdout, options);
    },
  };
}

async function dialogSetup(report: Report): Promise<DialogSetup | undefined> {
  if (process.platform === 'darwin') {
    return { tool: 'osascript', env: process.env };
  }

  if (process.platform !== 'linux') {
    report(`No approval dialog on ${process.platform}: answer with corami exec approve`);
    return undefined;
  }

  if ((await commandPath('zenity')) === undefined) {
    report('zenity is missing: answer with corami exec approve');
    return undefined;
  }

  const session = await run('systemctl', ['--user', 'show-environment'], { timeoutMs: 5_000 });
  const env = { ...process.env, ...graphicalEnv(session.stdout) };

  if (!hasDisplay(env)) {
    report('No graphical session: answer with corami exec approve');
    return undefined;
  }

  return { tool: 'zenity', env };
}
