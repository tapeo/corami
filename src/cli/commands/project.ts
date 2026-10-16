import { basename, resolve } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { runImport } from '@/cli/commands/import.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import {
  addProject,
  listProjects,
  type ProjectSummary,
  projectDetail,
  removeProject,
} from '@/cli/server-client.ts';
import { CoramiError } from '@/core/errors.ts';

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
  const localPath = stringFlag(context.args, 'path');
  const name = stringFlag(context.args, 'name');
  const dryRun = booleanFlag(context.args, 'dry-run');

  if (url === undefined && localPath === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing repository URL or --path',
      fix: 'corami project add git@github.com:me/myapp.git, or corami project add --path ~/dev/myapp',
    });
  }

  const derivedName =
    name ?? (url === undefined ? basename(resolve(localPath ?? '.')) : deriveName(url));

  if (dryRun) {
    return {
      data: { name: derivedName, url, path: localPath, cloned: false, dry_run: true },
    };
  }

  const project = await addProject(
    url === undefined
      ? { name: derivedName, path: resolve(localPath ?? '.') }
      : { name: derivedName, url },
  );

  if (context.output.json) {
    return { data: project };
  }

  return {
    text: [
      `Project ${derivedName} added on the server.`,
      `On each client: corami sync ${derivedName}. On the server: corami serve <port> to give a preview an address`,
    ].join('\n'),
  };
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

  const result = await removeProject(name);

  if (context.output.json) {
    return { data: result };
  }

  return { text: `Project ${name} removed.` };
}

const NAME_FLAG = { name: 'name', value: 'name', description: 'Project name on the server' };
const DRY_RUN_FLAG = { name: 'dry-run', description: 'Show what it would do, without doing it' };

export const projectCommand: CommandSpec = {
  name: 'project',
  summary: 'Manages projects',
  usage: 'corami project <action> [arguments]',
  flags: [{ name: 'json', description: 'JSON output' }],
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
      usage: 'corami project add <git-url> [--name <name>] | corami project add --path <folder>',
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
      summary: 'Removes a project from the server, previews included',
      usage: 'corami project rm <name> --yes',
      flags: [{ name: 'yes', description: 'Confirm the removal' }],
      examples: ['corami project rm myapp --yes'],
      run: rm,
    },
  ],
};

export type { ProjectSummary };
