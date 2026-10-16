import { readdirSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * Whether `project rm` may delete the folder of a project on the server: only
 * the folders Corami created, inside the projects root. One registered with
 * `project add --path` lives elsewhere: it leaves the registry and stays on
 * disk, like the root itself and every path that leaves it.
 */
export function serverFolderRemoval(path: string, root: string): 'delete' | 'keep' {
  const relative = posix.relative(posix.normalize(root), posix.normalize(path));

  if (relative === '' || relative === '..' || relative.startsWith('../')) {
    return 'keep';
  }

  return 'delete';
}

/**
 * Whether the folder of a local copy exists and holds nothing. A path that is
 * a file, or that cannot be read, is not empty.
 */
export function isFolderEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * What to do with the folder of a local copy. A session for the project wins,
 * whatever is in the folder. Without one, a folder with something else in it
 * is not touched: the sync would mix the two trees. The caller turns
 * 'not-empty' into the usage error that says what to do.
 */
export function localCopyTarget(state: {
  session: boolean;
  exists: boolean;
  empty: boolean;
}): 'existing' | 'create' | 'not-empty' {
  if (state.session) {
    return 'existing';
  }

  if (state.exists && !state.empty) {
    return 'not-empty';
  }

  return 'create';
}
