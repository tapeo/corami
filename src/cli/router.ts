import { type CommandSpec, heading, overview, resolveCommand, usageFor } from '@/cli/command.ts';
import { ownerToSwitchTo } from '@/cli/commands/setup-server-user.ts';
import { emit, type OutputOptions, success } from '@/cli/output.ts';
import { booleanFlag, type ParsedArgs, parseArgs } from '@/cli/parser.ts';
import { CoramiError } from '@/core/errors.ts';
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

  const command = resolveCommand(options.commands, args.positionals);

  if (command === undefined) {
    if (!booleanFlag(args, 'help') && args.positionals.length > 0) {
      throw new CoramiError({
        code: 'usage',
        message: `Unknown command: ${args.positionals[0] ?? ''}`,
        fix: 'Run corami --help to see the available commands',
      });
    }

    process.stdout.write(`${heading(`corami ${VERSION}`, options.output.color)}\n`);
    process.stdout.write(`${overview(options.commands)}\n`);
    return 0;
  }

  if (booleanFlag(args, 'help')) {
    process.stdout.write(`${usageFor(command)}\n`);
    return 0;
  }

  const owner = await accountToLeaveTo(command.name);

  if (owner !== undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `This server works as the account ${owner}: the files of this command would belong to root`,
      fix: `Run it as that account: su - ${owner} -c "corami ${args.positionals.join(' ')}"`,
    });
  }

  const result = await command.run({
    args: withoutCommand(args, command.name),
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

function withoutCommand(args: ParsedArgs, name: string): ParsedArgs {
  const positionals = [...args.positionals];
  const index = positionals.indexOf(name);

  if (index !== -1) {
    positionals.splice(index, 1);
  }

  return { ...args, positionals };
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
