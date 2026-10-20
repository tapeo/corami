import type { CommandResult } from '@/cli/command.ts';
import {
  checkServerFolder,
  remoteHome,
  removeStaging,
  transfer,
} from '@/cli/commands/import-remote.ts';
import type { StepResult } from '@/cli/commands/setup-steps.ts';
import { copyPlace, createSyncFor, syncUpdate, waitFirstSync } from '@/cli/commands/sync.ts';
import type { OutputOptions } from '@/cli/output.ts';
import { renderSteps } from '@/cli/output.ts';
import { type ProgressReporter, silentProgress } from '@/cli/progress.ts';
import {
  addProject,
  findProject,
  removeProject,
  serverSupports,
  serverUserForSync,
} from '@/cli/server-client.ts';
import { readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError, type ErrorCode } from '@/core/errors.ts';
import { copyInventory, type InventoryEntry, symlinkPortable } from '@/core/local-copy.ts';
import { importStagingPath, serverPathFrom } from '@/core/project-add.ts';
import { validNewProjectName } from '@/core/projects.ts';
import { sshFailureFix } from '@/core/ssh-policy.ts';
import { conflictFix, conflictLabel } from '@/core/sync-conflicts.ts';
import {
  archivePlan,
  factsMatch,
  localGitFacts,
  manifestDiff,
  manifestOf,
  manifestsMatch,
  remoteGitFacts,
  remoteManifest,
} from '@/core/transfer.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

export interface ImportOptions {
  project: string;
  localPath: string;
  serverPath?: string | undefined;
  user?: string | undefined;
  dryRun: boolean;
  output: OutputOptions;
  progress?: ProgressReporter | undefined;
}

export async function runImport(options: ImportOptions): Promise<CommandResult> {
  const target = options.localPath;
  const config = await readGlobalConfig();
  const host = config?.server_host;
  const progress = options.progress ?? silentProgress;
  const engine = new MutagenEngine();

  if (host === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'This machine is not connected to a server',
      fix: 'Run corami setup client <server> first',
    });
  }

  const user = options.user ?? (await serverUserForSync());
  const projectName = options.project;
  const dryRun = options.dryRun;
  const steps: StepResult[] = [];

  if (!validNewProjectName(projectName)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${projectName}`,
      fix: 'A project name starts with a letter and goes on with letters, digits and dashes: --name chooses another one',
    });
  }

  const facts = await progress.wait('git', 'Reading the local repository', () =>
    localGitFacts(target),
  );

  if (facts === undefined) {
    steps.push({ step: 'git', status: 'failed', summary: `${target} is not a git repository` });
    return finish(options, steps, projectName, target, undefined);
  }

  steps.push({
    step: 'git',
    status: 'done',
    summary: `Local repository: ${facts.refs} refs, ${facts.stashes} stashes, ${facts.dirty} changed files`,
    detail: facts.head.slice(0, 12),
  });

  const known = await progress.wait('name', 'Asking the server', () => findProject(projectName));

  if (known !== undefined) {
    steps.push({
      step: 'name',
      status: 'failed',
      code: 'project_exists',
      summary: `A project named ${projectName} already exists on the server`,
    });
    return finish(options, steps, projectName, target, undefined);
  }

  try {
    await progress.wait('name', 'Checking the copies of this machine', () =>
      copyPlace(engine, projectName, target, true),
    );
  } catch (error) {
    steps.push({
      step: 'name',
      status: 'failed',
      code: error instanceof CoramiError ? error.code : 'usage',
      summary: error instanceof Error ? error.message : String(error),
      detail: error instanceof CoramiError ? error.fix : undefined,
    });
    return finish(options, steps, projectName, target, undefined);
  }

  steps.push({
    step: 'name',
    status: 'done',
    summary: `Name ${projectName} is free on the server`,
  });

  const inventory = await progress.wait('inventory', 'Listing the files', async () =>
    copyInventory(target),
  );
  const localFiles = inventory.localOnly;
  const outside = localFiles.filter((entry) => entry.kind === 'link' && !isPortable(entry)).length;

  steps.push({
    step: 'inventory',
    status: 'done',
    summary:
      localFiles.length === 0
        ? 'Every entry of the folder travels: nothing belongs to this machine alone'
        : `${describeCount(localFiles.length, 'entry', 'entries')} of this machine stay here: the server never carries them${
            outside === 0
              ? ''
              : `, ${describeCount(outside, 'symlink', 'symlinks')} point outside the folder`
          }`,
    detail: localFiles.slice(0, 8).map(describeEntry).join(', '),
  });

  if (dryRun) {
    steps.push({
      step: 'transfer',
      status: 'skipped',
      summary: 'Would copy the repository to the server, and the folder would become its copy',
    });
    return finish(options, steps, projectName, target, options.serverPath);
  }

  const remote = await progress.wait('server', 'Reaching the server', () => remoteHome(user, host));
  const home = remote.home;

  if (home === undefined) {
    steps.push({
      step: 'transfer',
      status: 'failed',
      summary: `Cannot read the home directory of ${user} on the server`,
      detail: sshFailureFix(remote.sshOutput),
    });
    return finish(options, steps, projectName, target, options.serverPath);
  }

  const serverPath =
    options.serverPath === undefined
      ? serverProjectPath(home, projectName)
      : serverPathFrom(home, options.serverPath);

  if (
    !(await progress.wait('server', 'Checking the daemon', () => serverSupports('import_staging')))
  ) {
    steps.push({
      step: 'transfer',
      status: 'failed',
      code: 'capability_missing',
      summary:
        'The daemon of the server is older than this client: it cannot take the folder of an import',
      detail: 'Run corami update on the server, then the command again',
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  const moment = stamp();
  const staging = importStagingPath(serverPath, projectName, moment);

  await progress.wait('server', 'Checking the folder on the server', () =>
    checkServerFolder({
      host,
      user,
      serverPath,
      staging,
      folder: target,
      localHead: facts.head,
    }),
  );

  const archive = archivePlan(target, inventory);
  const transferred = await progress.count('transfer', 'Sending the files', 'bytes', (update) =>
    transfer(target, user, host, staging, archive.entries, (sent) =>
      update({ done: sent, total: archive.bytes }),
    ),
  );

  if (!transferred.ok) {
    const cleanup = await removeStaging(user, host, serverPath, staging);
    steps.push({
      step: 'transfer',
      status: 'failed',
      summary: 'Transfer failed',
      detail: `${transferred.detail}. ${cleanup.detail}`,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({
    step: 'transfer',
    status: 'done',
    summary: `Copied to ${host}:${staging}`,
    detail: transferred.detail,
  });

  const localManifestResult = manifestOf(inventory);
  const remoteManifestResult = await progress.wait('verify', 'Comparing the two copies', () =>
    remoteManifest(host, user, staging),
  );

  if (
    remoteManifestResult === undefined ||
    !manifestsMatch(localManifestResult, remoteManifestResult)
  ) {
    const cleanup = await removeStaging(user, host, serverPath, staging);
    steps.push({
      step: 'verify',
      status: 'failed',
      summary: 'The copies do not match',
      detail:
        remoteManifestResult === undefined
          ? `The server did not answer with the list of its folder. ${cleanup.detail}`
          : `${describeManifest('here', localManifestResult)}, ${describeManifest('on the server', remoteManifestResult)}. ${
              manifestDiff(localManifestResult, remoteManifestResult) ?? ''
            } ${cleanup.detail}`,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  const remoteFacts = await progress.wait('verify', 'Comparing the git history', () =>
    remoteGitFacts(host, user, staging),
  );

  if (remoteFacts === undefined || !factsMatch(facts, remoteFacts)) {
    const cleanup = await removeStaging(user, host, serverPath, staging);
    steps.push({
      step: 'verify',
      status: 'failed',
      summary: 'Git history does not match',
      detail: `local ${facts.refs} refs, remote ${remoteFacts?.refs ?? 0}; local stash ${facts.stashes}, remote ${remoteFacts?.stashes ?? 0}. ${cleanup.detail}`,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({
    step: 'verify',
    status: 'done',
    summary: `Verified: ${localManifestResult.files} files, ${localManifestResult.links} symlinks, ${localManifestResult.dirs} folders, ${facts.refs} refs, ${facts.stashes} stashes, same HEAD`,
  });

  try {
    await progress.wait('register', 'Registering the project', () =>
      addProject({ name: projectName, path: serverPath, owned: true, staging }),
    );
  } catch (error) {
    const cleanup = await removeStaging(user, host, serverPath, staging);

    steps.push({
      step: 'register',
      status: 'failed',
      code: error instanceof CoramiError ? error.code : 'generic',
      summary: `The server did not register the project: ${asMessage(error)}`,
      detail: cleanup.detail,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({
    step: 'register',
    status: 'done',
    summary: `Registered on the server as ${projectName}, in ${serverPath}`,
  });

  let localCopy = target;

  try {
    const sync = await progress.wait('sync', 'Creating the local copy', () =>
      createSyncFor({
        project: projectName,
        localPath: target,
        serverPath,
        user,
        engine,
        importing: true,
      }),
    );
    localCopy = sync.local;
  } catch (error) {
    const taken = await removeProject(projectName).then(
      () => true,
      () => false,
    );

    steps.push({
      step: 'sync',
      status: 'failed',
      code: error instanceof CoramiError ? error.code : 'generic',
      summary: 'The local copy could not be created',
      detail: `${asMessage(error)}. The folder of this machine was never moved nor changed. ${
        taken
          ? 'The project was taken off the server again: nothing is left there without a copy'
          : `The project stays on the server, with no copy. Remove it with corami project rm ${projectName} --on server --yes`
      }`,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({ step: 'sync', status: 'done', summary: `Local copy in ${localCopy}` });

  if (progress.interactive) {
    steps.push(...(await firstSyncSteps(progress, engine, projectName)));
  }

  return finish(options, steps, projectName, target, serverPath);
}

async function firstSyncSteps(
  progress: ProgressReporter,
  engine: MutagenEngine,
  project: string,
): Promise<StepResult[]> {
  const settled = await progress.count(
    'first-sync',
    'Waiting for the first sync',
    'files',
    (update) => waitFirstSync(engine, project, (state) => update(syncUpdate(state))),
  );

  if (settled === undefined) {
    return [
      {
        step: 'first-sync',
        status: 'waiting',
        summary: 'The state of the first sync could not be read: corami sync status shows it',
      },
    ];
  }

  if (settled.state === 'halted') {
    return [
      {
        step: 'first-sync',
        status: 'skipped',
        summary: `The first sync stopped: ${settled.activity}`,
        detail: 'corami sync status shows the session; Ctrl+C leaves it running',
      },
    ];
  }

  const steps: StepResult[] = [
    {
      step: 'first-sync',
      status: 'done',
      summary: `Local copy complete: ${describeCount(settled.files ?? 0, 'file', 'files')}`,
    },
  ];
  const session = await engine.status(project).catch(() => undefined);
  const conflicts = session?.conflicts ?? [];

  if (conflicts.length > 0) {
    steps.push({
      step: 'conflicts',
      status: 'waiting',
      summary: `${describeCount(conflicts.length, 'file changed', 'files changed')} on both sides: both versions are kept`,
      detail: `${conflicts.slice(0, 8).map(conflictLabel).join(', ')}${
        conflicts.length > 8 ? ', ...' : ''
      }. ${conflictFix(project, conflicts)}`,
    });
  }

  return steps;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPortable(entry: InventoryEntry): boolean {
  return symlinkPortable(entry.path, entry.target ?? '');
}

function describeEntry(entry: InventoryEntry): string {
  return entry.kind === 'link' ? `${entry.path} -> ${entry.target ?? ''}` : entry.path;
}

function describeCount(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeManifest(
  side: string,
  manifest: { files: number; links: number; dirs: number },
): string {
  return `${side} ${manifest.files} files, ${manifest.links} symlinks, ${manifest.dirs} folders`;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const FAILED_STEP_CODES: Record<string, ErrorCode> = {
  git: 'usage',
  name: 'usage',
  transfer: 'generic',
  verify: 'generic',
  register: 'generic',
  sync: 'generic',
};

function finish(
  options: ImportOptions,
  steps: StepResult[],
  project: string,
  target: string,
  serverPath: string | undefined,
): CommandResult {
  const failed = steps.find((step) => step.status === 'failed');

  if (failed !== undefined) {
    throw new CoramiError({
      code: failed.code ?? FAILED_STEP_CODES[failed.step] ?? 'generic',
      message: `Import of ${project} stopped at ${failed.step}: ${failed.summary}`,
      fix: failed.detail ?? 'Run the command again',
      details: { project, steps },
    });
  }

  if (options.output.json) {
    return {
      data: {
        project,
        from: 'local',
        server_path: serverPath ?? null,
        local_path: target,
        dry_run: options.dryRun,
        steps,
      },
    };
  }

  return { text: renderSteps(steps).join('\n') };
}
