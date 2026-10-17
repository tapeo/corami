import { readdirSync } from 'node:fs';
import { isAbsolute, posix, relative, sep } from 'node:path';

/**
 * A project name as the daemon reads it, for a project that already exists:
 * it may carry a dot or an underscore, as the names of projects created before
 * the rule of `NEW_PROJECT_NAME_PATTERN`.
 */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A project name this machine can create: the session of the sync engine is
 * named after it, and the engine takes letters, digits and dashes, starting
 * with a letter. A name with a dot or an underscore would pass every other
 * check and stop at `mutagen sync create`, after the project is on the server.
 */
export const NEW_PROJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Whether a name can key a project. The name becomes `~/projects/<name>` on
 * the server, so a separator, a `..` or an empty name would point the folder
 * of one project at another one. The rule is the same on every side: it is
 * checked here, on the client before the request and on the daemon after it.
 *
 * A name of a project that already exists is still accepted: the routes of the
 * daemon read and remove it, and a project created before this rule keeps its
 * name until it is removed.
 */
export function validProjectName(name: string): boolean {
  return PROJECT_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

/** Whether a name can be given to a new project, whose session must exist. */
export function validNewProjectName(name: string): boolean {
  return NEW_PROJECT_NAME_PATTERN.test(name);
}

/**
 * A name as the sync engine takes it: a project folder may carry a dot or an
 * underscore, and the session can only be named after letters, digits and
 * dashes. The suggested name is the folder turned into one, so that the
 * command goes through without a second question.
 */
export function syncName(name: string): string {
  return name
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Whether `project rm --on server` may delete the folder of a project on the
 * server. Kept for the database written before the registry remembered who
 * made the folder: the rule of the day was "inside the projects root, Corami
 * made it". Today the `owned` column of the registry answers, and a path that
 * is not absolute is kept: it would depend on the folder the daemon runs in.
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
 * is the one of the session of the project, or the one given as the argument.
 * A session wins, and a different folder asked for it is a move the caller
 * refuses. Without a session, a folder inside the copy of
 * another project, or around it, would sync into that project; a folder with
 * something else in it is not touched, the sync would mix the two trees. Paths
 * come in absolute and in the same form, the caller turns every state but
 * 'existing' and 'create' into the usage error that says what to do.
 */
export function localCopyTarget(state: {
  /** The folder given as the argument, undefined without one. */
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
