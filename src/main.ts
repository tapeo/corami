#!/usr/bin/env bun
import { allSpecs } from '@/cli/command.ts';
import { allCommands } from '@/cli/commands/index.ts';
import { reportError, resolveOutputOptions } from '@/cli/output.ts';
import { parseArgs } from '@/cli/parser.ts';
import { runRouter } from '@/cli/router.ts';

// The arguments are read once, before the command is known: a flag takes the
// next word as its value when any command or action declares it with one.
export function valueFlags(): string[] {
  const names = new Set<string>();

  for (const spec of allSpecs(allCommands())) {
    for (const flag of spec.flags ?? []) {
      if (flag.value !== undefined) {
        names.add(flag.name);
      }
    }
  }

  return [...names];
}

export async function main(argv: string[]): Promise<number> {
  const declared = valueFlags();
  const args = parseArgs(argv, { valueFlags: declared });
  const output = resolveOutputOptions(args.values);

  try {
    return await runRouter({ argv, commands: allCommands(), output, valueFlags: declared });
  } catch (error) {
    return reportError(error, output);
  }
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2));
  process.exit(code);
}
