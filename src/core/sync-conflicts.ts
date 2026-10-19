import { join, posix } from 'node:path';

export interface ConflictCopies {
  path: string;
  local: string;
  server: string;
}

export interface ConflictSession {
  alpha: string;
  beta: string;
  conflicts: string[];
}

export const CONFLICT_RESOLUTION =
  'delete the copy you do not want to keep, the other one then syncs to both sides';

export function conflictLabel(path: string): string {
  return path === '' ? 'the folder of the project itself' : path;
}

export function conflictFix(project: string, conflicts: string[]): string {
  if (conflicts.includes('')) {
    return `the folder is gone on one side; corami sync stop ${project} keeps this copy, corami project rm ${project} --on client --force --yes removes it`;
  }

  return CONFLICT_RESOLUTION;
}

export function conflictCopies(session: ConflictSession): ConflictCopies[] {
  const serverRoot = endpointPath(session.alpha);

  return session.conflicts.map((path) => ({
    path,
    local: join(session.beta, path),
    server: posix.join(serverRoot, path),
  }));
}

export function endpointPath(endpoint: string): string {
  const separator = endpoint.indexOf(':');

  if (separator === -1) {
    return endpoint;
  }

  return endpoint.slice(separator + 1);
}
