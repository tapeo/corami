import { existsSync } from 'node:fs';

import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { clientConfig, readAuthorizedKeys } from '@/cli/exec-client-config.ts';
import { gateCommand } from '@/cli/exec-client-system.ts';
import { findExecLine } from '@/core/exec-ssh-keys.ts';

export async function clientStatus(context: CommandContext): Promise<CommandResult> {
  const { server } = await clientConfig();
  const line = findExecLine(await readAuthorizedKeys(), server);
  const gate = gateOf(line) ?? (await gateCommand().catch(() => ''));
  const binary = gateBinary(gate);
  let gateExists: boolean | null = null;

  if (line !== undefined) {
    gateExists = binary !== undefined && existsSync(binary);
  }

  if (context.output.json) {
    return {
      data: {
        role: 'client',
        server,
        connected: line !== undefined,
        gate,
        gate_exists: gateExists,
      },
    };
  }

  const lines = [`Server      ${server}`, `Connection  ${connectionText(line !== undefined)}`];

  if (line !== undefined && !gateExists) {
    lines.push(`Gate        ${gate} (missing: run corami exec setup again)`);
  } else {
    lines.push(`Gate        ${gate}`);
  }

  return { text: lines.join('\n') };
}

function connectionText(connected: boolean): string {
  if (connected) {
    return 'on';
  }

  return 'off, turn it on with corami exec setup';
}

function gateOf(line: string | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }

  const match = /command="([^"]*)"/.exec(line);

  return match?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function gateBinary(gate: string): string | undefined {
  const quoted = /^'([^']*)'/.exec(gate);

  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }

  return gate.split(' ')[0];
}
