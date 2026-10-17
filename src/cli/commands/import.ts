import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { CommandContext } from '@/cli/command.ts';
import type { StepResult } from '@/cli/commands/setup-steps.ts';
import { copyPlace, createSyncFor, givenPath } from '@/cli/commands/sync.ts';
import { renderSteps } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import { addProject, projectDetail, serverUserForSync } from '@/cli/server-client.ts';
import { readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run, shellQuote } from '@/core/exec.ts';
import { findLocalOnlyFiles, type LocalOnlyFile } from '@/core/local-copy.ts';
import { validProjectName } from '@/core/projects.ts';
import {
  factsMatch,
  localGitFacts,
  localManifest,
  manifestsMatch,
  remoteGitFacts,
  remoteManifest,
  tarExcludeArgs,
} from '@/core/transfer.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

export async function runImport(
  context: CommandContext,
): Promise<{ data?: unknown; text?: string }> {
  const folder = context.args.positionals[0];

  if (folder === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing folder',
      fix: 'corami project import <folder>, or corami project import . for the current one',
    });
  }

  const target = givenPath(folder);
  const config = await readGlobalConfig();
  const host = config?.server_host;

  if (host === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'This machine is not connected to a server',
      fix: 'Run corami setup client <server> first',
    });
  }

  const user = stringFlag(context.args, 'user') ?? (await serverUserForSync());
  const projectName = stringFlag(context.args, 'name') ?? basename(target);
  const dryRun = booleanFlag(context.args, 'dry-run');
  const steps: StepResult[] = [];

  if (!validProjectName(projectName)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${projectName}`,
      fix: 'A project name is letters, digits, dot, dash and underscore: --name chooses another one',
    });
  }

  const facts = await localGitFacts(target);

  if (facts === undefined) {
    steps.push({ step: 'git', status: 'failed', summary: `${target} is not a git repository` });
    return finish(context, steps, projectName, target, dryRun);
  }

  steps.push({
    step: 'git',
    status: 'done',
    summary: `Local repository: ${facts.refs} refs, ${facts.stashes} stashes, ${facts.dirty} changed files`,
    detail: facts.head.slice(0, 12),
  });

  const known = await projectDetail(projectName).catch(() => undefined);

  if (known !== undefined) {
    steps.push({
      step: 'name',
      status: 'failed',
      summary: `A project named ${projectName} already exists on the server`,
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  // The folder becomes the copy: the session of the name and the copies of the
  // other projects are checked before anything moves.
  try {
    await copyPlace(new MutagenEngine(), projectName, target, true);
  } catch (error) {
    steps.push({
      step: 'name',
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
      detail: error instanceof CoramiError ? error.fix : undefined,
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  steps.push({
    step: 'name',
    status: 'done',
    summary: `Name ${projectName} is free on the server`,
  });

  // The files the sync never carries are the ones of this machine: they are
  // not in the archive either, and they are copied back into the new folder
  // after the import.
  const localFiles = findLocalOnlyFiles(target);

  steps.push({
    step: 'inventory',
    status: 'done',
    summary:
      localFiles.length === 0
        ? 'Every file of the folder travels: nothing belongs to this machine alone'
        : `${localFiles.length} files of this machine stay here: the server never carries them`,
    detail: localFiles
      .slice(0, 8)
      .map((entry) => entry.path)
      .join(', '),
  });

  if (dryRun) {
    steps.push({
      step: 'transfer',
      status: 'skipped',
      summary: 'Would copy the repository to the server',
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  const home = await remoteHome(user, host);

  if (home === undefined) {
    steps.push({
      step: 'transfer',
      status: 'failed',
      summary: `Cannot read the home directory of ${user} on the server`,
      detail: 'Check that ssh works, and that the account owns the projects',
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  const serverPath = serverProjectPath(home, projectName);
  const transferred = await transfer(target, user, host, serverPath);

  if (!transferred.ok) {
    steps.push({
      step: 'transfer',
      status: 'failed',
      summary: 'Transfer failed',
      detail: transferred.detail,
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  steps.push({
    step: 'transfer',
    status: 'done',
    summary: `Copied to ${host}:${serverPath}`,
    detail: transferred.detail,
  });

  const localManifestResult = localManifest(target);
  const remoteManifestResult = await remoteManifest(host, user, serverPath);

  if (
    remoteManifestResult === undefined ||
    !manifestsMatch(localManifestResult, remoteManifestResult)
  ) {
    steps.push({
      step: 'verify',
      status: 'failed',
      summary: 'The copies do not match',
      detail: `local ${localManifestResult.files} files, remote ${remoteManifestResult?.files ?? 0}`,
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  const remoteFacts = await remoteGitFacts(host, user, serverPath);

  if (remoteFacts === undefined || !factsMatch(facts, remoteFacts)) {
    steps.push({
      step: 'verify',
      status: 'failed',
      summary: 'Git history does not match',
      detail: `local ${facts.refs} refs, remote ${remoteFacts?.refs ?? 0}; local stash ${facts.stashes}, remote ${remoteFacts?.stashes ?? 0}`,
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  steps.push({
    step: 'verify',
    status: 'done',
    summary: `Verified: ${localManifestResult.files} files, ${facts.refs} refs, ${facts.stashes} stashes, same HEAD`,
  });

  await addProject({ name: projectName, path: serverPath });
  steps.push({
    step: 'register',
    status: 'done',
    summary: `Registered on the server as ${projectName}`,
  });

  const backup = `${target}.corami-backup-${stamp()}`;
  renameSync(target, backup);
  steps.push({ step: 'local', status: 'done', summary: `Local folder moved to ${backup}` });

  let localCopy = target;

  try {
    const sync = await createSyncFor({ project: projectName, localPath: target, serverPath, user });
    localCopy = sync.local;
  } catch (error) {
    steps.push({
      step: 'sync',
      status: 'failed',
      summary: 'The local copy could not be created',
      detail: error instanceof Error ? error.message : String(error),
    });
    return finish(context, steps, projectName, target, dryRun);
  }

  steps.push({ step: 'sync', status: 'done', summary: `Local copy created in ${localCopy}` });

  if (await restoreGitDirectory(backup, localCopy)) {
    steps.push({
      step: 'git',
      status: 'done',
      summary: 'Git directory restored in the local copy, separate from the server',
    });
  }

  const restored = restoreLocalFiles(backup, localCopy, localFiles);

  if (restored > 0) {
    steps.push({
      step: 'local',
      status: 'done',
      summary: `${restored} files of this machine copied back into the new copy`,
    });
  }

  return finish(context, steps, projectName, target, dryRun);
}

export async function remoteHome(user: string, host: string): Promise<string | undefined> {
  const result = await run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, 'printf %s "$HOME"'],
    {
      timeoutMs: 60_000,
    },
  );

  const home = result.stdout.trim();
  return result.ok && home.startsWith('/') ? home : undefined;
}

/**
 * The command the server runs to receive the archive: unpack it into the
 * folder of the project. The sync never carries the paths of one machine, and
 * the archive leaves them out too, so there is nothing to protect here.
 */
export function remoteExtractCommand(serverPath: string): string {
  return `mkdir -p ${shellQuote(serverPath)} && tar -xzf - --no-same-owner -C ${shellQuote(serverPath)}`;
}

/**
 * The archive reaches the server through a pipe: `tar` writes it, `ssh` carries
 * it. Both are started with their arguments, never through a shell, and both
 * exit codes are checked: a failure of `tar` would otherwise show as the exit
 * code of `ssh` alone.
 */
async function transfer(
  source: string,
  user: string,
  host: string,
  serverPath: string,
): Promise<{ ok: boolean; detail: string }> {
  const remote = remoteExtractCommand(serverPath);
  const reader = Bun.spawn(['tar', '-czf', '-', ...tarExcludeArgs(), '-C', source, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const writer = Bun.spawn(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, remote],
    {
      stdin: reader.stdout,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const timeout = setTimeout(() => {
    reader.kill();
    writer.kill();
  }, 1_800_000);

  try {
    const [read, written] = await Promise.all([
      reader.exited.then(async (code) => ({
        code,
        noise: await new Response(reader.stderr).text(),
      })),
      writer.exited.then(async (code) => ({
        code,
        error: await new Response(writer.stderr).text(),
      })),
    ]);

    if (read.code !== 0 || written.code !== 0) {
      const detail = cleanTarNoise(written.code !== 0 ? written.error : read.noise);

      return {
        ok: false,
        detail: detail === '' ? `tar exited with ${read.code}, ssh with ${written.code}` : detail,
      };
    }

    return { ok: true, detail: cleanTarNoise(written.error) };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanTarNoise(raw: string): string {
  const noise = /^tar: (Ignoring unknown extended header keyword|Removing leading)/;

  return raw
    .split('\n')
    .filter((line) => line.trim() !== '' && !noise.test(line.trim()))
    .slice(0, 3)
    .join(' ');
}

async function restoreGitDirectory(backup: string, target: string): Promise<boolean> {
  const source = join(backup, '.git');

  if (!existsSync(source)) {
    return false;
  }

  mkdirSync(target, { recursive: true });
  const copied = await run('cp', ['-R', source, join(target, '.git')]);
  return copied.ok;
}

/**
 * Puts back into the new copy what the server never carries: the files of this
 * machine, which are the ones the backup kept and the sync would not bring.
 */
function restoreLocalFiles(backup: string, target: string, files: LocalOnlyFile[]): number {
  let restored = 0;

  for (const file of files) {
    const from = join(backup, file.path);
    const to = join(target, file.path);

    if (!existsSync(from)) {
      continue;
    }

    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
    restored += 1;
  }

  return restored;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function finish(
  context: CommandContext,
  steps: StepResult[],
  project: string,
  target: string,
  dryRun: boolean,
): { data?: unknown; text?: string } {
  if (context.output.json) {
    return { data: { project, local: target, dry_run: dryRun, steps } };
  }

  return { text: renderSteps(steps).join('\n') };
}
