import { CoramiError } from '@/core/errors.ts';
import { isPortResponding } from '@/core/ports.ts';
import {
  allocatePublicPort,
  type PreviewRow,
  type PreviewView,
  planServeRules,
  previewUrl,
} from '@/core/previews.ts';
import { deletePreview, getPreview, listPreviews, upsertPreview } from '@/core/state.ts';
import { servedTargets, serveHttps, serveOff, serveStatus } from '@/integrations/tailscale.ts';

export interface PreviewOptions {
  fqdn?: string | undefined;
  tailscaleAvailable: boolean;
}

let serveChain: Promise<unknown> = Promise.resolve();

const SERVE_BUSY = /another client is changing the serve config|etag mismatch/i;

function queueServe<T>(task: () => Promise<T>): Promise<T> {
  const next = serveChain.then(task, task);
  serveChain = next.catch(() => undefined);

  return next;
}

async function applyRule(port: number, target: string): Promise<{ ok: boolean; detail: string }> {
  return queueServe(async () => {
    const first = await serveHttps(port, target);

    if (first.ok || !SERVE_BUSY.test(first.detail)) {
      return first;
    }

    await Bun.sleep(300);
    return serveHttps(port, target);
  });
}

async function dropRule(port: number): Promise<void> {
  await queueServe(async () => {
    const first = await serveOff(port);

    if (first.ok || !SERVE_BUSY.test(first.detail)) {
      return;
    }

    await Bun.sleep(300);
    await serveOff(port);
  });
}

export async function applyPreview(
  project: string,
  name: string,
  targetPort: number,
  options: PreviewOptions,
): Promise<PreviewView> {
  const existing = getPreview(project, name);
  const publicPort =
    existing?.public_port ?? allocatePublicPort(listPreviews().map((row) => row.public_port));
  const target = localTarget(targetPort);

  const row: PreviewRow = {
    project,
    name,
    public_port: publicPort,
    target_port: targetPort,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };

  upsertPreview(row);

  const result = await applyRule(publicPort, target);

  if (!result.ok) {
    if (existing === undefined) {
      deletePreview(project, name);
    } else {
      upsertPreview(existing);
    }

    throw new CoramiError({
      code: 'generic',
      message: `tailscale serve failed for port ${publicPort}: ${result.detail}`,
      fix: options.tailscaleAvailable
        ? 'Check that Tailscale is up and HTTPS certificates are enabled for the tailnet'
        : 'Install and start Tailscale on the server',
    });
  }

  return toView(row, options.fqdn, await isPortResponding(targetPort));
}

export function localTarget(targetPort: number): string {
  return `http://127.0.0.1:${targetPort}`;
}

export async function removePreview(project: string, name: string): Promise<boolean> {
  const row = getPreview(project, name);

  if (row === undefined) {
    return false;
  }

  await dropRule(row.public_port);
  deletePreview(project, name);

  return true;
}

export async function removeProjectPreviews(project: string): Promise<void> {
  for (const row of listPreviews().filter((entry) => entry.project === project)) {
    await dropRule(row.public_port).catch(() => undefined);
  }

  for (const row of listPreviews().filter((entry) => entry.project === project)) {
    deletePreview(row.project, row.name);
  }
}

export async function listPreviewViews(options: PreviewOptions): Promise<PreviewView[]> {
  const rows = listPreviews();
  const responding = await Promise.all(rows.map((row) => isPortResponding(row.target_port)));

  return rows.map((row, index) => toView(row, options.fqdn, responding[index] === true));
}

export async function reconcileServeRules(): Promise<{ apply: number[]; remove: number[] }> {
  const status = await serveStatus().catch(() => undefined);

  if (status === undefined) {
    return { apply: [], remove: [] };
  }

  const desired = listPreviews().map((row) => ({
    port: row.public_port,
    target: localTarget(row.target_port),
  }));
  const plan = planServeRules(desired, servedTargets(status));

  for (const port of plan.remove) {
    await dropRule(port).catch(() => undefined);
  }

  for (const rule of plan.apply) {
    await applyRule(rule.port, rule.target).catch(() => undefined);
  }

  return { apply: plan.apply.map((rule) => rule.port), remove: plan.remove };
}

function toView(row: PreviewRow, fqdn: string | undefined, responding: boolean): PreviewView {
  return {
    ...row,
    url: fqdn === undefined ? null : previewUrl(fqdn, row.public_port),
    responding,
  };
}
