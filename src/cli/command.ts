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

export type RunCommand = (context: CommandContext) => Promise<CommandResult> | CommandResult;

/** One of the things a command does, called by name: `corami sync prune`. */
export interface ActionSpec {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpec[];
  examples?: string[];
  run: RunCommand;
}

/**
 * A command. Its own flags, usage and `run` apply when no action is named, as
 * in `corami serve 3000`; a command whose actions cover everything it does has
 * no `run`, and called alone asks for an action.
 */
export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpec[];
  examples?: string[];
  actions?: ActionSpec[];
  run?: RunCommand;
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

/**
 * The action named by the first argument after the command, undefined when
 * that argument names none: the command itself runs then.
 */
export function resolveAction(command: CommandSpec, rest: string[]): ActionSpec | undefined {
  const first = rest[0];

  if (first === undefined) {
    return undefined;
  }

  return command.actions?.find((action) => action.name === first);
}

/** The usage error of a command that needs an action and got none it knows. */
export function missingAction(command: CommandSpec, given: string | undefined): CoramiError {
  const names = (command.actions ?? []).map((action) => action.name);
  const last = names.at(-1);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${last}` : (last ?? '');

  return new CoramiError({
    code: 'usage',
    message:
      given === undefined
        ? `Missing action for corami ${command.name}`
        : `Unknown action for corami ${command.name}: ${given}`,
    fix: `Use corami ${command.name} ${list}`,
  });
}

/** Every command and action, for what is read across all of them. */
export function allSpecs(commands: CommandSpec[]): Array<CommandSpec | ActionSpec> {
  return commands.flatMap((command) => [command, ...(command.actions ?? [])]);
}

// The flags every command accepts: the router reads them before the command.
const GLOBAL_FLAGS = ['help', 'version', 'json'];

/**
 * Refuses a flag the command or the action does not declare, and a declared
 * flag that needs a value and has none, so that a typo or a lost value is
 * never ignored. `path` names it in the error, as in `sync prune`.
 */
export function checkFlags(
  spec: CommandSpec | ActionSpec,
  values: Record<string, FlagValue>,
  path: string,
): void {
  const flags = spec.flags ?? [];

  for (const [key, value] of Object.entries(values)) {
    // `--no-git` is parsed as `git` set to false.
    const flag = flags.find((item) => item.name === key || item.name === `no-${key}`);

    if (flag === undefined) {
      if (GLOBAL_FLAGS.includes(key)) {
        continue;
      }

      throw new CoramiError({
        code: 'usage',
        message: `Unknown flag for corami ${path}: ${key.length === 1 ? '-' : '--'}${key}`,
        fix: `Run corami ${path} --help to see its flags`,
      });
    }

    if (flag.value !== undefined && typeof value === 'boolean') {
      throw new CoramiError({
        code: 'usage',
        message: `Missing value for --${flag.name}`,
        fix: `Write --${flag.name} <${flag.value}>`,
      });
    }
  }
}

export function usageFor(spec: CommandSpec | ActionSpec): string {
  const lines = [spec.summary, '', `Usage: ${spec.usage}`];
  const actions = 'actions' in spec ? (spec.actions ?? []) : [];

  if (actions.length > 0) {
    const width = Math.max(...actions.map((action) => action.name.length));
    lines.push('', 'Actions:');

    for (const action of actions) {
      lines.push(`  ${action.name.padEnd(width)}  ${action.summary}`);
    }
  }

  if (spec.flags !== undefined && spec.flags.length > 0) {
    lines.push('', 'Flags:');

    for (const flag of spec.flags) {
      const value = flag.value === undefined ? '' : ` <${flag.value}>`;
      lines.push(`  --${flag.name}${value}  ${flag.description}`);
    }
  }

  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push('', 'Examples:');

    for (const example of spec.examples) {
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
