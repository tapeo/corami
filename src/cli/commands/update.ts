import { chmodSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import {
  downloadReleaseBinary,
  isNewer,
  latestRelease,
  REPO,
  type ReleaseInfo,
  releaseByTag,
  replaceBinary,
} from '@/core/release.ts';
import { ownerBinary, ownerOfServer } from '@/core/server-user.ts';
import {
  gitWatchSpec,
  refreshService,
  type ServiceRefresh,
  type ServiceSpec,
  serviceInstalled,
  servicePlatform,
} from '@/integrations/service.ts';
import { homeDirectoryForUser, systemctlAsUser, userId } from '@/integrations/systemd.ts';
import { VERSION } from '@/version.ts';

async function run_(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const requested = stringFlag(context.args, 'version');
  const check = booleanFlag(context.args, 'check');

  if (!check && !Bun.isStandaloneExecutable) {
    throw new CoramiError({
      code: 'generic',
      message:
        'corami update replaces the binary it runs from, this run comes from the source tree',
      fix: 'Run corami update from the installed binary, or use --check to compare versions',
    });
  }

  const release = await wantedRelease(requested);
  const newer = isNewer(release.version, VERSION);

  if (check) {
    if (context.output.json) {
      return { data: { current: VERSION, latest: release.version, update_available: newer } };
    }

    return {
      text: newer
        ? `Update available: ${release.version} (this version is ${VERSION})`
        : `Up to date: ${VERSION}`,
    };
  }

  if (requested === undefined && !newer && !booleanFlag(context.args, 'force')) {
    if (context.output.json) {
      return { data: { current: VERSION, latest: release.version, updated: false } };
    }

    return { text: `Already on ${VERSION}.` };
  }

  const binary = resolveBinary();
  const downloaded = await downloadReleaseBinary({
    release,
    platform: process.platform,
    arch: process.arch,
    currentBinary: binary,
  });

  replaceBinary(binary, downloaded.path);
  const copiedToOwner = await copyToOwner();
  const restarted = await restartDaemon();
  const watch = await refreshGitWatch(binary);
  const steps = await postUpdateSteps(binary);
  const failures = [watch].flatMap((result) =>
    result === undefined || result.ok
      ? []
      : [{ name: result.name, detail: result.detail, fix: result.fix }],
  );

  const summary = {
    from: VERSION,
    to: downloaded.version,
    binary,
    account_binary_updated: copiedToOwner,
    restarted_daemon: restarted,
    restarted_git_watch: watch?.ok === true,
    service_failures: failures,
    next_steps: steps,
  };

  if (context.output.json) {
    return { data: summary };
  }

  return {
    text: [
      `Updated from ${VERSION} to ${downloaded.version}.`,
      `Binary: ${binary}`,
      copiedToOwner ? 'The account that owns the projects runs the same binary.' : '',
      restarted ? 'Daemon service restarted.' : '',
      watch?.ok === true ? 'Git alignment service registered again and running.' : '',
      ...failures.map(
        (failure) =>
          `${failure.name} not running after the update: ${failure.detail}. ${failure.fix}`,
      ),
      ...(steps.length === 0
        ? []
        : [
            'Steps after the update:',
            ...steps.map(
              (step) => `  ${step.summary}${step.fix === undefined ? '' : `. ${step.fix}`}`,
            ),
          ]),
    ]
      .filter((line) => line !== '')
      .join('\n'),
  };
}

export interface PendingStep {
  id: string;
  summary: string;
  fix?: string;
}

const NEXT_STEP_CHECKS = ['mutagen.ignores', 'mutagen.watch', 'exec.setup'];

interface DoctorCheck {
  id: string;
  status: string;
  summary: string;
  fix?: string;
}

export function pendingSteps(answer: unknown): PendingStep[] {
  return checksOf(answer)
    .filter((check) => NEXT_STEP_CHECKS.includes(check.id) && check.status !== 'ok')
    .map((check) => ({
      id: check.id,
      summary: check.summary,
      ...(check.fix === undefined ? {} : { fix: check.fix }),
    }));
}

function checksOf(answer: unknown): DoctorCheck[] {
  if (typeof answer !== 'object' || answer === null) {
    return [];
  }

  const data = (answer as { data?: unknown }).data;

  if (typeof data !== 'object' || data === null) {
    return [];
  }

  const checks = (data as { checks?: unknown }).checks;

  if (!Array.isArray(checks)) {
    return [];
  }

  return checks.filter(isDoctorCheck);
}

function isDoctorCheck(value: unknown): value is DoctorCheck {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  return (
    typeof entry.id === 'string' &&
    typeof entry.status === 'string' &&
    typeof entry.summary === 'string' &&
    (entry.fix === undefined || typeof entry.fix === 'string')
  );
}

async function postUpdateSteps(binary: string): Promise<PendingStep[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'client') {
    return [];
  }

  const result = await run(binary, ['doctor', '--json'], { timeoutMs: 60_000 });

  if (!result.ok) {
    return [doctorFallback('The new binary did not answer corami doctor')];
  }

  try {
    return pendingSteps(JSON.parse(result.stdout));
  } catch {
    return [doctorFallback('corami doctor did not answer with JSON')];
  }
}

function doctorFallback(reason: string): PendingStep {
  return {
    id: 'doctor',
    summary: `${reason}: the steps after the update are not known`,
    fix: 'Run corami doctor',
  };
}

async function wantedRelease(requested: string | undefined): Promise<ReleaseInfo> {
  if (requested !== undefined) {
    const tag = requested.startsWith('v') ? requested : `v${requested}`;
    const outcome = await releaseByTag(tag);

    if (outcome.release === undefined) {
      throw new CoramiError({
        code: 'generic',
        message:
          outcome.reason === 'not_found'
            ? `${REPO} has no release tagged ${tag}`
            : `Cannot reach ${REPO}`,
        fix:
          outcome.reason === 'not_found'
            ? 'corami update --check reports the latest version'
            : 'Check the connection, or the repository name in CORAMI_REPO',
      });
    }

    return outcome.release;
  }

  const outcome = await latestRelease();

  if (outcome.release === undefined) {
    throw new CoramiError({
      code: 'generic',
      message:
        outcome.reason === 'no_releases'
          ? `${REPO} has no published release yet`
          : `Cannot reach ${REPO}`,
      fix:
        outcome.reason === 'no_releases'
          ? 'Until the first release, install the binary by hand or from a release branch'
          : 'Check the connection, or the repository name in CORAMI_REPO',
    });
  }

  return outcome.release;
}

export function resolveBinary(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

async function copyToOwner(): Promise<boolean> {
  if (process.platform !== 'linux' || userInfo().username !== 'root') {
    return false;
  }

  const user = await configuredServerUser();

  if (user === undefined) {
    return false;
  }

  const home = await homeDirectoryForUser(user);

  if (home === undefined) {
    return false;
  }

  const target = ownerBinary(home);

  if (!(await Bun.file(target).exists())) {
    return false;
  }

  const temporary = `${target}.new`;
  rmSync(temporary, { force: true });

  if (!(await run('cp', ['-f', resolveBinary(), temporary])).ok) {
    return false;
  }

  if (!(await run('chown', [`${user}:${user}`, temporary])).ok) {
    rmSync(temporary, { force: true });
    return false;
  }

  chmodSync(temporary, 0o755);

  try {
    renameSync(temporary, target);
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }

  return true;
}

async function configuredServerUser(): Promise<string | undefined> {
  return ownerOfServer(await readGlobalConfig().catch(() => undefined));
}

async function restartDaemon(): Promise<boolean> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'server') {
    return false;
  }

  const owner = ownerOfServer(config);

  if (owner !== undefined && owner !== userInfo().username) {
    const home = await homeDirectoryForUser(owner);

    if (home === undefined) {
      return false;
    }

    const uid = await userId(owner);
    const result = await run(
      'runuser',
      [
        '-u',
        owner,
        '--',
        ownerBinary(home),
        'setup',
        'server',
        '--step',
        'daemon',
        '--user',
        owner,
        '--json',
      ],
      {
        cwd: home,
        env: {
          HOME: home,
          ...(uid === undefined ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
        },
        timeoutMs: 2 * 60_000,
      },
    );

    return result.ok;
  }

  const env = { XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}` };
  const active = await run('systemctl', ['--user', 'is-active', 'corami-daemon'], { env });

  if (active.stdout.trim() === 'active') {
    return (await run('systemctl', ['--user', 'restart', 'corami-daemon'], { env })).ok;
  }

  return (await run('systemctl', ['restart', 'corami-daemon'])).ok;
}

interface ServiceRefreshOutcome extends ServiceRefresh {
  name: string;
  fix: string;
}

async function refreshGitWatch(binary: string): Promise<ServiceRefreshOutcome | undefined> {
  const spec = gitWatchSpec(binary);
  const owner = await configuredServerUser();

  if (servicePlatform() !== 'macos' && owner !== undefined && owner !== userInfo().username) {
    const active = await systemctlAsUser(owner, ['is-active', spec.name]);

    if (active.stdout.trim() !== 'active') {
      return undefined;
    }

    const restarted = (await systemctlAsUser(owner, ['restart', spec.name])).ok;

    return {
      name: spec.name,
      ok: restarted,
      detail: restarted ? 'restarted' : 'restart failed',
      fix: 'Run corami setup server --step git-watch as the account that owns the projects',
    };
  }

  return refreshIfInstalled(spec);
}

async function refreshIfInstalled(spec: ServiceSpec): Promise<ServiceRefreshOutcome | undefined> {
  const installed = await serviceInstalled(spec).catch(() => false);

  if (!installed) {
    return undefined;
  }

  const refreshed = await refreshService(spec).catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  }));

  return {
    ...refreshed,
    name: spec.name,
    fix: 'Run corami setup client <server> --step git-watch on a client, or corami setup server --step git-watch on the server',
  };
}

export const updateCommand: CommandSpec = {
  name: 'update',
  summary: 'Updates the binary from the GitHub release',
  usage: 'corami update [--check] [--version vX.Y.Z] [--force]',
  flags: [
    { name: 'check', description: 'Only says whether a newer version exists' },
    { name: 'version', value: 'vX.Y.Z', description: 'Install one exact version' },
    { name: 'force', description: 'Reinstall even the same version' },
  ],
  examples: ['corami update --check', 'corami update'],
  run: run_,
};
