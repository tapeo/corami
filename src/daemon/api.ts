import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';

import { homeDirectory, projectRoot } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run, runOrThrow } from '@/core/exec.ts';
import { gitOriginUrl, hasGitRepository, readGitState } from '@/core/git.ts';
import { gitStateJson } from '@/core/git-align.ts';
import { gitOriginState, originStatusJson } from '@/core/git-follow.ts';
import { moveStagingIntoPlace } from '@/core/import-staging.ts';
import { validatePreviewName, validateTargetPort } from '@/core/previews.ts';
import { serverFolderOverlaps, serverPathFrom, validServerPath } from '@/core/project-add.ts';
import { validNewProjectName, validProjectName } from '@/core/projects.ts';
import { deleteProject, getProject, listProjects, upsertProject } from '@/core/state.ts';
import { handleClientsRoute, handleExecRoute } from '@/daemon/exec-api.ts';
import {
  applyPreview,
  listPreviewViews,
  type PreviewOptions,
  removePreview,
  removeProjectPreviews,
} from '@/daemon/previews.ts';
import type { DaemonOptions } from '@/daemon/server.ts';

export interface ApiContext {
  options: DaemonOptions;
  previews: PreviewOptions;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export async function handleApi(
  request: Request,
  context: ApiContext,
): Promise<ApiResult | undefined> {
  const url = new URL(request.url);
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeSegment(segment));

  if (segments[0] !== 'v1') {
    return undefined;
  }

  const [, resource, ...rest] = segments;

  if (resource === 'projects') {
    return handleProjects(request, rest, context);
  }

  if (resource === 'previews') {
    if (request.method !== 'GET') {
      return methodNotAllowed();
    }

    return {
      status: 200,
      body: { ok: true, data: { previews: await listPreviewViews(context.previews) } },
    };
  }

  if (resource === 'exec') {
    return handleExecRoute(request, rest);
  }

  if (resource === 'clients') {
    return handleClientsRoute(request, rest);
  }

  return undefined;
}

async function handleProjects(
  request: Request,
  rest: string[],
  context: ApiContext,
): Promise<ApiResult> {
  const method = request.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { ok: true, data: { projects: await projectSummaries(context) } },
      };
    }

    if (method === 'POST') {
      const body = await readBody(request);
      return addProject(body, context);
    }

    return methodNotAllowed();
  }

  const name = rest[0] ?? '';

  if (!validProjectName(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${name}`,
      fix: 'A project name is letters, digits, dot, dash and underscore: corami project ls lists the projects',
    });
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: { ok: true, data: await projectDetail(name, context) } };
    }

    if (method === 'DELETE') {
      return removeProject(name);
    }

    return methodNotAllowed();
  }

  if (rest[1] === 'git') {
    return handleProjectGit(request, name, rest[2]);
  }

  if (rest[1] === 'previews') {
    return handleProjectPreviews(request, name, rest[2], context);
  }

  return {
    status: 404,
    body: { ok: false, error: { code: 'usage', message: `Unknown route ${request.url}` } },
  };
}

async function handleProjectGit(
  request: Request,
  project: string,
  action: string | undefined,
): Promise<ApiResult> {
  const row = getProject(project);

  if (row === undefined) {
    throw new CoramiError({ code: 'config_invalid', message: `Project not found: ${project}` });
  }

  if (action === 'state' && request.method === 'GET') {
    const state = await readGitState(row.path);
    const origin = await gitOriginState(row.path);
    const originUrl = await gitOriginUrl(row.path);

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          project,
          state: gitStateJson(state),
          origin: originStatusJson(origin),
          origin_url: originUrl ?? null,
        },
      },
    };
  }

  return {
    status: 404,
    body: { ok: false, error: { code: 'usage', message: `Unknown route ${request.url}` } },
  };
}

async function handleProjectPreviews(
  request: Request,
  project: string,
  name: string | undefined,
  context: ApiContext,
): Promise<ApiResult> {
  const row = getProject(project);

  if (row === undefined) {
    throw new CoramiError({ code: 'config_invalid', message: `Project not found: ${project}` });
  }

  if (name === undefined) {
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          previews: (await listPreviewViews(context.previews)).filter((v) => v.project === project),
        },
      },
    };
  }

  validatePreviewName(name);

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await readBody(request);
    const targetPort = Number(body.target_port);

    validateTargetPort(targetPort);

    const preview = await applyPreview(project, name, targetPort, context.previews);

    return { status: 200, body: { ok: true, data: preview } };
  }

  if (request.method === 'DELETE') {
    const removed = await removePreview(project, name);
    return { status: 200, body: { ok: true, data: { project, preview: name, removed } } };
  }

  return methodNotAllowed();
}

async function projectSummaries(context: ApiContext): Promise<Array<Record<string, unknown>>> {
  const rows = listProjects();
  const previews = await listPreviewViews(context.previews);

  return rows.map((row) => ({
    name: row.name,
    path: row.path,
    repo_url: row.repo_url,
    created_at: row.created_at,
    previews: previews.filter((preview) => preview.project === row.name),
  }));
}

async function projectDetail(name: string, context: ApiContext): Promise<Record<string, unknown>> {
  const row = getProject(name);

  if (row === undefined) {
    throw new CoramiError({ code: 'config_invalid', message: `Project not found: ${name}` });
  }

  const previews = (await listPreviewViews(context.previews)).filter(
    (preview) => preview.project === name,
  );

  return {
    name: row.name,
    path: row.path,
    repo_url: row.repo_url,
    created_at: row.created_at,
    previews,
  };
}

async function addProject(body: Record<string, unknown>, context: ApiContext): Promise<ApiResult> {
  const url = typeof body.url === 'string' ? body.url : undefined;
  const name = typeof body.name === 'string' ? body.name : undefined;
  const path = typeof body.path === 'string' ? body.path : undefined;
  const staging = typeof body.staging === 'string' ? body.staging : undefined;
  const owned = body.owned === true || url !== undefined;

  if (name === undefined || (url === undefined && path === undefined)) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing url or path, or the project name',
    });
  }

  if (!validNewProjectName(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${name}`,
      fix: 'A project name starts with a letter and goes on with letters, digits and dashes: --name chooses another one',
    });
  }

  if (url !== undefined && (url.startsWith('-') || url.trim() === '')) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid repository url: ${url}`,
      fix: 'A url is https://host/path, ssh://host/path or host:path',
    });
  }

  if (path !== undefined && !validServerPath(path)) {
    throw new CoramiError({
      code: 'usage',
      message: `The path of a project on the server is absolute or starts with ~/: ${path}`,
      fix: 'Give the folder in full, as the server sees it',
    });
  }

  if (staging !== undefined && (path === undefined || !owned)) {
    throw new CoramiError({
      code: 'usage',
      message: 'The staging folder of an import needs the path of the project and `owned`',
    });
  }

  if (staging !== undefined && !validServerPath(staging)) {
    throw new CoramiError({
      code: 'usage',
      message: `The staging folder of an import is absolute or starts with ~/: ${staging}`,
      fix: 'Give the folder in full, as the server sees it',
    });
  }

  const home = homeDirectory();
  const underHome = path?.startsWith('~/') === true;

  if (underHome && !posix.isAbsolute(home)) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'The daemon does not know the home of the account that owns the projects',
      fix: 'Run corami setup server again on this machine',
    });
  }

  const target = path === undefined ? join(projectRoot(), name) : serverPathFrom(home, path);
  const existing = getProject(name);

  if (existing !== undefined) {
    throw new CoramiError({
      code: 'project_exists',
      message: `Already a project named ${name} on the server: ${existing.path}`,
      fix: `corami project ls to see it, or corami project rm ${name} --on server --yes to remove it first`,
    });
  }

  if (url === undefined && path !== undefined && staging === undefined && !existsSync(target)) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Folder not found on the server: ${target}`,
      fix: '--server-path refers to a folder of the server, and it is not there',
    });
  }

  const others = listProjects().map((project) => project.path);

  if (serverFolderOverlaps(target, others)) {
    const other = others.find((folder) => serverFolderOverlaps(target, [folder]));

    throw new CoramiError({
      code: 'usage',
      message: `The folder ${target} is inside the project at ${other ?? ''}, or around it`,
      fix: 'Pick a folder outside the other projects: corami project ls lists them',
    });
  }

  if (url !== undefined) {
    if (hasGitRepository(target)) {
      throw new CoramiError({
        code: 'project_exists',
        message: `Already a git repository: ${target}`,
      });
    }

    await runOrThrow('git', ['clone', '--', url, target]);
  }

  const fromStaging = staging === undefined ? undefined : serverPathFrom(home, staging);

  if (fromStaging !== undefined) {
    moveStagingIntoPlace(fromStaging, target, () => {
      upsertProject({
        name,
        path: target,
        repo_url: url ?? null,
        created_at: new Date().toISOString(),
        owned,
      });
    });

    return { status: 200, body: { ok: true, data: await projectDetail(name, context) } };
  }

  upsertProject({
    name,
    path: target,
    repo_url: url ?? null,
    created_at: new Date().toISOString(),
    owned,
  });

  return { status: 200, body: { ok: true, data: await projectDetail(name, context) } };
}

async function removeProject(name: string): Promise<ApiResult> {
  const row = getProject(name);

  if (row === undefined) {
    throw new CoramiError({ code: 'config_invalid', message: `Project not found: ${name}` });
  }

  await removeProjectPreviews(name);

  const removal = row.owned ? 'delete' : 'keep';

  if (removal === 'delete') {
    const removed = await run('rm', ['-rf', row.path]);

    if (!removed.ok) {
      throw new CoramiError({
        code: 'generic',
        message: `The folder of ${name} could not be removed: ${row.path}`,
        fix: (removed.stderr || removed.stdout).trim() || `rm exited with ${removed.exitCode}`,
      });
    }
  }

  deleteProject(name);

  return {
    status: 200,
    body: {
      ok: true,
      data: { removed: name, folder: removal === 'delete' ? 'deleted' : 'kept', path: row.path },
    },
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();

  if (text.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function methodNotAllowed(): ApiResult {
  return {
    status: 405,
    body: { ok: false, error: { code: 'usage', message: 'Method not allowed' } },
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
