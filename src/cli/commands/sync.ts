import { mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { gitSides } from '@/cli/commands/git.ts';
import { applyRemoval, planRemoval, resolveLocalPath } from '@/cli/commands/sync-remove.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import { projectDetail, projectGit } from '@/cli/server-client.ts';
import { homeDirectory, readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { type CopyGitResult, giveCopyGit } from '@/core/git.ts';
import { describeOrigin } from '@/core/git-follow.ts';
import { lastChange } from '@/core/last-change.ts';
import { MutagenEngine, type SyncSession } from '@/integrations/mutagen.ts';

async function engineAndServer(): Promise<{ engine: MutagenEngine; host: string; user: string }> {
  const config = await readGlobalConfig();
  const host = config?.server_host;

  if (host === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'This machine is not connected to a server',
      fix: 'Run corami setup client <server> first',
    });
  }

  const user = process.env.CORAMI_SERVER_USER ?? 'root';

  return { engine: new MutagenEngine(), host, user };
}

// The project of the folder we are in: the local copy that contains it, from
// the sessions of the sync engine. No file in the repository is needed.
async function projectFromCwd(): Promise<string | undefined> {
  const engine = new MutagenEngine();
  const sessions = await engine.list();
  const target = resolve(process.cwd());
  const matches = sessions.filter((session) => {
    const beta = resolve(session.beta);
    return target === beta || target.startsWith(`${beta}${sep}`);
  });

  matches.sort((left, right) => resolve(right.beta).length - resolve(left.beta).length);

  return matches[0]?.project;
}

async function projectNameOf(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }

  const found = await projectFromCwd();

  if (found === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project',
      fix: 'corami sync <project>, or run it from inside the local copy',
    });
  }

  return found;
}

function localPathOf(project: string, explicit?: string): string {
  if (explicit !== undefined) {
    return resolve(explicit);
  }

  return join(homeDirectory(), 'corami', project);
}

export interface CreateSyncOptions {
  project: string;
  localPath: string;
  serverPath?: string | undefined;
}

export async function createSyncFor(
  options: CreateSyncOptions,
): Promise<{ session: SyncSession | undefined; local: string; created: boolean }> {
  const { engine, host, user } = await engineAndServer();

  const detail = await projectDetail(options.project).catch(() => {
    throw new CoramiError({
      code: 'config_invalid',
      message: `No project named ${options.project} on the server`,
      fix: 'corami project ls to see the projects on the server',
    });
  });

  const existing = await engine.status(options.project);

  if (existing !== undefined) {
    return { session: existing, local: existing.beta, created: false };
  }

  mkdirSync(dirname(options.localPath), { recursive: true });

  await engine.create({
    project: options.project,
    serverHost: host,
    serverUser: user,
    // The folder the server keeps the project in: `project add --path` leaves
    // it where it was.
    serverPath:
      options.serverPath ??
      (typeof detail.path === 'string' ? detail.path : `~/corami/projects/${options.project}`),
    localPath: options.localPath,
    ignore: [],
  });

  return {
    session: await engine.status(options.project),
    local: options.localPath,
    created: true,
  };
}

async function start(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = await projectNameOf(context.args.positionals[0]);
  const localPath = localPathOf(project, stringFlag(context.args, 'path'));

  if (booleanFlag(context.args, 'dry-run')) {
    const { host, user } = await engineAndServer();
    const plan = {
      project,
      server: `${user}@${host}:~/corami/projects/${project}`,
      local: localPath,
    };
    return context.output.json ? { data: plan } : { text: JSON.stringify(plan, null, 2) };
  }

  const result = await createSyncFor({
    project,
    localPath,
    serverPath: stringFlag(context.args, 'server-path'),
  });
  const gitResult = negatedFlag(context.args, 'git')
    ? ({ status: 'skipped', summary: 'Skipped with --no-git' } satisfies CopyGitResult)
    : await copyGit(project, result.local);

  if (context.output.json) {
    return {
      data: {
        project,
        local: result.local,
        session: result.session,
        created: result.created,
        git: gitResult,
      },
    };
  }

  const lines = [
    result.created
      ? `Local copy of ${project} at ${result.local}.`
      : `Local copy of ${project} already at ${result.local}.`,
  ];

  if (!result.created && resolve(result.local) !== resolve(localPath)) {
    lines.push(
      `Requested path: ${localPath}. To move it: corami sync rm ${project}, then corami sync ${project} --path ${localPath}.`,
    );
  }

  lines.push(`git: ${gitResult.summary}`);

  if (gitResult.detail !== undefined) {
    lines.push(`  ${gitResult.detail}`);
  }

  return { text: lines.join('\n') };
}

// The local copy gets its own `.git`, cloned from the `origin` of the server
// and on its branch. A copy that already has one is left alone.
async function copyGit(project: string, local: string): Promise<CopyGitResult> {
  const server = await projectGit(project).catch(() => undefined);

  if (server === undefined) {
    return {
      status: 'failed',
      summary: 'Could not read the git state of the project on the server',
      detail: `Run corami sync ${project} again to retry`,
    };
  }

  // An older daemon answers with the state but without the url.
  if (server.originUrl === undefined && server.origin?.upstream !== undefined) {
    return {
      status: 'skipped',
      summary: 'The server did not send the url of origin',
      detail: `Run corami update on the server, then corami sync ${project} again`,
    };
  }

  return giveCopyGit({
    local,
    originUrl: server.originUrl,
    branch: server.origin?.state.branch ?? '',
  });
}

async function status(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = context.args.positionals[0];
  const engine = new MutagenEngine();
  const sessions =
    project === undefined ? await engine.list() : [await engine.status(project)].filter(Boolean);
  const filled = sessions.filter((session): session is SyncSession => session !== undefined);
  const git = await gitStatesFor(filled);
  const activity = filled.map((session) => ({
    project: session.project,
    last_change: newestMtime(session.beta),
  }));

  if (context.output.json) {
    return { data: { sessions: filled, git, activity } };
  }

  if (filled.length === 0) {
    return { text: 'No sessions.' };
  }

  const lines: string[] = [];

  for (const session of filled) {
    lines.push(`${session.project}: ${session.status}, conflicts: ${session.conflicts.length}`);
    lines.push(`  local: ${session.beta}`);

    const last = activity.find((entry) => entry.project === session.project);

    if (last !== undefined) {
      lines.push(`  last change: ${describeAge(last.last_change)}`);
    }

    for (const conflict of session.conflicts) {
      lines.push(`  conflict: ${conflict}`);
    }

    if (session.lastError !== undefined) {
      lines.push(`  last error: ${session.lastError}`);
    }

    const entry = git.find((row) => row.project === session.project);

    if (entry !== undefined) {
      lines.push(`  git: local ${entry.client} / server ${entry.server}`);
    }
  }

  return { text: lines.join('\n') };
}

export function describeAge(iso: string): string {
  const age = Date.now() - Date.parse(iso);

  if (Number.isNaN(age) || age < 60_000) {
    return 'just now';
  }

  const minutes = Math.floor(age / 60_000);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${hours} h ago`;
  }

  return `${Math.floor(hours / 24)} days ago`;
}

async function gitStatesFor(
  sessions: SyncSession[],
): Promise<
  Array<{ project: string; local: string; status: string; client: string; server: string }>
> {
  const rows: Array<{
    project: string;
    local: string;
    status: string;
    client: string;
    server: string;
  }> = [];

  for (const session of sessions) {
    const sides = await gitSides(session.project, session.beta, session).catch(() => undefined);

    rows.push({
      project: session.project,
      local: session.beta,
      status: sides?.status ?? 'unknown',
      client: describeOrigin(sides?.client),
      server: describeOrigin(sides?.server),
    });
  }

  return rows;
}

async function control(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = context.args.positionals[0] ?? (await projectFromCwd());

  if (project === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project',
      fix: 'corami sync flush <project>',
    });
  }

  const engine = new MutagenEngine();
  await engine.flush(project);

  if (context.output.json) {
    return { data: { project, action: 'flush' } };
  }

  return { text: `flush done on ${project}.` };
}

async function rm(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = await projectNameOf(context.args.positionals[0]);
  const { engine } = await engineAndServer();
  await engine.path();
  const localPath = resolveLocalPath(project, stringFlag(context.args, 'path'));
  const dryRun = booleanFlag(context.args, 'dry-run');
  const plan = await planRemoval({ project, localPath });

  if (dryRun) {
    return context.output.json
      ? { data: { ...plan, dry_run: true } }
      : { text: renderPlan(plan, true) };
  }

  const result = await applyRemoval(plan, booleanFlag(context.args, 'force'));

  if (context.output.json) {
    return { data: { project, local: localPath, ...result } };
  }

  if (!result.removed) {
    return { text: `No local copy to remove at ${localPath}.` };
  }

  return {
    text: [
      `Local copy of ${project} removed (${formatBytes(result.freedBytes)}).`,
      'The project on the server, with its git repository, is untouched.',
      `To get it back: corami sync ${project}`,
    ].join('\n'),
  };
}

function renderPlan(plan: Awaited<ReturnType<typeof planRemoval>>, dryRun: boolean): string {
  const lines = [`${plan.project}: ${plan.localPath} (${formatBytes(plan.bytes)})`];

  for (const check of plan.checks) {
    lines.push(`  [${check.status}] ${check.step}: ${check.detail}`);

    for (const path of check.paths ?? []) {
      lines.push(`    ${path}`);
    }
  }

  if (dryRun) {
    lines.push('', 'Nothing done (--dry-run).');
  }

  return lines.join('\n');
}

async function prune(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const unused = stringFlag(context.args, 'unused');
  const engine = new MutagenEngine();

  if (unused === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing --unused <duration>',
      fix: 'corami sync prune --unused 30d',
    });
  }

  const maxAge = parseDuration(unused);

  if (maxAge === undefined) {
    throw new CoramiError({ code: 'usage', message: `Invalid duration: ${unused}` });
  }

  const sessions = await engine.list();
  const candidates: Array<{
    project: string;
    local: string;
    bytes: number;
    lastActivity: string;
    blocked?: string;
  }> = [];

  for (const session of sessions) {
    const local = session.beta;
    const lastActivity = newestMtime(local);
    const age = Date.now() - Date.parse(lastActivity);

    if (Number.isNaN(age) || age < maxAge) {
      continue;
    }

    const plan = await planRemoval({ project: session.project, localPath: local });
    const blocked = plan.checks.find((check) => check.status === 'blocked');

    candidates.push({
      project: session.project,
      local: local,
      bytes: plan.bytes,
      lastActivity,
      ...(blocked === undefined ? {} : { blocked: `${blocked.step}: ${blocked.detail}` }),
    });
  }

  const dryRun = booleanFlag(context.args, 'dry-run');
  const confirmed = booleanFlag(context.args, 'yes');

  if (dryRun || !confirmed) {
    if (context.output.json) {
      return { data: { candidates, removed: [], dry_run: dryRun, confirmed } };
    }

    return { text: renderCandidates(candidates, dryRun) };
  }

  const removed: string[] = [];
  const skipped: Array<{ project: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.blocked !== undefined) {
      skipped.push({ project: candidate.project, reason: candidate.blocked });
      continue;
    }

    const plan = await planRemoval({ project: candidate.project, localPath: candidate.local });
    await applyRemoval(plan, false);
    removed.push(candidate.project);
  }

  if (context.output.json) {
    return { data: { candidates, removed, skipped } };
  }

  const lines = [`Removed ${removed.length} local copies: ${removed.join(', ') || 'none'}`];

  for (const entry of skipped) {
    lines.push(`  skipped ${entry.project}: ${entry.reason}`);
  }

  return { text: lines.join('\n') };
}

export function renderCandidates(
  candidates: Array<{
    project: string;
    local: string;
    bytes: number;
    lastActivity: string;
    blocked?: string;
  }>,
  dryRun: boolean,
): string {
  if (candidates.length === 0) {
    return 'No local copy idle for longer than --unused.';
  }

  const lines: string[] = [];

  for (const candidate of candidates) {
    lines.push(
      `${candidate.project}: ${candidate.local} (${formatBytes(candidate.bytes)}), last change ${describeAge(candidate.lastActivity)}`,
    );

    if (candidate.blocked !== undefined) {
      lines.push(`  blocked: ${candidate.blocked}`);
    }
  }

  lines.push(
    '',
    dryRun
      ? 'No copy removed (--dry-run).'
      : 'No copy removed: run again with --yes to remove them.',
  );

  return lines.join('\n');
}

export function parseDuration(value: string): number | undefined {
  const match = value.match(/^(\d+)([smhd])$/);

  if (match === null) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const multiplier = unit === undefined ? undefined : multipliers[unit];

  if (Number.isNaN(amount) || multiplier === undefined) {
    return undefined;
  }

  return amount * multiplier;
}

export function newestMtime(root: string): string {
  const newest = lastChange(root);

  if (newest === undefined) {
    return new Date().toISOString();
  }

  return new Date(newest.modifiedAt).toISOString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const syncCommand: CommandSpec = {
  name: 'sync',
  summary: 'Synced local copy',
  usage: 'corami sync [<project>|<status|flush|rm|prune>]',
  flags: [
    { name: 'path', value: 'folder', description: 'Path of the local copy' },
    { name: 'server-path', value: 'folder', description: 'Path of the project on the server' },
    { name: 'no-git', description: 'Do not give the new local copy its own .git' },
    { name: 'json', description: 'JSON output' },
    { name: 'force', description: 'Proceeds even with conflicts or local-only files' },
    {
      name: 'unused',
      value: 'duration',
      description: 'Only copies idle for longer than, e.g. 30d',
    },
    { name: 'yes', description: 'Confirm the removal' },
    { name: 'dry-run', description: 'Show what it would do' },
  ],
  examples: [
    'corami sync myapp',
    'corami sync status myapp',
    'corami sync rm myapp',
    'corami sync prune --unused 30d',
  ],
  run: (context) => {
    const action = context.args.positionals[0];
    const rest: CommandContext = {
      ...context,
      args: { ...context.args, positionals: context.args.positionals.slice(1) },
    };

    switch (action) {
      case undefined:
        return start(rest);
      case 'status':
        return status(rest);
      case 'flush':
        return control(rest);
      case 'rm':
        return rm(rest);
      case 'prune':
        return prune(rest);
      default:
        return start(context);
    }
  },
};
