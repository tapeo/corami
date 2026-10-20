import {
  type ActionSpec,
  type CommandSpec,
  checkArguments,
  checkFlags,
  heading,
  helpData,
  missingAction,
  overview,
  overviewData,
  resolveAction,
  resolveCommand,
  usageFor,
} from '@/cli/command.ts';
import { emit, type OutputOptions, success } from '@/cli/output.ts';
import { booleanFlag, parseArgs } from '@/cli/parser.ts';
import { ownerToSwitchTo } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { shellQuote } from '@/core/exec.ts';
import { VERSION } from '@/version.ts';

export interface RouterOptions {
  argv: string[];
  commands: CommandSpec[];
  output: OutputOptions;
  valueFlags?: string[];
}

export async function runRouter(options: RouterOptions): Promise<number> {
  const args = parseArgs(options.argv, { valueFlags: options.valueFlags ?? [] });

  const asked = args.positionals[0] === 'help';
  const positionals = asked ? args.positionals.slice(1) : args.positionals;
  const wantsHelp = asked || booleanFlag(args, 'help');
  const command = resolveCommand(options.commands, positionals);

  if (args.values.version === true && !declaresVersion(command)) {
    emit(success({ name: 'corami', version: VERSION }), options.output);
    return 0;
  }

  if (command === undefined) {
    if (positionals.length > 0) {
      throw new CoramiError({
        code: 'usage',
        message: `Unknown command: ${positionals[0] ?? ''}`,
        fix: 'Run corami --help to see the available commands',
      });
    }

    const data = overviewData(options.commands, VERSION);

    if (options.output.json) {
      emit(success(data), options.output);
      return 0;
    }

    process.stdout.write(`${heading(`corami ${VERSION}`, options.output.color)}\n`);
    process.stdout.write(`${overview(data)}\n`);
    return 0;
  }

  const rest = positionals.slice(1);
  const action = resolveAction(command, rest);
  const spec = action ?? command;
  const path = action === undefined ? command.name : `${command.name} ${action.name}`;

  if (wantsHelp) {
    if (options.output.json) {
      emit(success(helpData(spec, path)), options.output);
      return 0;
    }

    process.stdout.write(`${usageFor(spec, path)}\n`);
    return 0;
  }

  checkFlags(spec, args.values, path);

  if (spec.run === undefined) {
    throw missingAction(command, rest[0]);
  }

  const given = action === undefined ? rest : rest.slice(1);

  checkArguments(spec, given, path);

  const owner = await accountToLeaveTo(command.name);

  if (owner !== undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `This server works as the account ${owner}: the files of this command would belong to root`,
      fix: switchUserFix(owner, options.argv),
    });
  }

  const result = await spec.run({
    args: { ...args, positionals: given },
    output: options.output,
  });

  if (result.data !== undefined) {
    emit(success(result.data), options.output);
    return result.exitCode ?? 0;
  }

  if (result.text !== undefined) {
    if (options.output.json) {
      emit(success({ text: result.text }), options.output);
      return result.exitCode ?? 0;
    }

    process.stdout.write(`${result.text}\n`);
  }

  return result.exitCode ?? 0;
}

function declaresVersion(command: CommandSpec | undefined): boolean {
  const specs: Array<CommandSpec | ActionSpec> =
    command === undefined ? [] : [command, ...(command.actions ?? [])];

  return specs.some((spec) => (spec.flags ?? []).some((flag) => flag.name === 'version'));
}

export function switchUserFix(owner: string, argv: string[]): string {
  return `Run it as that account: su - ${owner} -c ${shellQuote(['corami', ...argv].join(' '))}`;
}

const ROOT_COMMANDS = ['setup', 'update', 'doctor'];

async function accountToLeaveTo(name: string): Promise<string | undefined> {
  if (ROOT_COMMANDS.includes(name)) {
    return undefined;
  }

  return ownerToSwitchTo();
}
