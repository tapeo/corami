import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { CommandContext, CommandSpec } from '@/cli/command.ts';

import { projectRoot, projectsRootFor, readGlobalConfig } from '@/core/config.ts';
import {
  type CheckResult,
  type CheckStatus,
  checkListeningPorts,
  checkPinnedTools,
  checkServeRules,
  checkTailscale,
} from '@/core/doctor.ts';
import { CoramiError } from '@/core/errors.ts';
import { run as runCommand } from '@/core/exec.ts';
import { findTool, MUTAGEN } from '@/core/pinned-tools.ts';
import { canSudo, ownerOfServer, privilegedGroups } from '@/core/server-user.ts';
import { daemonServiceActive } from '@/integrations/mutagen.ts';
import {
  gitWatchSpec,
  serviceActive,
  serviceDirHint,
  servicePlatform,
} from '@/integrations/service.ts';
import { homeDirectoryForUser, systemctlAsUser } from '@/integrations/systemd.ts';

export const DOCTOR_AREAS = ['net', 'tools', 'git', 'server'] as const;

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: 'ok',
  warn: 'warning',
  fail: 'error',
  skip: 'skipped',
};

async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const requested = context.args.positionals[0];

  if (requested !== undefined && !isArea(requested)) {
    throw new CoramiError({
      code: 'usage',
      message: `Unknown area: ${requested}`,
      fix: `Available areas: ${DOCTOR_AREAS.join(', ')}`,
    });
  }

  const checks = await collectChecks();
  const filtered =
    requested === undefined ? checks : checks.filter((check) => check.area === requested);

  if (context.output.json) {
    return {
      data: {
        areas: DOCTOR_AREAS,
        counts: countByStatus(filtered),
        checks: filtered,
      },
    };
  }

  return { text: render(filtered) };
}

function isArea(value: string): value is (typeof DOCTOR_AREAS)[number] {
  return (DOCTOR_AREAS as readonly string[]).includes(value);
}

async function collectChecks(): Promise<CheckResult[]> {
  const groups = await Promise.all([
    checkTailscale(),
    checkServeRules(),
    checkListeningPorts(),
    checkPinnedTools(),
    checkGitService(),
    checkSyncDaemon(),
    checkServerAccount(),
  ]);

  return groups.flat();
}

interface ServerAccount {
  user: string;
  home: string;
}

// Servers only, and only when this process is not the account: the home, the
// projects and the user units of the account are then somewhere else.
async function serverAccount(): Promise<ServerAccount | undefined> {
  const config = await readGlobalConfig().catch(() => undefined);
  const user = ownerOfServer(config);

  if (user === undefined || user === userInfo().username) {
    return undefined;
  }

  const home = await homeDirectoryForUser(user);
  return home === undefined ? undefined : { user, home };
}

// Servers only: the account that owns the projects. Root would work, but a
// wrong agent or dependency would then take the whole machine, so it is worth
// a warning rather than nothing. The paths are the ones of the account, which
// are not the ones of the home of this process when doctor runs as root.
async function checkServerAccount(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'server') {
    return [];
  }

  const user = config.server_user;

  if (user === undefined) {
    return [
      {
        area: 'server',
        id: 'server.account',
        status: 'warn',
        summary: 'No account owns the projects: they live in the home of root',
        detail: 'Run corami setup server --user <account> as root to create one',
      },
    ];
  }

  const home = await homeDirectoryForUser(user);
  const projects = home === undefined ? projectRoot() : projectsRootFor(home);
  const legacy = join('/root', 'corami', 'projects');
  const [groups, sudo, foreign] = await Promise.all([
    runCommand('id', ['-nG', user]),
    runCommand('sudo', ['-n', '-l', '-U', user]),
    runCommand('find', [projects, '!', '-user', user, '-print', '-quit']),
  ]);
  const checks: CheckResult[] = [
    {
      area: 'server',
      id: 'server.account',
      status: 'ok',
      summary: `The projects are owned by ${user}`,
      detail: projects,
    },
  ];

  if (existsSync(legacy)) {
    checks.push({
      area: 'server',
      id: 'server.legacy',
      status: 'fail',
      summary: 'Projects of root are still in /root/corami/projects',
      detail: 'They are not the ones the clients sync',
      fix: 'Move them to the account of the projects, then remove /root/corami',
    });
  }

  const foreignEntry = foreign.ok ? foreign.stdout.trim() : '';

  if (foreignEntry !== '') {
    checks.push({
      area: 'server',
      id: 'server.owner',
      status: 'warn',
      summary: `Some files in the projects are not owned by ${user}`,
      detail: foreignEntry,
      fix: `chown -R ${user}:${user} ${projects}`,
    });
  }

  const privileged = privilegedGroups(groups.ok ? groups.stdout : '');
  const sudoAllowed = sudo.ok && canSudo(sudo.stdout);

  if (privileged.length > 0 || sudoAllowed) {
    const ways = [...privileged, ...(sudoAllowed ? ['sudo'] : [])].join(', ');

    checks.push({
      area: 'server',
      id: 'server.privileges',
      status: 'warn',
      summary: `${user} can become root (${ways})`,
      detail: 'The separation only holds when the account that runs the agents is not privileged',
    });
  } else {
    checks.push({
      area: 'server',
      id: 'server.privileges',
      status: 'ok',
      summary: `${user} cannot become root`,
    });
  }

  return checks;
}

async function checkGitService(): Promise<CheckResult[]> {
  const spec = gitWatchSpec(process.execPath);
  const account = await serverAccount();
  const active =
    account === undefined
      ? await serviceActive(spec).catch(() => false)
      : (await systemctlAsUser(account.user, ['is-active', spec.name])).stdout.trim() === 'active';

  if (active) {
    return [
      {
        area: 'git',
        id: 'git.service',
        status: 'ok',
        summary: 'git alignment service running',
      },
    ];
  }

  const dir =
    account === undefined ? serviceDirHint() : join(account.home, '.config', 'systemd', 'user');

  return [
    {
      area: 'git',
      id: 'git.service',
      status: 'warn',
      summary: 'git alignment service not running',
      detail: `Expected under ${dir} (${servicePlatform()})`,
      fix: 'corami setup client <server> --step git-watch on a client, corami setup server --step git-watch on the server',
    },
  ];
}

// Clients only: without the Mutagen daemon as a service, the sync sessions stay
// paused after a reboot until the next mutagen command.
async function checkSyncDaemon(): Promise<CheckResult[]> {
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const binary = await findTool(MUTAGEN);

  if (role !== 'client' || binary === undefined) {
    return [];
  }

  const active = await daemonServiceActive(binary).catch(() => false);

  if (active === undefined) {
    return [];
  }

  if (active) {
    return [
      {
        area: 'tools',
        id: 'mutagen.service',
        status: 'ok',
        summary: 'Mutagen daemon service running',
      },
    ];
  }

  return [
    {
      area: 'tools',
      id: 'mutagen.service',
      status: 'warn',
      summary: 'Mutagen daemon service not running: the sync stops after a reboot',
      fix: 'corami setup client <server> --step mutagen-daemon',
    },
  ];
}

function countByStatus(checks: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };

  for (const check of checks) {
    counts[check.status] += 1;
  }

  return counts;
}

function render(checks: CheckResult[]): string {
  if (checks.length === 0) {
    return 'No checks.';
  }

  return checks
    .map((check) => {
      const lines = [`[${STATUS_LABEL[check.status]}] ${check.id}: ${check.summary}`];

      if (check.detail !== undefined) {
        lines.push(`  ${check.detail}`);
      }

      if (check.fix !== undefined) {
        lines.push(`  fix: ${check.fix}`);
      }

      return lines.join('\n');
    })
    .join('\n');
}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Checks network, HTTPS, tools and services',
  usage: `corami doctor [${DOCTOR_AREAS.join('|')}]`,
  examples: ['corami doctor', 'corami doctor net'],
  run,
};
