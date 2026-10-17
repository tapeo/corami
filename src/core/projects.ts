import { readdirSync } from 'node:fs';
import { isAbsolute, posix, relative, sep } from 'node:path';

/**
 * Whether `project rm` may delete the folder of a project on the server: only
 * the folders Corami created, inside the projects root. One registered with
 * `project add --path` lives elsewhere: it leaves the registry and stays on
 * disk, like the root itself and every path that leaves it. A path that is
 * not absolute is kept: it would depend on the folder the daemon runs in.
 */
export function serverFolderRemoval(path: string, root: string): 'delete' | 'keep' {
  if (!posix.isAbsolute(path) || !posix.isAbsolute(root)) {
    return 'keep';
  }

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
 * Whether a path still starts with `~`: the shell expands it, a command run
 * without one passes it as it is, and resolving it would create a folder
 * named `~` in the working directory.
 */
export function unexpandedHome(path: string): boolean {
  return path.startsWith('~');
}

export type LocalCopyTarget = 'existing' | 'create' | 'move' | 'missing' | 'nested' | 'not-empty';

/**
 * What to do with the folder of a local copy. The folder is never guessed: it
 * is the one of the session of the project, or the one asked with `--path`.
 * A session wins, and a different folder asked for it is a move the caller
 * refuses. Without a session, a folder inside the copy of another project,
 * or around it, would sync into that project; a folder with something else
 * in it is not touched, the sync would mix the two trees. Paths come in
 * absolute and in the same form, the caller turns every state but 'existing'
 * and 'create' into the usage error that says what to do.
 */
export function localCopyTarget(state: {
  /** `--path`, undefined without the flag. */
  requested?: string | undefined;
  /** The folder of the session of the project, when there is one. */
  session?: string | undefined;
  /** The folders of the sessions of the other projects. */
  others: string[];
  exists: boolean;
  empty: boolean;
}): LocalCopyTarget {
  if (state.session !== undefined) {
    return state.requested === undefined || state.requested === state.session ? 'existing' : 'move';
  }

  const requested = state.requested;

  if (requested === undefined) {
    return 'missing';
  }

  if (state.others.some((other) => isWithin(requested, other) || isWithin(other, requested))) {
    return 'nested';
  }

  if (state.exists && !state.empty) {
    return 'not-empty';
  }

  return 'create';
}

/**
 * The project of the local copy that holds `path`: the session whose folder
 * contains it, the deepest one when copies sit inside each other. Paths
 * absolute and in the same form.
 */
export function projectOfCopy(
  path: string,
  copies: Array<{ project: string; local: string }>,
): string | undefined {
  return copies
    .filter((copy) => isWithin(path, copy.local))
    .sort((left, right) => right.local.length - left.local.length)[0]?.project;
}

/** Whether `path` is `folder` or inside it. Both absolute, in the same form. */
export function isWithin(path: string, folder: string): boolean {
  const between = relative(folder, path);

  return (
    between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
  );
}

/**
 * The projects of the server with the copy of this machine, if there is one,
 * plus the copies whose project is not on the server: a project removed from
 * another client leaves the session of this one behind.
 */
export function withLocalCopies<T extends { name: string }>(
  projects: T[],
  sessions: Array<{ project: string; local: string }>,
): {
  projects: Array<T & { local_copy: string | null }>;
  orphan_copies: Array<{ project: string; local: string }>;
} {
  const copies = new Map(sessions.map((session) => [session.project, session.local]));
  const names = new Set(projects.map((project) => project.name));

  return {
    projects: projects.map((project) => ({
      ...project,
      local_copy: copies.get(project.name) ?? null,
    })),
    orphan_copies: sessions
      .filter((session) => !names.has(session.project))
      .map((session) => ({ project: session.project, local: session.local }))
      .sort((left, right) => left.project.localeCompare(right.project)),
  };
}
