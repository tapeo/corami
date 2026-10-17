import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { CoramiError, type ErrorCode } from '@/core/errors.ts';
import { directorySize, findLocalOnlyFiles, localGit, rememberRemoval } from '@/core/local-copy.ts';
import { CONFLICT_RESOLUTION } from '@/core/sync-conflicts.ts';
import { MutagenEngine, type SyncSession } from '@/integrations/mutagen.ts';

export interface RemovalCheck {
  step: string;
  status: 'ok' | 'blocked';
  detail: string;
  /** The error code a blocked check answers with. */
  code?: ErrorCode | undefined;
  paths?: string[];
}

export interface RemovalPlan {
  project: string;
  localPath: string;
  session: SyncSession | undefined;
  checks: RemovalCheck[];
  bytes: number;
}

export interface RemovalOptions {
  project: string;
  localPath: string;
  extraIgnore?: string[];
  force?: boolean;
}

/**
 * The engine a removal is planned and applied with. Only the two operations a
 * removal needs: the rest of the sync does not enter it.
 */
export interface RemovalEngine {
  status(project: string): Promise<SyncSession | undefined>;
  flush(project: string): Promise<void>;
  terminate(project: string): Promise<void>;
}

/**
 * Whether the copy of this machine can go, and what it would cost. Every check
 * is decided before anything is touched: the last one to run, `mutagen sync
 * terminate` in `applyRemoval`, is the point of no return for the local files.
 */
export async function planRemoval(
  options: RemovalOptions,
  engine: RemovalEngine = new MutagenEngine(),
): Promise<RemovalPlan> {
  const session = await engine.status(options.project);
  const checks: RemovalCheck[] = [];

  if (session === undefined) {
    checks.push({ step: 'session', status: 'ok', detail: 'no sync session' });
  } else {
    checks.push(...(await checkSync(engine, options.project, session)));
  }

  if (!existsSync(options.localPath)) {
    return { project: options.project, localPath: options.localPath, session, checks, bytes: 0 };
  }

  const localOnly = findLocalOnlyFiles(options.localPath, options.extraIgnore ?? []);

  if (localOnly.length > 0) {
    checks.push({
      step: 'local_only',
      status: 'blocked',
      code: 'local_only_files',
      detail: `${localOnly.length} files exist only here`,
      paths: localOnly.slice(0, 20).map((entry) => entry.path),
    });
  } else {
    checks.push({ step: 'local_only', status: 'ok', detail: 'nothing local-only' });
  }

  const git = await localGit(options.localPath);

  if (git !== undefined && git.onlyLocal > 0) {
    checks.push({
      step: 'local_git',
      status: 'blocked',
      code: 'local_only_files',
      detail: describeLocalGit(git.branch, git.onlyLocal),
    });
  } else {
    checks.push({ step: 'local_git', status: 'ok', detail: 'nothing local git holds alone' });
  }

  return {
    project: options.project,
    localPath: options.localPath,
    session,
    checks,
    bytes: directorySize(options.localPath),
  };
}

/**
 * Flush first, so every local change reaches the server, then read the state:
 * a copy that is not watching has work still on the way, and deleting now
 * deletes it. A missing session is not a failure, Mutagen may have been
 * restarted; anything else is.
 */
async function checkSync(
  engine: RemovalEngine,
  project: string,
  session: SyncSession,
): Promise<RemovalCheck[]> {
  try {
    await engine.flush(project);
  } catch (error) {
    return [
      {
        step: 'sync',
        status: 'blocked',
        code: 'sync_pending',
        detail: `The last changes did not reach the server: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  const refreshed = (await engine.status(project)) ?? session;
  const checks: RemovalCheck[] = [];

  if (refreshed.conflicts.length > 0) {
    const folderGone = refreshed.conflicts.includes('');

    checks.push({
      step: 'conflicts',
      status: 'blocked',
      code: 'sync_conflict',
      detail: folderGone
        ? `${refreshed.conflicts.length} unresolved conflicts, the folder of the project gone on one side`
        : `${refreshed.conflicts.length} unresolved conflicts`,
      paths: refreshed.conflicts.filter((path) => path !== '').slice(0, 20),
    });
  } else {
    checks.push({ step: 'conflicts', status: 'ok', detail: 'no conflicts' });
  }

  if (refreshed.status !== 'watching' || refreshed.lastError !== undefined) {
    checks.push({
      step: 'sync',
      status: 'blocked',
      code: 'sync_pending',
      detail:
        refreshed.lastError ??
        `The session is ${refreshed.status}: the last changes may not have reached the server`,
    });
  } else {
    checks.push({ step: 'sync', status: 'ok', detail: 'sync healthy' });
  }

  return checks;
}

function describeLocalGit(branch: string, onlyLocal: number): string {
  if (onlyLocal === 1) {
    return `1 commit or stash is not on any remote (HEAD on ${branch})`;
  }

  return `${onlyLocal} commits or stashes are not on any remote (HEAD on ${branch})`;
}

export async function applyRemoval(
  plan: RemovalPlan,
  force: boolean,
  engine: RemovalEngine = new MutagenEngine(),
): Promise<{ removed: boolean; freedBytes: number }> {
  const blocked = plan.checks.filter((check) => check.status === 'blocked');
  const first = blocked[0];

  if (blocked.length > 0 && !force) {
    // The folder of the project gone on the server, with the files still here:
    // the copy is all that is left of it, and the session holds a conflict on
    // the folder itself. Deleting is not the only way out, `sync stop` keeps it.
    const folderGone =
      (plan.session?.conflicts.includes('') ?? false) && existsSync(plan.localPath);

    throw new CoramiError({
      code: first?.code ?? 'local_only_files',
      message: `Cannot remove the local copy of ${plan.project}: ${first?.detail ?? ''}`,
      fix: removalFix(plan.project, first?.step, folderGone),
      details: { checks: blocked },
    });
  }

  if (plan.session !== undefined) {
    await engine.terminate(plan.project);
  }

  if (!existsSync(plan.localPath)) {
    return { removed: false, freedBytes: 0 };
  }

  const before = directorySize(plan.localPath);

  try {
    await rm(plan.localPath, { recursive: true, force: true });
  } catch (error) {
    throw new CoramiError({
      code: 'generic',
      message: `Could not delete ${plan.localPath}`,
      fix: error instanceof Error ? error.message : String(error),
    });
  }

  await rememberRemoval({
    project: plan.project,
    localPath: plan.localPath,
    removedAt: new Date().toISOString(),
    freedBytes: before,
  });

  return { removed: true, freedBytes: before };
}

export function removalFix(project: string, step: string | undefined, folderGone = false): string {
  if (step !== 'conflicts') {
    return 'Fix the reported items, or pass --force to remove it anyway';
  }

  if (folderGone) {
    return `The folder of the project is gone on the server: corami sync stop ${project} keeps the files of this copy, corami sync rm ${project} --force removes them`;
  }

  return `See both copies of each conflict with corami sync status ${project}, then ${CONFLICT_RESOLUTION}`;
}
