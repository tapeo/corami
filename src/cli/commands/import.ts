import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { CommandContext } from '@/cli/command.ts';
import type { StepResult } from '@/cli/commands/setup-steps.ts';
import { createSyncFor } from '@/cli/commands/sync.ts';
import { renderNextSteps, renderSteps } from '@/cli/output.ts';
import { booleanFlag, stringFlag, stringListFlag } from '@/cli/parser.ts';
import { addProject, projectDetail, serverUserForSync } from '@/cli/server-client.ts';
import { homeDirectory, readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import { findLocalOnlyFiles, isSensitiveName } from '@/core/local-copy.ts';
import { afterImport } from '@/core/next-steps.ts';
import {
  factsMatch,
  localGitFacts,
  localManifest,
  manifestsMatch,
  remoteGitFacts,
  remoteManifest,
  shellQuote,
  TAR_EXCLUDES,
} from '@/core/transfer.ts';

export async function runImport(
  context: CommandContext,
): Promise<{ data?: unknown; text?: string }> {
  const target = resolve(context.args.positionals[0] ?? process.cwd());
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
  const extraIncludes = stringListFlag(context.args, 'include');
  const steps: StepResult[] = [];

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

  steps.push({
    step: 'name',
    status: 'done',
    summary: `Name ${projectName} is free on the server`,
  });

  const ignored = findLocalOnlyFiles(
    target,
    extraIncludes.filter((entry) => !isSensitiveName(entry)),
  );
  const envFiles = ignored.filter((entry) => isEnvPath(entry.path));
  const secretFiles = ignored.filter(
    (entry) => !isEnvPath(entry.path) && isSensitiveName(entry.path),
  );

  steps.push({
    step: 'inventory',
    status: 'done',
    summary: `${ignored.length} files not tracked by git: ${envFiles.length} env, ${secretFiles.length} look like secrets`,
    detail: [...envFiles, ...secretFiles]
      .slice(0, 8)
      .map((entry) => entry.path)
      .join(', '),
  });

  if (secretFiles.length > 0) {
    steps.push({
      step: 'keys',
      status: 'skipped',
      summary: `${secretFiles.length} files that look like keys: they stay on this machine`,
      detail: secretFiles.map((entry) => entry.path).join(', '),
    });
  }

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
  const transferred = await transfer(
    target,
    user,
    host,
    serverPath,
    secretFiles.map((entry) => entry.path),
  );

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

  const localManifestResult = localManifest(target, [
    ...TAR_EXCLUDES,
    ...secretFiles.map((entry) => `./${entry.path}`),
  ]);
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

  mkdirSync(join(homeDirectory(), 'corami'), { recursive: true });

  let localCopy = target;

  try {
    const sync = await createSyncFor({ project: projectName, localPath: target, serverPath, user });
    localCopy = sync.local;

    if (!sync.created && resolve(sync.local) !== resolve(target)) {
      steps.push({
        step: 'sync',
        status: 'skipped',
        summary: `A sync session for ${projectName} already exists at ${sync.local}`,
        detail: `The import keeps working in ${target}. For a copy in another place: corami sync rm ${projectName}, then corami sync add ${projectName} --path ${target}`,
      });
    }
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

  const restored = await restoreEnvFiles(backup, localCopy, envFiles);

  if (restored > 0) {
    steps.push({
      step: 'env',
      status: 'done',
      summary: `${restored} env files copied back into the new copy`,
    });
  }

  if (secretFiles.length > 0) {
    steps.push({
      step: 'keys',
      status: 'skipped',
      summary: `${secretFiles.length} key files stay only in ${backup}`,
    });
  }

  return finish(context, steps, projectName, target, dryRun, serverPath);
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

export function isEnvPath(path: string): boolean {
  const name = path.split('/').at(-1) ?? path;
  return name === '.env' || name.startsWith('.env.');
}

async function transfer(
  source: string,
  user: string,
  host: string,
  serverPath: string,
  excludeFiles: string[],
): Promise<{ ok: boolean; detail: string }> {
  const extra = excludeFiles.map((path) => `./${path}`);
  const excludes = [...TAR_EXCLUDES, '._*', ...extra].flatMap((path) => [`--exclude=${path}`]);
  const remote = `mkdir -p ${shellQuote(serverPath)} && tar -xzf - --no-same-owner -C ${shellQuote(serverPath)}`;
  const command = [
    'tar',
    '-czf',
    '-',
    ...excludes,
    '-C',
    shellQuote(source),
    '.',
    '|',
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    shellQuote(`${user}@${host}`),
    shellQuote(remote),
  ].join(' ');

  const result = await run('sh', ['-c', command], {
    timeoutMs: 1_800_000,
    env: { COPYFILE_DISABLE: '1' },
  });

  if (!result.ok) {
    return { ok: false, detail: result.stderr.trim().split('\n').slice(-2).join(' ') };
  }

  const noise = /^tar: (Ignoring unknown extended header keyword|Removing leading)/;

  return {
    ok: true,
    detail: result.stderr
      .split('\n')
      .filter((line) => line.trim() !== '' && !noise.test(line.trim()))
      .slice(0, 3)
      .join(' '),
  };
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

async function restoreEnvFiles(
  backup: string,
  target: string,
  files: Array<{ path: string }>,
): Promise<number> {
  let restored = 0;

  for (const file of files) {
    const from = join(backup, file.path);
    const to = join(target, file.path);

    if (!(await Bun.file(from).exists())) {
      continue;
    }

    mkdirSync(join(to, '..'), { recursive: true });
    await Bun.write(to, Bun.file(from));
    await run('chmod', ['600', to]);
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
  serverPath?: string,
): { data?: unknown; text?: string } {
  if (context.output.json) {
    return { data: { project, local: target, dry_run: dryRun, steps } };
  }

  const lines = renderSteps(steps);

  const failed = steps.some((step) => step.status === 'failed');

  if (!failed && !dryRun) {
    lines.push(...renderNextSteps(afterImport(project, serverPath)));
  }

  return { text: lines.join('\n') };
}
