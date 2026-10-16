import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { projectRoot } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run, runOrThrow } from '@/core/exec.ts';
import { gitOriginUrl, readGitState } from '@/core/git.ts';
import { gitStateJson } from '@/core/git-align.ts';
import { gitOriginState, originStatusJson } from '@/core/git-follow.ts';
import { validatePreviewName, validateTargetPort } from '@/core/previews.ts';
import { serverFolderRemoval } from '@/core/projects.ts';
import { deleteProject, getProject, listProjects, upsertProject } from '@/core/state.ts';
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
  const segments = url.pathname.split('/').filter((segment) => segment !== '');

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

  if (name === undefined || (url === undefined && path === undefined)) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing url or path, or the project name',
    });
  }

  const target = path ?? join(projectRoot(), name);
  const existing = getProject(name);

  if (existing !== undefined) {
    throw new CoramiError({
      code: 'project_exists',
      message: `Already a project named ${name} on the server: ${existing.path}`,
      fix: `corami project ls to see it, or corami project rm ${name} --yes to remove it first`,
    });
  }

  if (url === undefined && path !== undefined && !existsSync(path)) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Folder not found on the server: ${path}`,
      fix: 'corami project add --path refers to a folder on the server. From a client, use corami project import <folder>',
    });
  }

  if (url !== undefined) {
    if (existsSync(join(target, '.git'))) {
      throw new CoramiError({
        code: 'project_exists',
        message: `Already a git repository: ${target}`,
      });
    }

    await runOrThrow('git', ['clone', url, target]);
  }

  upsertProject({
    name,
    path: target,
    repo_url: url ?? null,
    created_at: new Date().toISOString(),
  });

  return { status: 200, body: { ok: true, data: await projectDetail(name, context) } };
}

async function removeProject(name: string): Promise<ApiResult> {
  const row = getProject(name);

  if (row === undefined) {
    throw new CoramiError({ code: 'config_invalid', message: `Project not found: ${name}` });
  }

  await removeProjectPreviews(name);

  // The folder of a project registered with `project add --path` is not ours:
  // it leaves the registry and stays where it is.
  const removal = serverFolderRemoval(row.path, projectRoot());

  if (removal === 'delete') {
    await run('rm', ['-rf', row.path]);
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
