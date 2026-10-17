import { basename, resolve } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { runImport } from '@/cli/commands/import.ts';
import { syncSessions } from '@/cli/commands/sync.ts';
import { renderOrphanCopies, renderTable } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import {
  addProject,
  listProjects,
  type ProjectSummary,
  projectDetail,
  removeProject,
} from '@/cli/server-client.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { planProjectAdd, repositoryAt } from '@/core/project-add.ts';
import { validProjectName, withLocalCopies } from '@/core/projects.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

async function ls(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const projects = await listProjects();
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const onClient = role === 'client';
  const sessions = onClient ? await new MutagenEngine().sessions() : undefined;
  const listed =
    sessions === undefined
      ? undefined
      : withLocalCopies(
          projects,
          sessions.map((session) => ({ project: session.project, local: session.beta })),
        );

  if (context.output.json) {
    if (!onClient) {
      return { data: { projects } };
    }

    if (listed === undefined) {
      return { data: { projects, local_copies: 'unavailable' } };
    }

    return { data: listed };
  }

  const rows = (listed?.projects ?? projects).map((project) => ({
    name: project.name,
    path: project.path,
    previews: project.previews.length,
    responding: project.previews.filter((preview) => preview.responding).length,
    local:
      'local_copy' in project && typeof project.local_copy === 'string' ? project.local_copy : '-',
  }));
  type Row = (typeof rows)[number];
  const columns: Array<{ header: string; value: (row: Row) => string }> = [
    { header: 'Project', value: (row) => row.name },
    { header: 'Path', value: (row) => row.path },
    { header: 'Previews', value: (row) => String(row.previews) },
    { header: 'Responding', value: (row) => String(row.responding) },
  ];

  if (onClient) {
    columns.push({ header: 'Local', value: (row) => row.local });
  }

  const lines = [
    projects.length === 0
      ? 'No projects. Add one with corami project add <url>.'
      : renderTable(rows, columns),
  ];

  if (onClient && sessions === undefined) {
    lines.push('Mutagen did not answer: the local copies of this machine are not shown.');
  }

  if (listed !== undefined) {
    lines.push(...renderOrphanCopies(listed.orphan_copies));
  }

  return { text: lines.join('\n') };
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

  if (!validProjectName(derivedName)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${derivedName}`,
      fix: 'A project name is letters, digits, dot, dash and underscore: --name chooses another one',
    });
  }

  const onClient = role === 'client' && url !== undefined;
  const sessions = onClient ? await syncSessions(new MutagenEngine()) : [];
  const session = sessions.find((entry) => entry.project === derivedName);

  planProjectAdd({
    role,
    project: derivedName,
    url,
    path,
    explicitName: nameFlag,
    cwdRepository: onClient ? await repositoryAt(process.cwd()) : undefined,
    session: session?.beta,
    onServer:
      session !== undefined &&
      (await projectDetail(derivedName).then(
        () => true,
        () => false,
      )),
  });

  if (dryRun) {
    const data = { name: derivedName, url, path, cloned: false, dry_run: true };

    return context.output.json
      ? { data }
      : { text: `Project ${derivedName} would be added on the server.` };
  }

  const project = await addProject(
    url === undefined
      ? { name: derivedName, path: resolve(path ?? '.') }
      : { name: derivedName, url },
  );

  if (context.output.json) {
    return { data: project };
  }

  return { text: `Project ${derivedName} added on the server.` };
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
  const session =
    role === 'client'
      ? (await syncSessions(engine)).find((entry) => entry.project === name)
      : undefined;

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
      message: `${message}. The sync of this machine is closed, the files stay at ${session.beta}`,
      fix: `Run corami project rm ${name} --yes again`,
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
        'corami project add <git-url> [--name <name>] [--dry-run] | corami project add --path <folder>',
      flags: [
        NAME_FLAG,
        {
          name: 'path',
          value: 'folder',
          description: 'Register an existing folder of the server, without cloning',
        },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami project add git@github.com:me/myapp.git',
        'corami project add --path ~/projects/myapp',
      ],
      run: add,
    },
    {
      name: 'import',
      summary: 'Moves a local project to the server, the folder becomes the synced copy',
      usage:
        'corami project import <folder> [--name <name>] [--include <glob>] [--user <user>] [--dry-run]',
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
