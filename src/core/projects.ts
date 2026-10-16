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
