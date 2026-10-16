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
  /** Left out of the list of commands: an entry point of a service. */
  hidden?: boolean;
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
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'json', description: 'JSON output, the default without a terminal' },
  { name: 'help', description: 'This help, also corami help <command> [<action>]' },
  { name: 'version', description: 'Version of corami' },
];

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
      if (GLOBAL_FLAGS.some((global) => global.name === key)) {
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

export interface HelpData {
  command: string;
  summary: string;
  usage: string;
  actions: Array<{ name: string; summary: string }>;
  flags: FlagSpec[];
  examples: string[];
  global_flags: FlagSpec[];
}

/** The help of a command or an action, as data. `path` names it: `sync prune`. */
export function helpData(spec: CommandSpec | ActionSpec, path: string): HelpData {
  const actions = 'actions' in spec ? (spec.actions ?? []) : [];

  return {
    command: path,
    summary: spec.summary,
    usage: spec.usage,
    actions: actions.map((action) => ({ name: action.name, summary: action.summary })),
    flags: spec.flags ?? [],
    examples: spec.examples ?? [],
    global_flags: GLOBAL_FLAGS,
  };
}

export function usageFor(spec: CommandSpec | ActionSpec, path: string): string {
  const help = helpData(spec, path);
  const lines = [help.summary, '', `Usage: ${help.usage}`];

  if (help.actions.length > 0) {
    lines.push(
      '',
      'Actions:',
      ...columns(help.actions.map((action) => [action.name, action.summary])),
    );
  }

  if (help.flags.length > 0) {
    lines.push('', 'Flags:', ...flagLines(help.flags));
  }

  if (help.examples.length > 0) {
    lines.push('', 'Examples:', ...help.examples.map((example) => `  ${example}`));
  }

  lines.push('', 'Global flags:', ...flagLines(help.global_flags));

  return lines.join('\n');
}

export interface OverviewData {
  name: string;
  version: string;
  commands: Array<{ name: string; summary: string }>;
  global_flags: FlagSpec[];
}

export function overviewData(commands: CommandSpec[], version: string): OverviewData {
  return {
    name: 'corami',
    version,
    commands: commands
      .filter((command) => command.hidden !== true)
      .map((command) => ({ name: command.name, summary: command.summary })),
    global_flags: GLOBAL_FLAGS,
  };
}

/** `start` are the commands that lead on from the state of this machine. */
export function overview(data: OverviewData, start: string[] = []): string {
  return [
    'Remote dev host for agents: projects on an always-on server, a synced copy on every computer.',
    '',
    ...(start.length === 0 ? [] : ['Start here:', ...start.map((step) => `  ${step}`), '']),
    'Commands:',
    ...columns(data.commands.map((command) => [command.name, command.summary])),
    '',
    'Global flags:',
    ...flagLines(data.global_flags),
    '',
    'Usage: corami <command> [<action>] [arguments]',
    'Add --help to a command or an action for the details.',
  ].join('\n');
}

function flagLines(flags: FlagSpec[]): string[] {
  return columns(
    flags.map((flag) => [
      `--${flag.name}${flag.value === undefined ? '' : ` <${flag.value}>`}`,
      flag.description,
    ]),
  );
}

function columns(rows: string[][]): string[] {
  const width = Math.max(...rows.map(([left = '']) => left.length));

  return rows.map(([left = '', right = '']) => `  ${left.padEnd(width)}  ${right}`);
}

export function heading(text: string, color: boolean): string {
  if (!color) {
    return text;
  }

  return styleText('bold', text);
}
