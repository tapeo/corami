import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { stringFlag } from '@/cli/parser.ts';
import { readGlobalConfig } from '@/core/config.ts';
import {
  type CheckResult,
  type CheckStatus,
  checkListeningPorts,
  checkPinnedTools,
  checkServeRules,
  checkTailscale,
} from '@/core/doctor.ts';
import { CoramiError } from '@/core/errors.ts';
import { findTool, MUTAGEN } from '@/core/pinned-tools.ts';
import { daemonServiceActive } from '@/integrations/mutagen.ts';
import {
  gitWatchSpec,
  serviceActive,
  serviceDirHint,
  servicePlatform,
} from '@/integrations/service.ts';

export const DOCTOR_AREAS = ['net', 'tools', 'git'] as const;

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: 'ok',
  warn: 'warning',
  fail: 'error',
  skip: 'skipped',
};

async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const requested = stringFlag(context.args, 'area') ?? context.args.positionals[0];

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
  ]);

  return groups.flat();
}

async function checkGitService(): Promise<CheckResult[]> {
  const spec = gitWatchSpec(process.execPath);
  const active = await serviceActive(spec).catch(() => false);

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

  return [
    {
      area: 'git',
      id: 'git.service',
      status: 'warn',
      summary: 'git alignment service not running',
      detail: `Expected under ${serviceDirHint()} (${servicePlatform()})`,
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
  usage: 'corami doctor [area]',
  flags: [
    { name: 'json', description: 'Output JSON' },
    { name: 'area', value: 'area', description: `One area only: ${DOCTOR_AREAS.join(', ')}` },
  ],
  examples: ['corami doctor', 'corami doctor net'],
  run,
};
