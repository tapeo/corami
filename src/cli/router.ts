import {
  type CommandSpec,
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
import { ownerToSwitchTo, readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { firstSteps } from '@/core/next-steps.ts';
import { VERSION } from '@/version.ts';

export interface RouterOptions {
  argv: string[];
  commands: CommandSpec[];
  output: OutputOptions;
  valueFlags?: string[];
}

export async function runRouter(options: RouterOptions): Promise<number> {
  const args = parseArgs(options.argv, { valueFlags: options.valueFlags ?? [] });

  // Only a bare `--version` is the global flag: a string value, as in
  // `corami update --version v0.3.0`, belongs to the command.
  if (args.values.version === true) {
    emit(success({ name: 'corami', version: VERSION }), options.output);
    return 0;
  }

  // `corami help sync prune` is `corami sync prune --help`.
  const asked = args.positionals[0] === 'help';
  const positionals = asked ? args.positionals.slice(1) : args.positionals;
  const wantsHelp = asked || booleanFlag(args, 'help');
  const command = resolveCommand(options.commands, positionals);

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

    const role = (await readGlobalConfig().catch(() => undefined))?.role;

    process.stdout.write(`${heading(`corami ${VERSION}`, options.output.color)}\n`);
    process.stdout.write(`${overview(data, firstSteps(role))}\n`);
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

  const owner = await accountToLeaveTo(command.name);

  if (owner !== undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `This server works as the account ${owner}: the files of this command would belong to root`,
      fix: `Run it as that account: su - ${owner} -c "corami ${args.positionals.join(' ')}"`,
    });
  }

  // The command and the action that were named leave the arguments.
  const result = await spec.run({
    args: { ...args, positionals: action === undefined ? rest : rest.slice(1) },
    output: options.output,
  });

  if (result.data !== undefined) {
    emit(success(result.data), options.output);
    return 0;
  }

  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);
  }

  return 0;
}

// The commands that may run as root on a server: `setup` runs the steps of the
// account again as the account, `update` replaces the binary where it runs,
// `doctor` reads and reports.
const ROOT_COMMANDS = ['setup', 'update', 'doctor'];

/**
 * The account to leave a command to, when this is a server whose projects
 * belong to another account and the command runs as root. Undefined when the
 * command runs where it is.
 */
async function accountToLeaveTo(name: string): Promise<string | undefined> {
  if (ROOT_COMMANDS.includes(name)) {
    return undefined;
  }

  return ownerToSwitchTo();
}
