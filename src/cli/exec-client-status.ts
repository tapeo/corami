import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { clientConfig, readAuthorizedKeys } from '@/cli/exec-client-config.ts';
import { readSshdConfig } from '@/cli/exec-client-system.ts';
import {
  listPending,
  listRunning,
  type RunningCommand,
  readExecState,
  readRules,
} from '@/cli/exec-files.ts';
import { execLineAddresses, findExecLine } from '@/core/exec-ssh-keys.ts';
import { sshdAcceptsPasswords } from '@/core/exec-sshd.ts';

export async function clientStatus(context: CommandContext): Promise<CommandResult> {
  const { server } = await clientConfig();
  const existing = await readAuthorizedKeys();
  const line = findExecLine(existing, server);
  const state = await readExecState();
  const keysOnly = !sshdAcceptsPasswords(await readSshdConfig());
  const list = await readRules();
  const pending = await listPending();
  const running = await listRunning();
  const addresses = execLineAddresses(line);

  if (context.output.json) {
    return {
      data: {
        role: 'client',
        server,
        allowed: line !== undefined,
        allowed_since: state?.since ?? null,
        sshd: keysOnly ? 'keys only' : 'accepts passwords',
        addresses,
        rules: list.length,
        waiting: pending.length,
        running: running.map((entry) => ({
          program: entry.program,
          project: entry.project,
          started_at: entry.started_at,
        })),
        log: '~/.corami/logs/exec.log',
      },
    };
  }

  const lines = [
    `Allowed       ${line === undefined ? 'no' : `yes, since ${state?.since.slice(0, 16).replace('T', ' ') ?? 'unknown'}`}`,
    `Server        ${server}${addresses.length === 0 ? '' : `, from ${addresses.join(', ')}`}`,
    `sshd          ${keysOnly ? 'keys only' : 'accepts passwords'}`,
    `Rules         ${list.length}${list.length === 0 ? '' : ' (corami exec rules)'}`,
    `Waiting       ${pending.length === 0 ? 'none' : `${pending.length} (corami exec approve)`}`,
    `Running       ${describeRunning(running)}`,
    'Last commands ~/.corami/logs/exec.log',
  ];

  return { text: lines.join('\n') };
}

function describeRunning(running: RunningCommand[]): string {
  if (running.length === 0) {
    return 'none';
  }

  const first = running[0];

  if (first === undefined) {
    return 'none';
  }

  if (running.length > 1) {
    return `${first.program} (${first.project}), and ${running.length - 1} more`;
  }

  return `${first.program} (${first.project}), started ${sinceText(first.started_at)}`;
}

function sinceText(startedAt: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60_000));

  if (minutes < 1) {
    return 'just now';
  }

  return `${minutes} min ago`;
}
