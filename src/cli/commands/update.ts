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
import { gitWatchSpec, restartService, serviceActive } from '@/integrations/service.ts';
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

  // A version asked for is installed as it is, an older one included: it was
  // named on purpose.
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
  const watchRestarted = await restartGitWatch();

  const summary = {
    from: VERSION,
    to: downloaded.version,
    binary,
    account_binary_updated: copiedToOwner,
    restarted_daemon: restarted,
    restarted_git_watch: watchRestarted,
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
      watchRestarted ? 'Git alignment service restarted.' : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  };
}

/**
 * The release to install: the one of `--version` when it is given, the latest
 * otherwise.
 */
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

/**
 * `corami update` replaces the binary it is running from. When the setup ran
 * as root on a server, that is the binary of root: the one of the account runs
 * the services, so it is replaced too, and the services are restarted as the
 * account.
 */
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

  // A plain `cp` over the file of the account leaves it owned by root, and the
  // account could not run it. The copy is written next to it, given back to the
  // account, and only then put in place.
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

/** The account that owns the projects on this server, when one is configured. */
async function configuredServerUser(): Promise<string | undefined> {
  return ownerOfServer(await readGlobalConfig().catch(() => undefined));
}

// The daemon runs as the account that owns the projects: started as root the
// restart goes through `runuser` with the binary of the account, as the setup
// does for its steps. Started as the account itself it restarts its own
// service, because `runuser` may only be used by root.
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

  // The setup falls back to a system unit when the account has no user
  // services, and the daemon runs there: as root this restart works, as the
  // account it does not, and the summary says so instead of claiming a restart
  // that did not happen.
  return (await run('systemctl', ['restart', 'corami-daemon'])).ok;
}

// The git service runs on both roles, so the role is not checked: when the
// service is there it is restarted; when it is not there is nothing to do. As
// root on a server whose projects belong to another account, the service is
// the user unit of that account, and root reaches it through `runuser`.
async function restartGitWatch(): Promise<boolean> {
  const spec = gitWatchSpec(resolveBinary());
  const owner = await configuredServerUser();

  if (owner !== undefined && owner !== userInfo().username) {
    const active = await systemctlAsUser(owner, ['is-active', spec.name]);

    if (active.stdout.trim() !== 'active') {
      return false;
    }

    return (await systemctlAsUser(owner, ['restart', spec.name])).ok;
  }

  const active = await serviceActive(spec).catch(() => false);

  if (!active) {
    return false;
  }

  return restartService(spec).catch(() => false);
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
