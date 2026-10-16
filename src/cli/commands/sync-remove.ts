import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { homeDirectory } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { directorySize, findLocalOnlyFiles, localGit, rememberRemoval } from '@/core/local-copy.ts';
import { CONFLICT_RESOLUTION } from '@/core/sync-conflicts.ts';
import { MutagenEngine, type SyncSession } from '@/integrations/mutagen.ts';

export interface RemovalCheck {
  step: string;
  status: 'ok' | 'blocked';
  detail: string;
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

export async function planRemoval(options: RemovalOptions): Promise<RemovalPlan> {
  const engine = new MutagenEngine();
  const session = await engine.status(options.project);
  const checks: RemovalCheck[] = [];

  if (session === undefined) {
    checks.push({ step: 'session', status: 'ok', detail: 'no sync session' });
  } else {
    await engine.flush(options.project).catch(() => undefined);
    const refreshed = (await engine.status(options.project)) ?? session;

    if (refreshed.conflicts.length > 0) {
      checks.push({
        step: 'conflicts',
        status: 'blocked',
        detail: `${refreshed.conflicts.length} unresolved conflicts`,
        paths: refreshed.conflicts.slice(0, 20),
      });
    } else {
      checks.push({ step: 'conflicts', status: 'ok', detail: 'no conflicts' });
    }

    if (refreshed.lastError !== undefined) {
      checks.push({ step: 'sync', status: 'blocked', detail: refreshed.lastError });
    } else {
      checks.push({ step: 'sync', status: 'ok', detail: 'sync healthy' });
    }
  }

  if (!existsSync(options.localPath)) {
    return { project: options.project, localPath: options.localPath, session, checks, bytes: 0 };
  }

  const localOnly = findLocalOnlyFiles(options.localPath, options.extraIgnore ?? []);

  if (localOnly.length > 0) {
    checks.push({
      step: 'local_only',
      status: 'blocked',
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

function describeLocalGit(branch: string, onlyLocal: number): string {
  if (onlyLocal === 1) {
    return `1 commit or stash is not on any remote (HEAD on ${branch})`;
  }

  return `${onlyLocal} commits or stashes are not on any remote (HEAD on ${branch})`;
}

export async function applyRemoval(
  plan: RemovalPlan,
  force: boolean,
): Promise<{ removed: boolean; freedBytes: number }> {
  const blocked = plan.checks.filter((check) => check.status === 'blocked');

  if (blocked.length > 0 && !force) {
    throw new CoramiError({
      code: blocked[0]?.step === 'conflicts' ? 'sync_conflict' : 'local_only_files',
      message: `Cannot remove the local copy of ${plan.project}: ${blocked[0]?.detail ?? ''}`,
      fix: removalFix(plan.project, blocked[0]?.step),
      details: { checks: blocked },
    });
  }

  const engine = new MutagenEngine();

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

export function removalFix(project: string, step: string | undefined): string {
  if (step === 'conflicts') {
    return `See both copies of each conflict with corami sync status ${project}, then ${CONFLICT_RESOLUTION}`;
  }

  return 'Fix the reported items, or pass --force to remove it anyway';
}

export function defaultLocalPath(project: string): string {
  return join(homeDirectory(), 'corami', project);
}

export function resolveLocalPath(project: string, explicit?: string): string {
  return explicit === undefined ? defaultLocalPath(project) : resolve(explicit);
}
