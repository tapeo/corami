import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { isRelationStatus, parseGitState } from '@/core/git-align.ts';
import type { GitOriginStatus } from '@/core/git-follow.ts';
import type { PreviewView } from '@/core/previews.ts';

// The state of the server towards `origin`, as the daemon sends it: without a
// fetch, it is the reading of the last service cycle.
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

// The daemon can fail to answer without refusing the connection: a network
// that filters packets, or a stuck daemon. Without a cap the command hangs on
// the system timeout, which on macOS is over a minute.
const REQUEST_TIMEOUT_MS = 20_000;

export async function baseUrl(): Promise<string> {
  const config = await readGlobalConfig().catch(() => undefined);

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${await baseUrl()}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
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
    throw new CoramiError({
      code: 'generic',
      message: `Unexpected response from ${url}: ${text.slice(0, 120)}`,
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

// The git side of a project on the server: its relation with `origin`, and the
// url of `origin` a new local copy clones from.
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

/**
 * The account that owns the projects on the server, for the SSH of the sync
 * and of the import: the one saved at the setup, then the one the daemon
 * announces, then root for a server that announces nothing.
 */
export async function serverUserForSync(): Promise<string> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.server_user !== undefined) {
    return config.server_user;
  }

  const announced = (await health().catch(() => undefined))?.user;

  return typeof announced === 'string' && announced !== '' ? announced : 'root';
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>('/v1/projects');
  return data.projects;
}

export async function projectDetail(name: string): Promise<Record<string, unknown>> {
  return request(`/v1/projects/${encodeURIComponent(name)}`);
}

export async function addProject(input: {
  name: string;
  url?: string;
  path?: string;
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
