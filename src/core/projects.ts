import { readdirSync } from 'node:fs';
import { isAbsolute, posix, relative, sep } from 'node:path';

export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const NEW_PROJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export function validProjectName(name: string): boolean {
  return PROJECT_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

export function validNewProjectName(name: string): boolean {
  return NEW_PROJECT_NAME_PATTERN.test(name);
}

export function syncName(name: string): string {
  return name
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

export function isFolderEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

export function unexpandedHome(path: string): boolean {
  return path.startsWith('~');
}

export type LocalCopyTarget = 'existing' | 'create' | 'move' | 'missing' | 'nested' | 'not-empty';

export function localCopyTarget(state: {
  requested?: string | undefined;
  session?: string | undefined;
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

export function projectOfCopy(
  path: string,
  copies: Array<{ project: string; local: string }>,
): string | undefined {
  return copies
    .filter((copy) => isWithin(path, copy.local))
    .sort((left, right) => right.local.length - left.local.length)[0]?.project;
}

export function isWithin(path: string, folder: string): boolean {
  const between = relative(folder, path);

  return (
    between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
  );
}

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
