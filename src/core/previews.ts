import { resolve, sep } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { DAEMON_PORT, PORT_RANGE_END, PORT_RANGE_START } from '@/core/ports.ts';

export interface PreviewRow {
  project: string;
  name: string;
  public_port: number;
  target_port: number;
  created_at: string;
}

export interface PreviewView extends PreviewRow {
  url: string | null;
  responding: boolean;
}

export const PREVIEW_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validatePreviewName(name: string): void {
  if (!PREVIEW_NAME_PATTERN.test(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid preview name: ${name}`,
      fix: 'Use letters, digits, dots, dashes and underscores',
    });
  }
}

export function validateTargetPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid port: ${port}`,
      fix: 'Pass the port the dev server listens on, between 1 and 65535',
    });
  }

  if (port === DAEMON_PORT || (port >= PORT_RANGE_START && port <= PORT_RANGE_END)) {
    throw new CoramiError({
      code: 'usage',
      message: `Port ${port} is reserved by Corami`,
      fix: `Use a port outside ${PORT_RANGE_START}-${PORT_RANGE_END} and ${DAEMON_PORT}`,
    });
  }
}

// The public port is stable per preview: an existing record keeps its port.
export function allocatePublicPort(taken: number[]): number {
  const used = new Set(taken);

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }

  throw new CoramiError({
    code: 'generic',
    message: `No free public port between ${PORT_RANGE_START} and ${PORT_RANGE_END}`,
    fix: 'Remove some previews with corami serve rm',
  });
}

export function previewUrl(fqdn: string, publicPort: number): string {
  return `https://${fqdn}:${publicPort}`;
}

function isInPreviewRange(port: number): boolean {
  return port >= PORT_RANGE_START && port <= PORT_RANGE_END;
}

// The serve rules of the preview range that must be created and removed to
// match the registry. Rules outside the range belong to the user and are
// never touched.
export function planServeRules(
  desired: number[],
  current: number[],
): { add: number[]; remove: number[] } {
  const wanted = new Set(desired.filter(isInPreviewRange));
  const present = new Set(current.filter(isInPreviewRange));

  return {
    add: [...wanted].filter((port) => !present.has(port)).sort((left, right) => left - right),
    remove: [...present].filter((port) => !wanted.has(port)).sort((left, right) => left - right),
  };
}

export interface ProjectPath {
  name: string;
  path: string;
}

// The project a folder belongs to: the longest project path that contains it.
// The daemon and the CLI use it instead of a configuration file in the repo.
export function projectForPath(cwd: string, projects: ProjectPath[]): string | undefined {
  const target = resolve(cwd);
  let best: { name: string; length: number } | undefined;

  for (const project of projects) {
    const root = resolve(project.path);
    const inside = target === root || target.startsWith(`${root}${sep}`);

    if (!inside) {
      continue;
    }

    if (best === undefined || root.length > best.length) {
      best = { name: project.name, length: root.length };
    }
  }

  return best?.name;
}
