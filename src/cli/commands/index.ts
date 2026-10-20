import type { CommandSpec } from '@/cli/command.ts';
import { daemonCommand } from '@/cli/commands/daemon.ts';
import { doctorCommand } from '@/cli/commands/doctor.ts';
import { execCommand } from '@/cli/commands/exec.ts';
import { gitCommand } from '@/cli/commands/git.ts';
import { projectCommand } from '@/cli/commands/project.ts';
import { serveCommand } from '@/cli/commands/serve.ts';
import { setupCommand } from '@/cli/commands/setup.ts';
import { syncCommand } from '@/cli/commands/sync.ts';
import { updateCommand } from '@/cli/commands/update.ts';

export function allCommands(): CommandSpec[] {
  const implemented: CommandSpec[] = [
    doctorCommand,
    projectCommand,
    daemonCommand,
    setupCommand,
    serveCommand,
    syncCommand,
    updateCommand,
    gitCommand,
    execCommand,
  ];

  implemented.sort((left, right) => left.name.localeCompare(right.name));

  return implemented;
}
