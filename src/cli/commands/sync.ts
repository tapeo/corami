import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { gitSides } from '@/cli/commands/git.ts';
import { applyRemoval, planRemoval } from '@/cli/commands/sync-remove.ts';
import { renderOrphanCopies, renderTable } from '@/cli/output.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import {
  listProjects,
  projectDetail,
  projectGit,
  projectOnServer,
  serverUserForSync,
} from '@/cli/server-client.ts';
import { readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { type CopyGitResult, giveCopyGit } from '@/core/git.ts';
import { describeOrigin } from '@/core/git-follow.ts';
import { lastChange } from '@/core/last-change.ts';
import {
  isFolderEmpty,
  isWithin,
  localCopyTarget,
  projectOfCopy,
  unexpandedHome,
  withLocalCopies,
} from '@/core/projects.ts';
import { conflictCopies, conflictFix, conflictLabel } from '@/core/sync-conflicts.ts';
import { MutagenEngine, type SyncSession } from '@/integrations/mutagen.ts';

async function engineAndServer(
  explicitUser?: string,
): Promise<{ engine: MutagenEngine; host: string; user: string }> {
  const config = await readGlobalConfig();
  const host = config?.server_host;

  if (host === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'This machine is not connected to a server',
      fix: 'Run corami setup client <server> first',
    });
  }

  const user = explicitUser ?? (await serverUserForSync());

  return { engine: new MutagenEngine(), host, user };
}

/**
 * The sessions of this machine. A sync engine that does not answer is an
 * error, not an empty list: only its answer tells which folder is the copy of
 * which project.
 */
export async function syncSessions(engine: MutagenEngine): Promise<SyncSession[]> {
  const sessions = await engine.sessions();

  if (sessions === undefined) {
    throw new CoramiError({
      code: 'capability_missing',
      message: 'Mutagen did not answer: no way to tell which local copies this machine has',
      fix: 'corami doctor checks the sync engine on this machine',
    });
  }

  return sessions;
}

// The project of the folder we are in: the local copy that contains it, from
// the sessions of the sync engine. No file in the repository is needed.
async function projectFromCwd(): Promise<string | undefined> {
  const sessions = await syncSessions(new MutagenEngine());

  return projectOfCopy(
    canonicalPath(process.cwd()),
    sessions.map((session) => ({ project: session.project, local: canonicalPath(session.beta) })),
  );
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
      fix: 'corami sync add <project>, or run it from inside the local copy',
    });
  }

  return found;
}

/**
 * A path given on the command line, resolved against the working directory.
 * A `~` the shell did not expand is refused rather than turned into a folder
 * named `~`.
 */
export function givenPath(path: string): string {
  if (unexpandedHome(path)) {
    throw new CoramiError({
      code: 'usage',
      message: `The path ${path} starts with ~, which only a shell expands`,
      fix: 'Give the path in full, or relative to the current folder',
    });
  }

  return resolve(path);
}

// The form paths are compared in, never the one a folder is created with:
// absolute, with the symbolic links of the part that exists resolved, so that
// `/tmp` and `/private/tmp` are one folder, and in lower case on macOS and
// Windows, whose disks ignore case. Two folders that differ only in case are
// then one: the checks refuse more, never less.
function canonicalPath(path: string): string {
  const real = realPath(path);

  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real;
}

function realPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;

  while (!existsSync(existing)) {
    const parent = dirname(existing);

    if (parent === existing) {
      return absolute;
    }

    existing = parent;
  }

  try {
    return join(realpathSync.native(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

/**
 * The folder of the local copy of a project: the one of its session, or the
 * one asked with `--path`. Nothing guesses it. `importing` is the folder of
 * `project import`, moved away before the copy takes its place: it does not
 * count as full, and a session already there is one the import cannot reuse.
 */
export async function copyPlace(
  engine: MutagenEngine,
  project: string,
  localPath: string | undefined,
  importing = false,
): Promise<{ session: SyncSession | undefined; local: string }> {
  const sessions = await syncSessions(engine);
  const existing = sessions.find((session) => session.project === project);
  const others = sessions.filter((session) => session.project !== project);
  const requested = localPath === undefined ? undefined : canonicalPath(localPath);

  if (importing && existing !== undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `A sync session for ${project} already exists at ${existing.beta}`,
      fix: `corami sync stop ${project} closes it and keeps its files, then run the import again`,
    });
  }

  const target = localCopyTarget({
    requested,
    session: existing === undefined ? undefined : canonicalPath(existing.beta),
    others: others.map((session) => canonicalPath(session.beta)),
    exists: !importing && requested !== undefined && existsSync(requested),
    empty: importing || (requested !== undefined && isFolderEmpty(requested)),
  });

  if (target === 'existing' && existing !== undefined) {
    return { session: existing, local: existing.beta };
  }

  if (target === 'create' && localPath !== undefined) {
    return { session: undefined, local: resolve(localPath) };
  }

  if (target === 'move') {
    throw new CoramiError({
      code: 'usage',
      message: `The local copy of ${project} is already at ${existing?.beta ?? ''}`,
      fix: `To move it: corami sync rm ${project}, then corami sync add ${project} --path ${localPath ?? '<folder>'}`,
    });
  }

  if (target === 'nested') {
    const other = others.find((session) => {
      const folder = canonicalPath(session.beta);
      return (
        requested !== undefined && (isWithin(requested, folder) || isWithin(folder, requested))
      );
    });

    throw new CoramiError({
      code: 'usage',
      message: `The folder ${localPath ?? ''} overlaps the local copy of ${other?.project ?? 'another project'} at ${other?.beta ?? ''}`,
      fix: 'Pick a folder outside the other local copies: corami sync ls lists them',
    });
  }

  if (target === 'not-empty') {
    throw new CoramiError({
      code: 'usage',
      message: `The folder ${localPath ?? ''} exists and is not empty`,
      fix: `Move that folder away, or create the copy elsewhere: corami sync add ${project} --path <folder>`,
    });
  }

  throw new CoramiError({
    code: 'usage',
    message: `Missing --path: ${project} has no local copy on this machine`,
    fix: `corami sync add ${project} --path <folder>`,
  });
}

export interface CreateSyncOptions {
  project: string;
  /** The folder of the copy, `--path`: required unless a session already has one. */
  localPath?: string | undefined;
  serverPath?: string | undefined;
  /** The account on the server, `--user`: default the one of the configuration. */
  user?: string | undefined;
}

// The folder the server keeps the project in: `project add --path` leaves it
// where it was.
function serverFolder(
  project: string,
  detail: Record<string, unknown>,
  explicit: string | undefined,
): string {
  return (
    explicit ?? (typeof detail.path === 'string' ? detail.path : serverProjectPath('~', project))
  );
}

async function projectOnServerOrFail(project: string): Promise<Record<string, unknown>> {
  return projectDetail(project).catch(() => {
    throw new CoramiError({
      code: 'config_invalid',
      message: `No project named ${project} on the server`,
      fix: 'corami project ls to see the projects on the server',
    });
  });
}

export async function createSyncFor(options: CreateSyncOptions): Promise<{
  session: SyncSession | undefined;
  local: string;
  created: boolean;
}> {
  const { engine, host, user } = await engineAndServer(options.user);

  const detail = await projectOnServerOrFail(options.project);

  const serverPath = serverFolder(options.project, detail, options.serverPath);
  const place = await copyPlace(engine, options.project, options.localPath);

  if (place.session !== undefined) {
    return { session: place.session, local: place.local, created: false };
  }

  mkdirSync(dirname(place.local), { recursive: true });

  await engine.create({
    project: options.project,
    serverHost: host,
    serverUser: user,
    serverPath,
    localPath: place.local,
    ignore: [],
  });

  return {
    session: await engine.status(options.project),
    local: place.local,
    created: true,
  };
}

export interface CreateLocalCopyOptions extends CreateSyncOptions {
  /** false with `--no-git`: the copy stays without a repository of its own. */
  git?: boolean;
}

/**
 * The local copy with its `.git`: what `sync add` runs. The import stays on
 * `createSyncFor`, because the `.git` of its copy comes from the folder it
 * renames.
 */
export async function createLocalCopy(options: CreateLocalCopyOptions): Promise<{
  session: SyncSession | undefined;
  local: string;
  created: boolean;
  git: CopyGitResult;
}> {
  const result = await createSyncFor(options);
  const git =
    options.git === false
      ? ({ status: 'skipped', summary: 'Skipped with --no-git' } satisfies CopyGitResult)
      : await copyGit(options.project, result.local);

  return { ...result, git };
}

async function start(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = await projectNameOf(context.args.positionals[0]);
  const flag = stringFlag(context.args, 'path');
  const localPath = flag === undefined ? undefined : givenPath(flag);
  const explicitUser = stringFlag(context.args, 'user');

  if (booleanFlag(context.args, 'dry-run')) {
    const { engine, host, user } = await engineAndServer(explicitUser);
    const detail = await projectOnServerOrFail(project);
    const place = await copyPlace(engine, project, localPath);
    const serverPath = serverFolder(project, detail, stringFlag(context.args, 'server-path'));
    const plan = {
      project,
      server: `${user}@${host}:${serverPath}`,
      local: place.local,
      existing: place.session !== undefined,
    };
    return context.output.json ? { data: plan } : { text: JSON.stringify(plan, null, 2) };
  }

  const result = await createLocalCopy({
    project,
    localPath,
    serverPath: stringFlag(context.args, 'server-path'),
    user: explicitUser,
    git: !negatedFlag(context.args, 'git'),
  });
  const gitResult = result.git;

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

  lines.push(`git: ${gitResult.summary}`);

  if (gitResult.detail !== undefined) {
    lines.push(`  ${gitResult.detail}`);
  }

  return { text: lines.join('\n') };
}

// The copies of this machine, read from the sessions of the sync engine: no
// daemon and no git, so it answers on a machine that is away from the server.
async function list(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const engine = new MutagenEngine();
  const sessions = await engine.sessions();

  if (sessions === undefined) {
    return context.output.json
      ? { data: { copies: [], local_copies: 'unavailable' } }
      : { text: 'Mutagen did not answer: the local copies of this machine are not shown.' };
  }

  const copies = sessions
    .map((session) => ({
      project: session.project,
      local: session.beta,
      status: session.status,
    }))
    .sort((left, right) => left.project.localeCompare(right.project));

  // The projects of the server tell the copies of a project that is gone from
  // the others. Without an answer the command still lists the sessions.
  const projects = await listProjects().catch(() => undefined);
  const orphans =
    projects === undefined
      ? []
      : withLocalCopies(
          projects,
          copies.map((copy) => ({ project: copy.project, local: copy.local })),
        ).orphan_copies;

  if (context.output.json) {
    return { data: projects === undefined ? { copies } : { copies, orphan_copies: orphans } };
  }

  if (copies.length === 0) {
    return { text: 'No local copies.' };
  }

  return {
    text: [
      renderTable(copies, [
        { header: 'Project', value: (row) => row.project },
        { header: 'Local', value: (row) => row.local },
        { header: 'State', value: (row) => row.status },
      ]),
      ...renderOrphanCopies(orphans),
    ].join('\n'),
  };
}

// The local copy gets its own `.git`, cloned from the `origin` of the server
// and on its branch. A copy that already has one is left alone.
async function copyGit(project: string, local: string): Promise<CopyGitResult> {
  const server = await projectGit(project).catch(() => undefined);

  if (server === undefined) {
    return {
      status: 'failed',
      summary: 'Could not read the git state of the project on the server',
      detail: `Run corami sync add ${project} again to retry`,
    };
  }

  // An older daemon answers with the state but without the url.
  if (server.originUrl === undefined && server.origin?.upstream !== undefined) {
    return {
      status: 'skipped',
      summary: 'The server did not send the url of origin',
      detail: `Run corami update on the server, then corami sync add ${project} again`,
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
    const described = filled.map((session) => ({
      ...session,
      conflicts: conflictCopies(session),
    }));

    return { data: { sessions: described, git, activity } };
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

    for (const copies of conflictCopies(session)) {
      lines.push(`  conflict: ${conflictLabel(copies.path)}`);
      lines.push(`    local: ${copies.local}`);
      lines.push(`    server: ${copies.server}`);
    }

    if (session.conflicts.length > 0) {
      lines.push(`  to resolve: ${conflictFix(session.project, session.conflicts)}`);
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
    const sides = await gitSides(session.project, session.beta).catch(() => undefined);

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
  // A removal names its project: the folder it runs in does not choose what
  // gets deleted.
  const project = context.args.positionals[0];

  if (project === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project: sync rm deletes a copy, so it is always named',
      fix: 'corami sync rm <project>, corami sync ls lists the copies of this machine',
    });
  }

  const { engine } = await engineAndServer();
  await engine.path();
  const sessions = await syncSessions(engine);

  // The folder to delete is the one of the session, never a path typed here:
  // a copy without a session is a folder of the user, Corami leaves it alone.
  const session = sessions.find((entry) => entry.project === project);

  if (session === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `No sync session for ${project} on this machine: there is no local copy to remove`,
      fix: 'A folder whose sync was stopped is not a copy any more: delete it by hand. corami sync ls lists the copies',
    });
  }

  const localPath = session.beta;
  const dryRun = booleanFlag(context.args, 'dry-run');
  const plan = await planRemoval({ project, localPath });
  // The folder of the project is gone on the server and the files are still
  // here: removing them removes the last copy there is.
  const lastCopy = (plan.session?.conflicts.includes('') ?? false) && existsSync(localPath);

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

  if (lastCopy) {
    return {
      text: [
        `Local copy of ${project} removed (${formatBytes(result.freedBytes)}).`,
        'The folder of the project was already gone on the server: this copy was the last one.',
      ].join('\n'),
    };
  }

  // Without a session nothing here says whether the project still exists: ask
  // the daemon, briefly, before promising that it waits on the server.
  if ((await projectOnServer(project)) === false) {
    return {
      text: [
        `Local copy of ${project} removed (${formatBytes(result.freedBytes)}).`,
        'The project is not on the server any more: there is nothing to sync it back from.',
      ].join('\n'),
    };
  }

  return {
    text: [
      `Local copy of ${project} removed (${formatBytes(result.freedBytes)}).`,
      'The project on the server, with its git repository, is untouched.',
      `To get it back: corami sync add ${project} --path ${localPath}`,
    ].join('\n'),
  };
}

/**
 * Stops the sync of this machine and keeps the files: the way out of a copy
 * whose project is gone from the server, where the session holds a root
 * deletion and `sync rm` would be deleting the last copy of the work.
 */
async function stop(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = await projectNameOf(context.args.positionals[0]);
  const { engine } = await engineAndServer();
  const sessions = await syncSessions(engine);

  const session = sessions.find((entry) => entry.project === project);

  if (session === undefined) {
    return context.output.json
      ? { data: { project, stopped: false } }
      : { text: `No sync session for ${project} on this machine.` };
  }

  await engine.terminate(project);

  if (context.output.json) {
    return { data: { project, local: session.beta, stopped: true } };
  }

  return {
    text: [
      `The sync of ${project} is stopped: the files stay at ${session.beta}.`,
      `To put that folder on the server again: corami project import ${session.beta}`,
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

const DRY_RUN_FLAG = { name: 'dry-run', description: 'Show what it would do' };

export const syncCommand: CommandSpec = {
  name: 'sync',
  summary: 'Synced local copy',
  usage: 'corami sync <action> [arguments]',
  actions: [
    {
      name: 'add',
      summary: 'Creates the local copy in the folder given, and starts the session',
      usage:
        'corami sync add [<project>] [--path <folder>] [--server-path <folder>] [--user <user>] [--no-git] [--dry-run]',
      flags: [
        {
          name: 'path',
          value: 'folder',
          description: 'Folder of the local copy, required unless the copy exists',
        },
        { name: 'server-path', value: 'folder', description: 'Path of the project on the server' },
        {
          name: 'user',
          value: 'user',
          description: 'User on the server, default the one of the configuration',
        },
        { name: 'no-git', description: 'Do not give the new local copy its own .git' },
        DRY_RUN_FLAG,
      ],
      examples: ['corami sync add myapp --path ~/code/myapp', 'corami sync add myapp'],
      run: start,
    },
    {
      name: 'ls',
      summary: 'Lists the local copies of this machine',
      usage: 'corami sync ls',
      examples: ['corami sync ls'],
      run: list,
    },
    {
      name: 'status',
      summary: 'State, conflicts, last change and git state of the two sides',
      usage: 'corami sync status [<project>]',
      examples: ['corami sync status', 'corami sync status myapp'],
      run: status,
    },
    {
      name: 'flush',
      summary: 'Flushes the queue of the session',
      usage: 'corami sync flush [<project>]',
      examples: ['corami sync flush myapp'],
      run: control,
    },
    {
      name: 'rm',
      summary: 'Removes only the local copy of the session, after the checks',
      usage: 'corami sync rm <project> [--force] [--dry-run]',
      flags: [
        { name: 'force', description: 'Proceeds even with conflicts or local-only files' },
        DRY_RUN_FLAG,
      ],
      examples: ['corami sync rm myapp', 'corami sync rm myapp --dry-run'],
      run: rm,
    },
    {
      name: 'stop',
      summary: 'Stops the sync of this copy and keeps the files',
      usage: 'corami sync stop [<project>]',
      examples: ['corami sync stop myapp'],
      run: stop,
    },
    {
      name: 'prune',
      summary: 'Lists and removes the copies of this client unused for a while',
      usage: 'corami sync prune --unused <duration> [--dry-run] [--yes]',
      flags: [
        {
          name: 'unused',
          value: 'duration',
          description: 'Only copies idle for longer than, e.g. 30d',
        },
        DRY_RUN_FLAG,
        { name: 'yes', description: 'Confirm the removal' },
      ],
      examples: ['corami sync prune --unused 30d', 'corami sync prune --unused 30d --yes'],
      run: prune,
    },
  ],
};
