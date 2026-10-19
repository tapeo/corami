import { basename, posix, win32 } from 'node:path';
import type { Role } from '@/core/config.ts';
import { serverProjectPath } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { git, gitOriginUrl } from '@/core/git.ts';
import { syncName } from '@/core/projects.ts';

export interface CwdRepository {
  root: string;
  origin?: string | undefined;
}

export async function repositoryAt(cwd: string): Promise<CwdRepository | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);

  if (!top.ok || top.stdout === '') {
    return undefined;
  }

  return { root: top.stdout, origin: await gitOriginUrl(top.stdout) };
}

export type AddFrom = 'git' | 'local' | 'server';

export interface ProjectAddState {
  role: Role | undefined;
  from: AddFrom;
  project: string;
  url?: string | undefined;
  localPath?: string | undefined;
  home?: string | undefined;
  explicitName?: string | undefined;
  serverPath?: string | undefined;
  registeredPath?: string | undefined;
  session?: string | undefined;
  sessionIsFolder?: boolean | undefined;
  cwdRepository?: CwdRepository | undefined;
}

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

  if ((state.from === 'git' || state.from === 'local') && state.registeredPath !== undefined) {
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

  if (state.session !== undefined && state.registeredPath === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `A sync session for ${state.project} already exists at ${state.session}, from a project removed from the server`,
      fix: `corami sync stop ${state.project} closes it and keeps its files, then add the project again`,
    });
  }
}

export function validServerPath(path: string): boolean {
  return posix.isAbsolute(path) || /^~\/[^/]/.test(path);
}

export function serverPathFrom(home: string, path: string): string {
  return path.startsWith('~/') ? posix.join(home, path.slice(2)) : path;
}

export function serverFolderOverlaps(path: string, others: string[]): boolean {
  const normalized = posix.normalize(path);

  return others.some((other) => {
    const folder = posix.normalize(other);

    return within(folder, normalized) || within(normalized, folder);
  });
}

export function serverPathsOf(projects: Array<{ path: string }>): string[] {
  return projects.map((project) => project.path);
}

export const IMPORT_STAGING_PREFIX = '.corami-import-';

export function importStagingPath(serverPath: string, project: string, stamp: string): string {
  const folder = posix.dirname(posix.normalize(serverPath));

  return posix.join(folder, `${IMPORT_STAGING_PREFIX}${project}-${stamp}`);
}

export function isImportStagingFor(serverPath: string, staging: string): boolean {
  const target = posix.normalize(serverPath);
  const candidate = posix.normalize(staging);
  const name = posix.basename(candidate);

  return (
    candidate !== target &&
    posix.dirname(candidate) === posix.dirname(target) &&
    name.startsWith(IMPORT_STAGING_PREFIX) &&
    name.length > IMPORT_STAGING_PREFIX.length
  );
}

export interface TakenServerFolder {
  serverPath: string;
  folder: string;
  remoteHead?: string | undefined;
  localHead?: string | undefined;
}

export function takenServerFolder(state: TakenServerFolder): CoramiError {
  const sameCommit =
    state.remoteHead !== undefined &&
    state.localHead !== undefined &&
    state.remoteHead === state.localHead;

  if (sameCommit) {
    return new CoramiError({
      code: 'usage',
      message: `The folder ${state.serverPath} is on the server, at the same commit as ${state.folder}, and no project names it: an import that stopped probably left it`,
      fix: `To keep the server copy, move ${state.folder} away, then corami project add ${state.folder} --from-server --server-path ${state.serverPath}. To import ${state.folder} again, remove ${state.serverPath} from the server first`,
    });
  }

  if (state.remoteHead !== undefined) {
    return new CoramiError({
      code: 'usage',
      message: `The folder ${state.serverPath} is on the server, a git repository that no project names`,
      fix: `To keep the server copy, move ${state.folder} away, then corami project add ${state.folder} --from-server --server-path ${state.serverPath}. To import ${state.folder} again, remove ${state.serverPath} from the server first`,
    });
  }

  return new CoramiError({
    code: 'usage',
    message: `The folder ${state.serverPath} is already on the server and is not empty`,
    fix: 'Name a free folder of the server with --server-path: the import writes only into a folder it makes',
  });
}

export interface OrphanServerFolders {
  unregistered: string[];
  staging: string[];
}

export function orphanServerFolders(entries: string[], projects: string[]): OrphanServerFolders {
  const known = projects.map((path) => posix.normalize(path));
  const unregistered: string[] = [];
  const staging: string[] = [];

  for (const entry of entries.map((path) => posix.normalize(path)).sort()) {
    if (known.some((path) => within(path, entry) || within(entry, path))) {
      continue;
    }

    const name = posix.basename(entry);

    if (name.startsWith(IMPORT_STAGING_PREFIX) && name.length > IMPORT_STAGING_PREFIX.length) {
      staging.push(entry);
    } else if (!name.startsWith('.')) {
      unregistered.push(entry);
    }
  }

  return { unregistered, staging };
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

export function movableLocalFolder(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const flavor = platform === 'win32' ? win32 : posix;

  if (withinLocal(flavor, flavor.normalize(path), flavor.normalize(home))) {
    throw new CoramiError({
      code: 'usage',
      message: `The home folder of this machine is not a project: ${path}`,
      fix: 'Name the folder of the project: corami project add <folder>',
    });
  }
}

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

export function defaultServerPath(name: string): string {
  return serverProjectPath('~', name);
}

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
