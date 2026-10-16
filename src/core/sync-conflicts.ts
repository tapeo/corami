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
