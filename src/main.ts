#!/usr/bin/env bun
import { allCommands } from '@/cli/commands/index.ts';
import { reportError, resolveOutputOptions } from '@/cli/output.ts';
import { parseArgs } from '@/cli/parser.ts';
import { runRouter } from '@/cli/router.ts';

export function valueFlags(): string[] {
  const names = new Set<string>();

  for (const command of allCommands()) {
    for (const flag of command.flags ?? []) {
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
