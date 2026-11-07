import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from '@/cli/command.ts';
import {
  publishPeerHead,
  requireClient,
  syncSessions,
  waitFirstSync,
} from '@/cli/commands/sync-session.ts';
import { booleanFlag, type ParsedArgs } from '@/cli/parser.ts';
import { progressFor } from '@/cli/progress.ts';
import { CoramiError, type ErrorCode, toCoramiError } from '@/core/errors.ts';
import {
  type AdoptResult,
  adoptIgnores,
  IGNORE_FILE,
  ignoresFor,
  keptIgnores,
  type RefreshMode,
  refreshDecision,
  refreshPlan,
  unrepresentedIgnores,
} from '@/core/ignore-file.ts';
import { MutagenEngine, pollingCurrent, type SyncSession } from '@/integrations/mutagen.ts';

export type SessionOutcome = 'current' | 'refreshed' | 'refused' | 'failed';

export interface SessionRefresh {
  project: string;
  outcome: SessionOutcome;
  code?: ErrorCode;
  message?: string;
  fix?: string;
  flushed?: boolean;
  pending?: boolean;
  status?: string;
  conflicts?: string[];
  ignores?: string[];
  adopted?: string[];
  sessionOnly?: string[];
}

export function refreshMode(args: ParsedArgs): RefreshMode {
  const force = booleanFlag(args, 'force');
  const keep = booleanFlag(args, 'keep-extra');

  if (force && keep) {
    throw new CoramiError({
      code: 'usage',
      message: '--force and --keep-extra say opposite things',
      fix: 'Use --keep-extra to add the current exclusions and keep the old ones, or --force to drop the old ones',
    });
  }

  if (force) {
    return 'force';
  }

  if (keep) {
    return 'keep-extra';
  }

  return 'plain';
}

export function refreshTarget(args: ParsedArgs): 'all' | 'one' {
  if (!booleanFlag(args, 'all')) {
    return 'one';
  }

  if (args.positionals.length > 0) {
    throw new CoramiError({
      code: 'usage',
      message: '--all refreshes every session: it takes no project',
      fix: 'Run corami sync refresh --all',
    });
  }

  return 'all';
}

export async function refreshSession(
  engine: MutagenEngine,
  session: SyncSession,
  mode: RefreshMode,
): Promise<SessionRefresh> {
  const project = session.project;

  if (session.serverHost === '' || session.serverPath === '') {
    return {
      project,
      outcome: 'failed',
      code: 'config_invalid',
      message: `The session of ${project} does not say where the project is on the server`,
      fix: `Run corami sync status ${project} and check the alpha endpoint`,
    };
  }

  const current = ignoresFor(session.beta);
  const kept =
    mode === 'keep-extra'
      ? unrepresentedIgnores(keptIgnores(current, session.ignore), current)
      : [];
  const adoption = kept.length === 0 ? undefined : writeKeptIgnores(session.beta, kept);
  const ignores = ignoresFor(session.beta);
  const plan = refreshPlan(session.ignore, ignores, mode === 'force');
  const decision = refreshDecision(plan, pollingCurrent(session), mode);
  const adopted = adoptionLines(adoption);

  if (decision === 'refused') {
    return {
      project,
      outcome: 'refused',
      code: 'usage',
      message: `The session of ${project} leaves out ${plan.extra.join(', ')}, which this Corami would carry`,
      fix: `Run corami sync refresh ${project} --keep-extra to add the current exclusions and keep the ones the session already has, or --force only if those files may reach the server`,
      ...adopted,
    };
  }

  if (decision === 'current') {
    return { project, outcome: 'current', ignores, ...adopted };
  }

  const finalIgnores = [...ignores, ...(adoption?.sessionOnly ?? [])];
  let flushed = true;

  try {
    await engine.flush(project);
  } catch {
    flushed = false;
  }

  await engine.terminate(project);
  await publishPeerHead(session.beta);
  await engine.create({
    project,
    serverHost: session.serverHost,
    serverUser: session.serverUser,
    serverPath: session.serverPath,
    localPath: session.beta,
    ignore: finalIgnores,
  });

  const progress = await waitFirstSync(engine, project, () => undefined, 120_000);
  const after = await engine.status(project);
  const conflicts = after?.conflicts ?? [];

  return {
    project,
    outcome: 'refreshed',
    flushed,
    pending: progress?.state === 'waiting',
    status: after?.status ?? 'unknown',
    conflicts,
    ignores: finalIgnores,
    ...adopted,
  };
}

export async function refreshAll(
  context: CommandContext,
  mode: RefreshMode,
): Promise<CommandResult> {
  await requireClient('refresh');
  const engine = new MutagenEngine();
  const sessions = await syncSessions(engine);
  const progress = progressFor(context.output);
  const results: SessionRefresh[] = [];

  for (const session of sessions) {
    const result = await progress.wait(session.project, 'Recreating the sync session', () =>
      refreshSession(engine, session, mode).catch((error: unknown) =>
        failedRefresh(session.project, error),
      ),
    );

    results.push(result);
  }

  if (context.output.json) {
    return { data: { results: results.map(refreshData), counts: refreshCounts(results) } };
  }

  return { text: refreshAllText(results) };
}

export function failedRefresh(project: string, error: unknown): SessionRefresh {
  const failure = toCoramiError(error);

  return {
    project,
    outcome: 'failed',
    code: failure.code,
    message: failure.message,
    ...(failure.fix === undefined ? {} : { fix: failure.fix }),
  };
}

export function refreshCounts(results: SessionRefresh[]): Record<SessionOutcome, number> {
  const counts: Record<SessionOutcome, number> = {
    current: 0,
    refreshed: 0,
    refused: 0,
    failed: 0,
  };

  for (const result of results) {
    counts[result.outcome] += 1;
  }

  return counts;
}

export function refreshAllText(results: SessionRefresh[]): string {
  if (results.length === 0) {
    return 'No sync session on this machine.';
  }

  const counts = refreshCounts(results);
  const lines = results.flatMap(describeRefresh);

  lines.push(
    '',
    `${counts.refreshed} refreshed, ${counts.current} already current, ${counts.refused} refused, ${counts.failed} failed.`,
  );

  return lines.join('\n');
}

export function describeRefresh(result: SessionRefresh): string[] {
  const lines: string[] = [];

  if (result.outcome === 'current') {
    lines.push(`${result.project}: already current`);
  } else if (result.outcome === 'refreshed') {
    const conflicts = result.conflicts?.length ?? 0;
    lines.push(
      `${result.project}: recreated, ${result.status ?? 'unknown'}, conflicts: ${conflicts}`,
    );
  } else {
    const label = result.outcome === 'refused' ? 'refused' : 'failed';
    lines.push(`${result.project}: ${label}, ${result.message ?? 'no reason given'}`);

    if (result.fix !== undefined) {
      lines.push(`  ${result.fix}`);
    }
  }

  lines.push(...adoptionText(result.adopted, result.sessionOnly));

  return lines;
}

export function adoptionText(
  adopted: string[] | undefined,
  sessionOnly: string[] | undefined,
): string[] {
  const lines: string[] = [];

  if (adopted !== undefined && adopted.length > 0) {
    lines.push(`  kept exclusions written to ${IGNORE_FILE}: ${adopted.join(', ')}`);
  }

  if (sessionOnly !== undefined && sessionOnly.length > 0) {
    lines.push(`  kept in the session only: ${sessionOnly.join(', ')}`);
  }

  return lines;
}

export function refreshData(result: SessionRefresh): Record<string, unknown> {
  return {
    project: result.project,
    outcome: result.outcome,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.fix === undefined ? {} : { fix: result.fix }),
    ...(result.flushed === undefined ? {} : { flushed: result.flushed }),
    ...(result.pending === undefined ? {} : { pending: result.pending }),
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.conflicts === undefined ? {} : { conflicts: result.conflicts }),
    ...(result.ignores === undefined ? {} : { ignores: result.ignores }),
    ...(result.adopted === undefined ? {} : { adopted: result.adopted }),
    ...(result.sessionOnly === undefined ? {} : { session_only: result.sessionOnly }),
  };
}

function adoptionLines(adoption: AdoptResult | undefined): {
  adopted?: string[];
  sessionOnly?: string[];
} {
  if (adoption === undefined) {
    return {};
  }

  return {
    ...(adoption.adopted.length === 0 ? {} : { adopted: adoption.adopted }),
    ...(adoption.sessionOnly.length === 0 ? {} : { sessionOnly: adoption.sessionOnly }),
  };
}

function writeKeptIgnores(root: string, kept: string[]): AdoptResult {
  const file = join(root, IGNORE_FILE);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const result = adoptIgnores(text, kept);

  if (result.adopted.length === 0) {
    return result;
  }

  const temporary = temporaryPath(root);
  writeFileSync(temporary, result.text);
  renameSync(temporary, file);

  return result;
}

function temporaryPath(root: string): string {
  const git = join(root, '.git');
  const folder = existsSync(git) && statSync(git).isDirectory();

  return folder ? join(git, 'corami-ignore.tmp') : join(root, `${IGNORE_FILE}.tmp`);
}
