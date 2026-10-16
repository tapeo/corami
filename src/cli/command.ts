import { styleText } from 'node:util';
import type { OutputOptions } from '@/cli/output.ts';
import type { ParsedArgs } from '@/cli/parser.ts';

export interface CommandContext {
  args: ParsedArgs;
  output: OutputOptions;
}

export interface CommandResult {
  data?: unknown;
  text?: string;
}

export interface FlagSpec {
  name: string;
  description: string;
  value?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpec[];
  examples?: string[];
  run: (context: CommandContext) => Promise<CommandResult> | CommandResult;
}

export function resolveCommand(
  commands: CommandSpec[],
  positionals: string[],
): CommandSpec | undefined {
  const first = positionals[0];

  if (first === undefined) {
    return undefined;
  }

  return commands.find((command) => command.name === first);
}

export function usageFor(command: CommandSpec): string {
  const lines = [command.summary, '', `Usage: ${command.usage}`];

  if (command.flags !== undefined && command.flags.length > 0) {
    lines.push('', 'Flags:');

    for (const flag of command.flags) {
      const value = flag.value === undefined ? '' : ` <${flag.value}>`;
      lines.push(`  --${flag.name}${value}  ${flag.description}`);
    }
  }

  if (command.examples !== undefined && command.examples.length > 0) {
    lines.push('', 'Examples:');

    for (const example of command.examples) {
      lines.push(`  ${example}`);
    }
  }

  return lines.join('\n');
}

export function overview(commands: CommandSpec[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = ['Commands:'];

  for (const command of commands) {
    lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }

  lines.push(
    '',
    'Usage: corami <command> [arguments] [--json]',
    'Add --help to a command for the details.',
  );

  return lines.join('\n');
}

export function heading(text: string, color: boolean): string {
  if (!color) {
    return text;
  }

  return styleText('bold', text);
}
