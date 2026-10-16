import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { runImport } from '@/cli/commands/import.ts';
import { createLocalCopy } from '@/cli/commands/sync.ts';
import { resolveLocalPath } from '@/cli/commands/sync-remove.ts';
import { renderNextSteps, renderTable } from '@/cli/output.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import {
  addProject,
  listProjects,
  type ProjectSummary,
  projectDetail,
  removeProject,
} from '@/cli/server-client.ts';
import { type Role, readGlobalConfig, serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { afterProjectAdd } from '@/core/next-steps.ts';
import { type LocalCopyPlan, planProjectAdd, repositoryAt } from '@/core/project-add.ts';
import { isFolderEmpty } from '@/core/projects.ts';
import { MutagenEngine, type SyncSession } from '@/integrations/mutagen.ts';

async function ls(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const projects = await listProjects();

  if (context.output.json) {
    return { data: { projects } };
  }

  if (projects.length === 0) {
    return { text: 'No projects. Add one with corami project add <url>.' };
  }

  const rows = projects.map((project) => ({
    name: project.name,
    path: project.path,
    previews: project.previews.length,
    responding: project.previews.filter((preview) => preview.responding).length,
  }));

  return {
    text: renderTable(rows, [
      { header: 'Project', value: (row) => row.name },
      { header: 'Path', value: (row) => row.path },
      { header: 'Previews', value: (row) => String(row.previews) },
      { header: 'Responding', value: (row) => String(row.responding) },
    ]),
  };
}

async function show(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const target = context.args.positionals[0];

  if (target === undefined || target === '.') {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project name',
      fix: 'corami project show <name>, or corami project ls to list them',
    });
  }

  const detail = await projectDetail(target);

  if (context.output.json) {
    return { data: detail };
  }

  return { text: renderDetail(detail) };
}

function renderDetail(detail: Record<string, unknown>): string {
  const name = String(detail.name ?? '');
  const path = String(detail.path ?? '');
  const lines = [name, `Path: ${path}`];
  const previews = Array.isArray(detail.previews) ? detail.previews : [];

  for (const entry of previews as Array<Record<string, unknown>>) {
    const url = entry.url === null || entry.url === undefined ? '(no public name)' : entry.url;
    const state = entry.responding === true ? 'responding' : 'not responding';
    lines.push(
      `preview ${String(entry.name ?? '')}: ${url} -> 127.0.0.1:${String(entry.target_port)} [${state}]`,
    );
  }

  return lines.join('\n');
}

async function add(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const url = context.args.positionals[0];
  const path = stringFlag(context.args, 'path');
  const nameFlag = stringFlag(context.args, 'name');
  const noSync = negatedFlag(context.args, 'sync');
  const dryRun = booleanFlag(context.args, 'dry-run');

  if (url === undefined && path === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing repository URL or --path',
      fix: 'corami project add git@github.com:me/myapp.git, or corami project add --path ~/dev/myapp',
    });
  }

  const derivedName =
    nameFlag ?? (url === undefined ? basename(resolve(path ?? '.')) : deriveName(url));
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const localPath = resolveLocalPath(derivedName);
  const plan = await planLocalCopy({
    role,
    url,
    path,
    explicitName: nameFlag,
    noSync,
    project: derivedName,
    localPath,
  });

  if (dryRun) {
    const data = {
      name: derivedName,
      url,
      path,
      cloned: false,
      dry_run: true,
      local_copy: plan.decision,
    };

    return context.output.json
      ? { data }
      : {
          text: [
            `Project ${derivedName} would be added on the server.`,
            ...dryRunText(plan, localPath),
          ].join('\n'),
        };
  }

  const project = await addProject(
    url === undefined
      ? { name: derivedName, path: resolve(path ?? '.') }
      : { name: derivedName, url },
  );
  const serverPath =
    typeof project.path === 'string' ? project.path : serverProjectPath('~', derivedName);
  const copy = await applyLocalCopy(plan, derivedName, localPath, serverPath);

  if (context.output.json) {
    return { data: { ...project, local_copy: copy.json } };
  }

  const lines = [`Project ${derivedName} added on the server.`, ...copy.text];
  lines.push(
    ...renderNextSteps(
      afterProjectAdd(derivedName, {
        role,
        ...(copy.local === undefined ? {} : { local: copy.local }),
        serverPath,
      }),
    ),
  );

  return { text: lines.join('\n') };
}

interface LocalCopyInput {
  role: Role | undefined;
  url?: string | undefined;
  path?: string | undefined;
  explicitName?: string | undefined;
  noSync: boolean;
  project: string;
  localPath: string;
}

interface LocalCopyResult {
  decision: LocalCopyPlan;
  session?: SyncSession | undefined;
}

// The state `planProjectAdd` decides on, gathered here: the repository of the
// folder we run in, the session of the sync engine, the folder of the copy.
async function planLocalCopy(input: LocalCopyInput): Promise<LocalCopyResult> {
  const onClient = input.role === 'client';
  const needsCopy = onClient && !input.noSync && input.url !== undefined;
  const cwdRepository =
    onClient && input.url !== undefined ? await repositoryAt(process.cwd()) : undefined;
  const session = needsCopy ? await sessionFor(input.project) : undefined;
  const decision = planProjectAdd({
    role: input.role,
    url: input.url,
    path: input.path,
    explicitName: input.explicitName,
    noSync: input.noSync,
    cwdRepository,
    session: session !== undefined,
    target: {
      exists: existsSync(input.localPath),
      empty: isFolderEmpty(input.localPath),
    },
  });

  return { decision, session };
}

async function sessionFor(
  project: string,
  engine = new MutagenEngine(),
): Promise<SyncSession | undefined> {
  try {
    return await engine.status(project);
  } catch {
    return undefined;
  }
}

interface AppliedCopy {
  json: Record<string, unknown> | null;
  text: string[];
  /** The local copy, when this command created one. */
  local?: string | undefined;
}

// The copy is created after the project is on the server: one that fails does
// not take the project away, it is reported and `sync add` retries it.
async function applyLocalCopy(
  plan: LocalCopyResult,
  project: string,
  localPath: string,
  serverPath: string,
): Promise<AppliedCopy> {
  if (plan.decision === 'create') {
    try {
      const copy = await createLocalCopy({ project, localPath, serverPath });

      return {
        json: { status: 'created', local: copy.local, git: copy.git },
        text: [
          `Local copy at ${copy.local}.`,
          `git: ${copy.git.summary}`,
          ...(copy.git.detail === undefined ? [] : [`  ${copy.git.detail}`]),
        ],
        local: copy.local,
      };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const fix = `corami sync add ${project}`;

      return {
        json: { status: 'failed', summary, fix },
        text: [`Local copy failed: ${summary}`, `To try again: ${fix}.`],
      };
    }
  }

  if (plan.decision === 'orphan-session') {
    const local = plan.session?.beta ?? localPath;
    const fix = `corami sync rm ${project}, then corami sync add ${project}`;

    return {
      json: { status: 'orphan-session', local, fix },
      text: [
        `Local copy not created: a sync session for ${project} already exists at ${local}, from a project that was removed from the server.`,
        `To start over: ${fix}.`,
      ],
    };
  }

  if (plan.decision === 'target-not-empty') {
    const fix = `Move that folder away, or create the copy elsewhere: corami sync add ${project} --path <folder>`;

    return {
      json: { status: 'target-not-empty', local: localPath, fix },
      text: [`Local copy not created: ${localPath} exists and is not empty.`, `${fix}.`],
    };
  }

  return { json: null, text: [] };
}

function dryRunText(plan: LocalCopyResult, localPath: string): string[] {
  if (plan.decision === 'create') {
    return [`Local copy would be created at ${localPath}.`];
  }

  if (plan.decision === 'orphan-session') {
    return [
      `Local copy not created: a sync session already exists at ${plan.session?.beta ?? localPath}.`,
    ];
  }

  if (plan.decision === 'target-not-empty') {
    return [`Local copy not created: ${localPath} exists and is not empty.`];
  }

  return [];
}

function deriveName(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  const parts = cleaned.split(/[/:]/);
  const last = parts.at(-1);

  if (last === undefined || last === '') {
    throw new CoramiError({ code: 'usage', message: `Cannot derive a project name from ${url}` });
  }

  return last;
}

async function rm(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const name = context.args.positionals[0];

  if (name === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project name',
      fix: 'corami project rm <name>',
    });
  }

  if (!booleanFlag(context.args, 'yes')) {
    throw new CoramiError({
      code: 'usage',
      message: `Confirmation required to remove ${name}`,
      fix: `Run corami project rm ${name} --yes`,
    });
  }

  // The session of this client goes first: the server deletes the folder of
  // the project, and the copy should not be there when it happens. The
  // sessions of the other clients stay where they are.
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const engine = new MutagenEngine();
  const session = role === 'client' ? await sessionFor(name, engine) : undefined;

  if (session !== undefined) {
    await engine.terminate(name);
  }

  let result: Record<string, unknown>;

  try {
    result = await removeProject(name);
  } catch (error) {
    if (session === undefined) {
      throw error;
    }

    // The project is still on the server, the copy of this machine is closed:
    // say both, and how to reopen it.
    const message = error instanceof Error ? error.message : String(error);

    throw new CoramiError({
      code: error instanceof CoramiError ? error.code : 'generic',
      message: `${message}. The sync of this machine is closed`,
      fix: `corami sync add ${name} to reopen it`,
    });
  }

  const keptFolder = result.folder === 'kept' && typeof result.path === 'string';
  const localCopy = session === undefined ? null : { local: session.beta, session_closed: true };

  if (context.output.json) {
    return { data: { ...result, local_copy: localCopy } };
  }

  const lines = [`Project ${name} removed from the server.`];

  if (keptFolder) {
    lines.push(`Folder kept at ${result.path}: it was registered with --path.`);
  }

  if (localCopy !== null) {
    lines.push(`Local files kept at ${localCopy.local}: the sync of this machine is closed.`);

    if (!keptFolder) {
      lines.push(
        'They are now the only copy of the uncommitted work. Remove that folder before adding the project again with the same name.',
      );
    }
  }

  return { text: lines.join('\n') };
}

const NAME_FLAG = { name: 'name', value: 'name', description: 'Project name on the server' };
const DRY_RUN_FLAG = { name: 'dry-run', description: 'Show what it would do, without doing it' };

export const projectCommand: CommandSpec = {
  name: 'project',
  summary: 'Manages projects',
  usage: 'corami project <action> [arguments]',
  actions: [
    {
      name: 'ls',
      summary: 'Lists the projects with their previews',
      usage: 'corami project ls',
      examples: ['corami project ls'],
      run: ls,
    },
    {
      name: 'show',
      summary: 'Shows a project: path, git, previews',
      usage: 'corami project show <name>',
      examples: ['corami project show myapp'],
      run: show,
    },
    {
      name: 'add',
      summary: 'Clones a repository on the server, or registers a folder already there',
      usage:
        'corami project add <git-url> [--name <name>] [--no-sync] [--dry-run] | corami project add --path <folder>',
      flags: [
        NAME_FLAG,
        {
          name: 'path',
          value: 'folder',
          description: 'Register an existing folder of the server, without cloning',
        },
        {
          name: 'no-sync',
          description: 'Do not create the local copy of this machine',
        },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami project add git@github.com:me/myapp.git',
        'corami project add git@github.com:me/myapp.git --no-sync',
        'corami project add --path ~/projects/myapp',
      ],
      run: add,
    },
    {
      name: 'import',
      summary: 'Moves a local project to the server, the folder becomes the synced copy',
      usage:
        'corami project import [folder] [--name <name>] [--include <glob>] [--user <user>] [--dry-run]',
      flags: [
        NAME_FLAG,
        { name: 'include', value: 'glob', description: 'Local files to copy, repeatable' },
        {
          name: 'user',
          value: 'user',
          description: 'User on the server, default the one of the configuration',
        },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami project import ~/dev/myapp',
        'corami project import . --name myapp --include .env.local --dry-run',
      ],
      run: runImport,
    },
    {
      name: 'rm',
      summary:
        'Removes a project from the server, previews included, and closes the copy of this client',
      usage: 'corami project rm <name> --yes',
      flags: [{ name: 'yes', description: 'Confirm the removal' }],
      examples: ['corami project rm myapp --yes'],
      run: rm,
    },
  ],
};

export type { ProjectSummary };
