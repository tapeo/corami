import type { Role } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { git, gitOriginUrl } from '@/core/git.ts';

/** The repository the command runs in: its root, and the url of `origin`. */
export interface CwdRepository {
  root: string;
  origin?: string | undefined;
}

/**
 * The repository that contains `cwd`, the root and the url of its `origin`.
 * A folder of the server that is only registered with `--path` has a path of
 * the server, but this reads this machine: the import check is about a clone
 * that is really here.
 */
export async function repositoryAt(cwd: string): Promise<CwdRepository | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);

  if (!top.ok || top.stdout === '') {
    return undefined;
  }

  return { root: top.stdout, origin: await gitOriginUrl(top.stdout) };
}

export interface ProjectAddState {
  role: Role | undefined;
  /** The name of the project, given or derived from the url. */
  project: string;
  url?: string | undefined;
  /** The folder registered with `--path`: the server only. */
  path?: string | undefined;
  /** The name given with `--name`: the fix of the import check gives it back. */
  explicitName?: string | undefined;
  cwdRepository?: CwdRepository | undefined;
  /** The folder of a session of the sync engine that already carries the name. */
  session?: string | undefined;
  /** Whether the server already has a project with the name. */
  onServer: boolean;
}

/**
 * Whether `project add` may go on. It only adds the project on the server:
 * the copy of a client comes from `sync add`, with the folder it is given.
 * Nothing here touches the disk or the network: the command gathers the state
 * and asks, and every stop is a usage error that says what to do.
 */
export function planProjectAdd(state: ProjectAddState): void {
  const name = state.explicitName === undefined ? '' : ` --name ${state.explicitName}`;

  // A folder of the server cannot be registered from a client: the path would
  // be resolved on the wrong machine.
  if (state.path !== undefined && state.role === 'client') {
    throw new CoramiError({
      code: 'usage',
      message: '--path registers a folder that is already on the server',
      fix: 'corami project import <folder> to move a folder of this machine to the server',
    });
  }

  if (state.role !== 'client' || state.url === undefined) {
    return;
  }

  // The project of this folder is already here: the import converts it instead
  // of leaving it aside, and a copy made later would be a second one.
  const origin = state.cwdRepository?.origin;

  if (origin !== undefined && sameRepository(origin, state.url)) {
    const root = state.cwdRepository?.root ?? '.';

    throw new CoramiError({
      code: 'usage',
      message: `This machine already has a clone of ${state.url}: ${root}`,
      fix: `corami project import ${root}${name} instead: it moves that folder to the server and turns it into the synced copy`,
    });
  }

  // A session for the name, while the project is not on the server: the copy
  // of a project that was removed. It points at the folder the new clone goes
  // to, and would reconcile an older copy with a fresh clone as soon as it is
  // there. A project that is on the server is refused by the server itself.
  if (state.session !== undefined && !state.onServer) {
    throw new CoramiError({
      code: 'usage',
      message: `A sync session for ${state.project} already exists at ${state.session}, from a project removed from the server`,
      fix: `corami sync stop ${state.project} closes it and keeps its files, then add the project again`,
    });
  }
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
