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
import { servedPorts, serveHttps, serveOff, serveStatus } from '@/integrations/tailscale.ts';

export interface PreviewOptions {
  fqdn?: string | undefined;
  tailscaleAvailable: boolean;
}

// Registers a preview: a stable public port pointing at the port the dev
// server listens on. Called from the daemon, so the tailscale rule is applied
// on the server.
export async function applyPreview(
  project: string,
  name: string,
  targetPort: number,
  options: PreviewOptions,
): Promise<PreviewView> {
  const existing = getPreview(project, name);
  const publicPort =
    existing?.public_port ??
    allocatePublicPort(
      listPreviews()
        .filter((row) => !(row.project === project && row.name === name))
        .map((row) => row.public_port),
    );

  const result = await serveHttps(publicPort, `http://127.0.0.1:${targetPort}`);

  if (!result.ok) {
    throw new CoramiError({
      code: 'generic',
      message: `tailscale serve failed for port ${publicPort}: ${result.detail}`,
      fix: options.tailscaleAvailable
        ? 'Check that Tailscale is up and HTTPS certificates are enabled for the tailnet'
        : 'Install and start Tailscale on the server',
    });
  }

  const row: PreviewRow = {
    project,
    name,
    public_port: publicPort,
    target_port: targetPort,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };

  upsertPreview(row);

  return toView(row, options.fqdn, await isPortResponding(targetPort));
}

export async function removePreview(project: string, name: string): Promise<boolean> {
  const row = getPreview(project, name);

  if (row === undefined) {
    return false;
  }

  await serveOff(row.public_port);
  deletePreview(project, name);

  return true;
}

export async function removeProjectPreviews(project: string): Promise<void> {
  for (const row of listPreviews().filter((entry) => entry.project === project)) {
    await serveOff(row.public_port).catch(() => undefined);
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

// At startup the daemon aligns the serve rules of the preview range with the
// registry: rules without a record are removed (they may come from an older
// version), missing rules are created. Rules outside the range are the user's
// and are never touched.
export async function reconcileServeRules(): Promise<{ add: number[]; remove: number[] }> {
  const status = await serveStatus().catch(() => undefined);

  if (status === undefined) {
    return { add: [], remove: [] };
  }

  const desired = listPreviews().map((row) => row.public_port);
  const plan = planServeRules(desired, servedPorts(status));

  for (const port of plan.remove) {
    await serveOff(port).catch(() => undefined);
  }

  const rows = listPreviews();

  for (const port of plan.add) {
    const row = rows.find((entry) => entry.public_port === port);

    if (row !== undefined) {
      await serveHttps(port, `http://127.0.0.1:${row.target_port}`).catch(() => undefined);
    }
  }

  return plan;
}

function toView(row: PreviewRow, fqdn: string | undefined, responding: boolean): PreviewView {
  return {
    ...row,
    url: fqdn === undefined ? null : previewUrl(fqdn, row.public_port),
    responding,
  };
}
