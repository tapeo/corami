import { join } from 'node:path';

import { homeDirectory, readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import { isRelationStatus, parseGitState } from '@/core/git-align.ts';
import type { GitOriginStatus } from '@/core/git-follow.ts';
import type { PreviewView } from '@/core/previews.ts';

function parseOriginStatus(value: unknown): GitOriginStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const state = parseGitState(record.state);

  if (state === undefined) {
    return undefined;
  }

  return {
    state,
    upstream: typeof record.upstream === 'string' ? record.upstream : undefined,
    upstreamCommit: typeof record.upstream_commit === 'string' ? record.upstream_commit : '',
    status: isRelationStatus(record.status) ? record.status : 'unknown',
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    move: record.move === true,
    fetched: record.fetched === true,
    filesHere: record.files_here === true,
  };
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; fix?: string };
}

export interface ProjectSummary {
  name: string;
  path: string;
  repo_url: string | null;
  created_at: string;
  previews: PreviewView[];
}

const REQUEST_TIMEOUT_MS = 20_000;

const GATEWAY_ERRORS = new Set([502, 503, 504]);

export async function baseUrl(): Promise<string> {
  const config = await readGlobalConfig();

  if (config?.role === 'client') {
    if (config.server_host === undefined) {
      throw new CoramiError({
        code: 'config_invalid',
        message: 'No server host in the configuration',
        fix: 'Run corami setup client <server> again',
      });
    }

    return `https://${config.server_host}:7420`;
  }

  return 'http://127.0.0.1:7420';
}

async function localToken(): Promise<string | undefined> {
  const config = await readGlobalConfig();
  const home = config?.server_user !== undefined ? await homeFor(config.server_user) : undefined;
  const root = join(home ?? homeDirectory(), '.corami');
  const path = join(root, 'daemon-token');

  try {
    const token = (await Bun.file(path).text()).trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

async function homeFor(user: string): Promise<string | undefined> {
  const result = await run('getent', ['passwd', user]);
  const home = result.stdout.trim().split(':')[5];
  return result.ok && home !== undefined && home !== '' ? home : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await baseUrl();
  const url = `${base}${path}`;
  const headers = new Headers(init?.headers);

  if (base.startsWith('http://')) {
    const token = await localToken();

    if (token !== undefined) {
      headers.set('authorization', `Bearer ${token}`);
    }
  }

  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CoramiError({
      code: 'server_unreachable',
      message: `Cannot reach the Corami daemon at ${url}`,
      fix: 'On the server: systemctl status corami-daemon. From a client: check Tailscale',
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  const text = await response.text();
  let envelope: Envelope<T>;

  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    if (GATEWAY_ERRORS.has(response.status)) {
      throw new CoramiError({
        code: 'server_unreachable',
        message: `The Corami daemon behind ${url} does not answer (HTTP ${response.status})`,
        fix: 'On the server: systemctl --user status corami-daemon',
      });
    }

    throw new CoramiError({
      code: 'generic',
      message: `Unexpected response from ${url} (HTTP ${response.status}): ${text.slice(0, 120)}`,
    });
  }

  if (!envelope.ok || envelope.data === undefined) {
    throw new CoramiError({
      code: (envelope.error?.code as CoramiError['code']) ?? 'generic',
      message: envelope.error?.message ?? 'Unknown error',
      fix: envelope.error?.fix,
    });
  }

  return envelope.data;
}

export async function projectGitOrigin(project: string): Promise<GitOriginStatus | undefined> {
  return (await projectGit(project)).origin;
}

export async function projectGit(
  project: string,
): Promise<{ origin: GitOriginStatus | undefined; originUrl: string | undefined }> {
  const data = await request<{ project: string; origin?: unknown; origin_url?: unknown }>(
    `/v1/projects/${encodeURIComponent(project)}/git/state`,
  );

  return {
    origin: parseOriginStatus(data.origin),
    originUrl: typeof data.origin_url === 'string' ? data.origin_url : undefined,
  };
}

export async function health(): Promise<Record<string, unknown>> {
  return request('/v1/health');
}

export async function serverSupports(capability: string): Promise<boolean> {
  const announced = (await health()).capabilities;

  return Array.isArray(announced) && announced.includes(capability);
}

export async function serverUserForSync(): Promise<string> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.server_user !== undefined) {
    return config.server_user;
  }

  const announced = (await health().catch(() => undefined))?.user;

  return typeof announced === 'string' && announced !== '' ? announced : 'root';
}

export async function listProjects(
  options: { timeoutMs?: number } = {},
): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>('/v1/projects', {
    ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
  });

  return data.projects;
}

export async function projectOnServer(name: string): Promise<boolean | undefined> {
  try {
    const projects = await listProjects({ timeoutMs: 2_000 });

    return projects.some((project) => project.name === name);
  } catch {
    return undefined;
  }
}

export async function findProject(name: string): Promise<ProjectSummary | undefined> {
  const projects = await listProjects();

  return projects.find((project) => project.name === name);
}

export async function projectDetail(name: string): Promise<Record<string, unknown>> {
  return request(`/v1/projects/${encodeURIComponent(name)}`);
}

export async function addProject(input: {
  name: string;
  url?: string;
  path?: string;
  owned?: boolean;
  staging?: string;
}): Promise<Record<string, unknown>> {
  return request('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function removeProject(name: string): Promise<Record<string, unknown>> {
  return request(`/v1/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function listPreviews(): Promise<PreviewView[]> {
  const data = await request<{ previews: PreviewView[] }>('/v1/previews');
  return data.previews;
}

export async function putPreview(
  project: string,
  name: string,
  targetPort: number,
): Promise<PreviewView> {
  return request(
    `/v1/projects/${encodeURIComponent(project)}/previews/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_port: targetPort }),
    },
  );
}

export async function deletePreview(
  project: string,
  name: string,
): Promise<{ project: string; preview: string; removed: boolean }> {
  return request(
    `/v1/projects/${encodeURIComponent(project)}/previews/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}
