import { styleText } from 'node:util';
import type { OutputOptions } from '@/cli/output.ts';
import type { FlagValue, ParsedArgs } from '@/cli/parser.ts';
import { CoramiError } from '@/core/errors.ts';

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

// The flags every command accepts: the router reads them before the command.
const GLOBAL_FLAGS = ['help', 'version', 'json'];

/**
 * Refuses a flag the command does not declare, and a declared flag that needs
 * a value and has none, so that a typo or a lost value is never ignored.
 */
export function checkFlags(command: CommandSpec, values: Record<string, FlagValue>): void {
  const flags = command.flags ?? [];

  for (const [key, value] of Object.entries(values)) {
    // `--no-git` is parsed as `git` set to false.
    const spec = flags.find((flag) => flag.name === key || flag.name === `no-${key}`);

    if (spec === undefined) {
      if (GLOBAL_FLAGS.includes(key)) {
        continue;
      }

      throw new CoramiError({
        code: 'usage',
        message: `Unknown flag for corami ${command.name}: ${key.length === 1 ? '-' : '--'}${key}`,
        fix: `Run corami ${command.name} --help to see its flags`,
      });
    }

    if (spec.value !== undefined && typeof value === 'boolean') {
      throw new CoramiError({
        code: 'usage',
        message: `Missing value for --${spec.name}`,
        fix: `Write --${spec.name} <${spec.value}>`,
      });
    }
  }
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
