import { basename, posix, win32 } from 'node:path';
import type { Role } from '@/core/config.ts';
import { serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { git, gitOriginUrl } from '@/core/git.ts';
import { syncName } from '@/core/projects.ts';

/** The repository the command runs in: its root, and the url of `origin`. */
export interface CwdRepository {
  root: string;
  origin?: string | undefined;
}

/**
 * The repository that contains `cwd`, the root and the url of its `origin`.
 * A folder of the server that is only registered has a path of the server, but
 * this reads this machine: the import check is about a clone that is really
 * here.
 */
export async function repositoryAt(cwd: string): Promise<CwdRepository | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);

  if (!top.ok || top.stdout === '') {
    return undefined;
  }

  return { root: top.stdout, origin: await gitOriginUrl(top.stdout) };
}

/** Where the project comes from: a repository, this machine, or the server. */
export type AddFrom = 'git' | 'local' | 'server';

export interface ProjectAddState {
  role: Role | undefined;
  from: AddFrom;
  /** The name of the project: given, prompted, or derived from the origin. */
  project: string;
  url?: string | undefined;
  /** The folder of this machine that moves with the import: it goes to the server. */
  localPath?: string | undefined;
  /** The home folder of this machine: the one folder the import never moves. */
  home?: string | undefined;
  /** The name given with `--name`: the checks give it back in their fix. */
  explicitName?: string | undefined;
  /** The path asked with `--server-path`, when the flag was given. */
  serverPath?: string | undefined;
  /** The path on the server, when a project of that name is registered. */
  registeredPath?: string | undefined;
  /** The folder of a session of the sync engine that already carries the name. */
  session?: string | undefined;
  /** Whether the folder given as the copy is the folder of that session. */
  sessionIsFolder?: boolean | undefined;
  cwdRepository?: CwdRepository | undefined;
}

/**
 * Whether `project add` may go on. It registers the project on the server and
 * leaves the copy of this machine with its session: every source ends with
 * both, so the command only runs on a client. Nothing here touches the disk or
 * the network: the command gathers the state and asks, and every stop is a
 * usage error that says what to do.
 */
export function planProjectAdd(state: ProjectAddState): void {
  const name = state.explicitName === undefined ? '' : ` --name ${state.explicitName}`;
  const folder = state.localPath ?? '<folder>';

  if (state.role !== 'client') {
    throw new CoramiError({
      code: 'usage',
      message:
        'corami project add registers the project on the server and creates the copy of this machine',
      fix: 'Run it from a client: the copy of a project lives on the machines that work on it',
    });
  }

  // The project is registered somewhere else on the server: that path is the
  // source, not the one the default suggests.
  if (
    state.from === 'server' &&
    state.serverPath !== undefined &&
    state.registeredPath !== undefined &&
    state.serverPath !== state.registeredPath
  ) {
    throw new CoramiError({
      code: 'usage',
      message: `${state.project} is registered on the server at ${state.registeredPath}`,
      fix: `corami project add ${folder} --from-server takes the copy of the registered project`,
    });
  }

  // The name is taken: what is left to add is the copy of this machine.
  if ((state.from === 'git' || state.from === 'local') && state.registeredPath !== undefined) {
    // The copy of the registered project is already here: the session says
    // where, and adding the project again would sync one folder twice.
    if (state.session !== undefined) {
      if (state.sessionIsFolder === true) {
        throw new CoramiError({
          code: 'usage',
          message: `${state.project} is already on the server at ${state.registeredPath}, and this folder is its copy: ${state.session}`,
          fix: `Nothing to add: corami sync status ${state.project} shows the copy`,
        });
      }

      throw new CoramiError({
        code: 'usage',
        message: `${state.project} is already on the server at ${state.registeredPath}, and its copy on this machine is ${state.session}`,
        fix: `corami project add ${folder} --name <other> imports this folder as another project`,
      });
    }

    throw new CoramiError({
      code: 'usage',
      message: `A project named ${state.project} is already on the server: ${state.registeredPath}`,
      fix: `Move ${folder} away if it has files, then corami project add ${folder} --from-server --name ${state.project} takes its copy`,
    });
  }

  // The project of this folder is already here: the import converts it instead
  // of cloning a second one.
  if (state.from === 'git' && state.url !== undefined) {
    const origin = state.cwdRepository?.origin;

    if (origin !== undefined && sameRepository(origin, state.url)) {
      const root = state.cwdRepository?.root ?? '.';

      throw new CoramiError({
        code: 'usage',
        message: `This machine already has a clone of ${state.url}: ${root}`,
        fix: `corami project add ${root}${name} instead: it copies that folder to the server and turns it into the synced copy`,
      });
    }
  }

  if (state.from === 'local' && state.localPath !== undefined && state.home !== undefined) {
    movableLocalFolder(state.localPath, state.home);
  }

  // A session for the name, while the project is not on the server: the copy
  // of a project that was removed. It points at the folder of the new copy,
  // and would reconcile an older copy with the new one as soon as it is there.
  if (state.session !== undefined && state.registeredPath === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `A sync session for ${state.project} already exists at ${state.session}, from a project removed from the server`,
      fix: `corami sync stop ${state.project} closes it and keeps its files, then add the project again`,
    });
  }
}

/**
 * A folder of the server: absolute, or starting with `~/` that the server
 * expands. Everything else would be resolved on the wrong machine.
 */
export function validServerPath(path: string): boolean {
  return posix.isAbsolute(path) || /^~\/[^/]/.test(path);
}

/** The path asked for on the server, with `~` expanded against its home. */
export function serverPathFrom(home: string, path: string): string {
  return path.startsWith('~/') ? posix.join(home, path.slice(2)) : path;
}

/**
 * Whether a folder of the server overlaps the folder of another project: the
 * same folder, one inside the other. The two would sync the same files. Paths
 * absolute, with `~` already expanded.
 */
export function serverFolderOverlaps(path: string, others: string[]): boolean {
  const normalized = posix.normalize(path);

  return others.some((other) => {
    const folder = posix.normalize(other);

    return within(folder, normalized) || within(normalized, folder);
  });
}

/** The folders of the projects of the server, as the daemon announces them. */
export function serverPathsOf(projects: Array<{ path: string }>): string[] {
  return projects.map((project) => project.path);
}

function withinLocal(flavor: typeof posix, folder: string, path: string): boolean {
  const between = flavor.relative(folder, path);

  return (
    between === '' ||
    (between !== '..' && !between.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(between))
  );
}

function within(folder: string, path: string): boolean {
  const between = posix.relative(folder, path);

  return (
    between === '' || (between !== '..' && !between.startsWith('../') && !posix.isAbsolute(between))
  );
}

/**
 * Whether this machine can give the folder up: the folder is copied to the
 * server with its files, the keys included, and the home of this machine is
 * not a project. A folder inside the home is one.
 */
export function movableLocalFolder(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // The folder of this machine is read with the rules of this machine: on
  // Windows `C:\Users\me` is not a path of a POSIX folder.
  const flavor = platform === 'win32' ? win32 : posix;

  if (withinLocal(flavor, flavor.normalize(path), flavor.normalize(home))) {
    throw new CoramiError({
      code: 'usage',
      message: `The home folder of this machine is not a project: ${path}`,
      fix: 'Name the folder of the project: corami project add <folder>',
    });
  }
}

/**
 * A folder to import that is not on this machine: there is nothing to copy, so
 * the command stops and the fix names the source that does not need it. A
 * registered project is taken from the server, or the folder comes from a
 * repository; neither is guessed.
 */
export function missingImportFolder(state: {
  given: string;
  project?: string | undefined;
  registeredPath?: string | undefined;
}): CoramiError {
  if (state.project !== undefined && state.registeredPath !== undefined) {
    return new CoramiError({
      code: 'usage',
      message: `There is no folder ${state.given} on this machine, and ${state.project} is already on the server`,
      fix: `corami project add ${state.given} --from-server --name ${state.project} takes its copy`,
    });
  }

  return new CoramiError({
    code: 'usage',
    message: `There is no folder ${state.given} on this machine: there is nothing to import`,
    fix: `corami project add ${state.given} --from-git <url> clones a repository on the server, or corami project add ${state.given} --from-server takes a folder that is already there`,
  });
}

/** The folder of the project on the server without `--server-path`. */
export function defaultServerPath(name: string): string {
  return serverProjectPath('~', name);
}

/**
 * The name to suggest, without asking: the one given, the one derived from the
 * url, from the folder of the server or from the folder of this machine.
 */
export function suggestedProjectName(state: {
  name?: string | undefined;
  url?: string | undefined;
  serverPath?: string | undefined;
  localPath?: string | undefined;
}): string | undefined {
  if (state.name !== undefined) {
    return state.name;
  }

  if (state.url !== undefined) {
    try {
      return syncName(projectNameFromUrl(state.url));
    } catch {
      return undefined;
    }
  }

  const folder = state.serverPath ?? state.localPath;

  if (folder === undefined) {
    return undefined;
  }

  const last = syncName(basename(folder.replace(/\/+$/, '')));

  return last === '' || last === '.' ? undefined : last;
}

/** The name of a project cloned from a url: the last part of its path. */
export function projectNameFromUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  const parts = cleaned.split(/[/:]/);
  const last = parts.at(-1);

  if (last === undefined || last === '') {
    throw new CoramiError({
      code: 'usage',
      message: `Cannot derive a project name from ${url}`,
      fix: 'Pass --name <name>',
    });
  }

  return last;
}

/**
 * Whether two urls of a git remote name the same repository. The form does not
 * matter: `git@host:owner/repo`, `ssh://git@host:port/owner/repo` and
 * `https://host/owner/repo` are one identity of host and path, without the
 * user, the port and a trailing `.git`. The host is compared in lower case,
 * the path as it is: git servers can tell two paths apart by case.
 */
export function sameRepository(left: string, right: string): boolean {
  const first = remoteIdentity(left);
  const second = remoteIdentity(right);

  if (first !== undefined || second !== undefined) {
    return (
      first !== undefined &&
      second !== undefined &&
      first.host === second.host &&
      first.path === second.path
    );
  }

  // Two local paths: same folder, same repository.
  return cleanPath(left) === cleanPath(right);
}

interface RemoteIdentity {
  host: string;
  path: string;
}

function remoteIdentity(url: string): RemoteIdentity | undefined {
  const trimmed = url.trim();
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);

  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() === 'file') {
      return undefined;
    }

    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');

    if (slash === -1) {
      return undefined;
    }

    const authority = rest.slice(0, slash);
    const at = authority.lastIndexOf('@');
    const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, '');

    return { host: host.toLowerCase(), path: cleanPath(rest.slice(slash + 1)) };
  }

  // The scp form, with or without the user: `git@host:owner/repo`.
  const scp = trimmed.match(/^([^/@:]+@)?([^/:]+):(.+)$/);

  if (scp !== null && !trimmed.startsWith('/') && !trimmed.startsWith('~')) {
    return { host: (scp[2] ?? '').toLowerCase(), path: cleanPath(scp[3] ?? '') };
  }

  return undefined;
}

function cleanPath(path: string): string {
  return path
    .replace(/^file:\/\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}
