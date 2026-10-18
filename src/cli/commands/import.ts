import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import type { CommandResult } from '@/cli/command.ts';
import type { StepResult } from '@/cli/commands/setup-steps.ts';
import { copyPlace, createSyncFor } from '@/cli/commands/sync.ts';
import type { OutputOptions } from '@/cli/output.ts';
import { renderSteps } from '@/cli/output.ts';
import {
  addProject,
  findProject,
  listProjects,
  removeProject,
  serverUserForSync,
} from '@/cli/server-client.ts';
import { readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError, type ErrorCode } from '@/core/errors.ts';
import { run, shellQuote } from '@/core/exec.ts';
import { copyInventory, type InventoryEntry, symlinkPortable } from '@/core/local-copy.ts';
import { serverFolderOverlaps, serverPathFrom, serverPathsOf } from '@/core/project-add.ts';
import { isFolderEmpty, validNewProjectName } from '@/core/projects.ts';
import { sshFailureFix } from '@/core/ssh-policy.ts';
import {
  archiveList,
  factsMatch,
  localGitFacts,
  manifestDiff,
  manifestOf,
  manifestsMatch,
  type RemoteHome,
  remoteFolderState,
  remoteGitFacts,
  remoteManifest,
} from '@/core/transfer.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

export interface ImportOptions {
  project: string;
  /** The folder of this machine: it is copied to the server and stays here as the copy. */
  localPath: string;
  /** The folder on the server: absolute, or starting with `~/`. */
  serverPath?: string | undefined;
  /** The account of the server, `--user`: default the one of the configuration. */
  user?: string | undefined;
  dryRun: boolean;
  output: OutputOptions;
}

export async function runImport(options: ImportOptions): Promise<CommandResult> {
  const target = options.localPath;
  const config = await readGlobalConfig();
  const host = config?.server_host;

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

  const facts = await localGitFacts(target);

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

  // The name is asked of the daemon before anything moves, and a daemon that
  // does not answer is an error: its "no" is the only answer that lets an
  // import go on.
  const known = await findProject(projectName);

  if (known !== undefined) {
    steps.push({
      step: 'name',
      status: 'failed',
      code: 'project_exists',
      summary: `A project named ${projectName} already exists on the server`,
    });
    return finish(options, steps, projectName, target, undefined);
  }

  // The folder becomes the copy: the session of the name and the copies of the
  // other projects are checked before anything moves.
  try {
    await copyPlace(new MutagenEngine(), projectName, target, true);
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

  // One walk decides what travels and what stays: the archive and the manifest
  // read the same inventory, so they cannot count different things.
  const inventory = copyInventory(target);
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
      summary: 'Would copy the repository to the server',
    });
    return finish(options, steps, projectName, target, options.serverPath);
  }

  const remote = await remoteHome(user, host);
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

  // The folder of the import is one Corami makes: a folder that is already
  // there is never written into, and never removed. The check runs before the
  // transfer, so a refusal leaves the server as it was.
  await checkServerFolder(host, user, serverPath);

  const transferred = await transfer(
    target,
    user,
    host,
    serverPath,
    archiveList(target, inventory),
  );

  if (!transferred.ok) {
    steps.push({
      step: 'transfer',
      status: 'failed',
      summary: 'Transfer failed',
      detail: transferred.detail,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({
    step: 'transfer',
    status: 'done',
    summary: `Copied to ${host}:${serverPath}`,
    detail: transferred.detail,
  });

  const localManifestResult = manifestOf(inventory);
  const remoteManifestResult = await remoteManifest(host, user, serverPath);

  if (
    remoteManifestResult === undefined ||
    !manifestsMatch(localManifestResult, remoteManifestResult)
  ) {
    const cleanup = await cleanupServerFolder(user, host, serverPath);
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

  const remoteFacts = await remoteGitFacts(host, user, serverPath);

  if (remoteFacts === undefined || !factsMatch(facts, remoteFacts)) {
    const cleanup = await cleanupServerFolder(user, host, serverPath);
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
    await addProject({ name: projectName, path: serverPath, owned: true });
  } catch (error) {
    // The folder was copied here by this command: a registration that fails
    // takes it away again, and this machine keeps everything.
    const cleanup = await cleanupServerFolder(user, host, serverPath);

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
    summary: `Registered on the server as ${projectName}`,
  });

  const backup = `${target}.corami-backup-${stamp()}`;

  try {
    renameSync(target, backup);
  } catch (error) {
    // The folder did not move: the project it just registered has no copy
    // here, and the one thing the command never leaves behind is a project
    // without its copy.
    const taken = await removeProject(projectName).then(
      () => true,
      () => false,
    );

    steps.push({
      step: 'local',
      status: 'failed',
      summary: `The folder of this machine could not move: ${asMessage(error)}`,
      detail: taken
        ? 'The project was taken off the server again: nothing is left there without a copy'
        : `The project stays on the server, with no copy. Remove it with corami project rm ${projectName} --on server --yes`,
    });
    return finish(options, steps, projectName, target, serverPath);
  }

  steps.push({ step: 'local', status: 'done', summary: `Local folder moved to ${backup}` });

  let localCopy = target;

  try {
    const sync = await createSyncFor({ project: projectName, localPath: target, serverPath, user });
    localCopy = sync.local;
  } catch (error) {
    // The project is on the server without its copy, the one thing the
    // command never leaves behind.
    const taken = await removeProject(projectName).then(
      () => true,
      () => false,
    );
    // With the project gone, the folder of this machine goes back where it
    // was, so the command can be run again as it was.
    const restored = taken && restoreBackup(backup, target);

    steps.push({
      step: 'sync',
      status: 'failed',
      code: error instanceof CoramiError ? error.code : 'generic',
      summary: 'The local copy could not be created',
      detail: `${asMessage(error)}. ${
        taken
          ? `The project was taken off the server again: nothing is left there without a copy. ${
              restored
                ? `The folder of this machine is back at ${target}`
                : `The folder of this machine stays at ${backup}`
            }`
          : 'The project stays on the server, with no copy'
      }`,
    });
    return finish(options, steps, projectName, target, serverPath);
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

  return finish(options, steps, projectName, target, serverPath);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a folder of the server the import does not make: one that is already
 * there with something in it, one that overlaps another project, and one the
 * check cannot read. The command writes only into a folder it creates.
 */
async function checkServerFolder(host: string, user: string, serverPath: string): Promise<void> {
  const projects = await listProjects().catch((error: unknown) => {
    throw new CoramiError({
      code: 'server_unreachable',
      message: `Cannot read the projects of the server: ${asMessage(error)}`,
      fix: 'Check that the daemon answers, then run the command again',
    });
  });
  const others = serverPathsOf(projects);

  if (serverFolderOverlaps(serverPath, others)) {
    const other = overlappingProject(serverPath, projects);

    throw new CoramiError({
      code: 'usage',
      message:
        other === undefined
          ? `The folder ${serverPath} overlaps another project of the server`
          : `The folder ${serverPath} is inside the project at ${other}, or around it`,
      fix: 'Name a free folder of the server: corami project add <folder> --server-path <folder>',
    });
  }

  const state = await remoteFolderState(host, user, serverPath);

  if (state === undefined) {
    throw new CoramiError({
      code: 'server_unreachable',
      message: `Cannot read the folder of the server: ${serverPath}`,
      fix: 'Check that ssh works for the account, then run the command again',
    });
  }

  if (state === 'taken') {
    throw new CoramiError({
      code: 'usage',
      message: `The folder ${serverPath} is already on the server and is not empty`,
      fix: 'Name a free folder of the server with --server-path: the import writes only into a folder it makes',
    });
  }
}

function overlappingProject(
  serverPath: string,
  projects: Array<{ name: string; path: string }>,
): string | undefined {
  return projects.find((entry) => serverFolderOverlaps(serverPath, [entry.path]))?.name;
}

/**
 * Takes the folder away again, with what it holds: only for a folder this
 * import made, which the check before the transfer guaranteed. The result says
 * whether it is gone, so the step can say where the project stayed instead.
 */
async function cleanupServerFolder(
  user: string,
  host: string,
  serverPath: string,
): Promise<{ removed: boolean; detail: string }> {
  const result = await run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      `${user}@${host}`,
      `rm -rf ${shellQuote(serverPath)}`,
    ],
    { timeoutMs: 60_000 },
  );

  return result.ok
    ? { removed: true, detail: `The folder ${serverPath} was removed from the server` }
    : {
        removed: false,
        detail: `The folder stays at ${host}:${serverPath}: ${
          (result.stderr || result.stdout).trim() || `ssh exited with ${result.exitCode}`
        }`,
      };
}

/**
 * Puts the folder of this machine back where it was, from the backup the
 * import moved it to. Only an empty or absent folder is taken over: anything
 * else is work the sync may already have brought.
 */
function restoreBackup(backup: string, target: string): boolean {
  if (existsSync(target)) {
    if (!isFolderEmpty(target)) {
      return false;
    }

    try {
      rmdirSync(target);
    } catch {
      return false;
    }
  }

  try {
    renameSync(backup, target);
    return true;
  } catch {
    return false;
  }
}

export async function remoteHome(user: string, host: string): Promise<RemoteHome> {
  const result = await run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, 'printf %s "$HOME"'],
    {
      timeoutMs: 60_000,
    },
  );

  const home = result.stdout.trim();
  const sshOutput = `${result.stderr}\n${result.stdout}`;

  if (result.ok && home.startsWith('/')) {
    return { home, sshOutput };
  }

  return { home: undefined, sshOutput };
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
  entries: string[],
): Promise<{ ok: boolean; detail: string }> {
  const remote = remoteExtractCommand(serverPath);
  // The list decides what the archive holds: `tar` follows no folder and
  // matches no pattern, so a link is carried as a link and nothing the
  // inventory left out can slip in.
  const reader = Bun.spawn(
    ['tar', '-czf', '-', '-C', source, '--null', '--no-recursion', '-T', '-'],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  reader.stdin.write(`${entries.join('\0')}\0`);
  await reader.stdin.end();

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
export function restoreLocalFiles(backup: string, target: string, files: InventoryEntry[]): number {
  let restored = 0;

  for (const file of files) {
    const from = join(backup, file.path);
    const to = join(target, file.path);

    if (!existsSync(from) && file.kind !== 'link') {
      continue;
    }

    mkdirSync(join(to, '..'), { recursive: true });

    if (file.kind === 'link') {
      // The target goes back as it was written: resolving it would turn a link
      // of this machine into a file of another.
      const link = readlinkSync(from);

      if (existsSync(to)) {
        // A folder on the server at the same path is real content: the link of
        // this machine does not replace it.
        if (lstatSync(to).isDirectory()) {
          continue;
        }

        rmSync(to, { force: true });
      }

      symlinkSync(link, to);
      restored += 1;
      continue;
    }

    cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true });
    restored += 1;
  }

  return restored;
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

  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** The error code of a step that failed before any call to the daemon. */
const FAILED_STEP_CODES: Record<string, ErrorCode> = {
  git: 'usage',
  name: 'usage',
  transfer: 'generic',
  verify: 'generic',
  register: 'generic',
  sync: 'generic',
};

/**
 * The result of an import: the steps, as the envelope of a run that went
 * through. A step that failed is an error: `corami project add` either leaves
 * the project on the server with its copy here, or it fails. The steps are
 * what the caller reads to know where it stopped.
 */
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
