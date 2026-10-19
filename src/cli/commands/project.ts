import { existsSync } from 'node:fs';
import type { CommandContext, CommandResult, CommandSpec } from '@/cli/command.ts';
import { runImport } from '@/cli/commands/import.ts';
import {
  canonicalPath,
  copyPlace,
  createLocalCopy,
  givenPath,
  removeLocalCopy,
  syncSessions,
  syncUpdate,
  waitFirstSync,
} from '@/cli/commands/sync.ts';
import { renderOrphanCopies, renderTable } from '@/cli/output.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import { type ProgressUpdate, progressFor } from '@/cli/progress.ts';
import { canPrompt, terminalPrompter } from '@/cli/prompt.ts';
import {
  addProject,
  findProject,
  listProjects,
  type ProjectSummary,
  projectDetail,
  removeProject,
} from '@/cli/server-client.ts';
import { homeDirectory, readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import type { GitProgress } from '@/core/git.ts';
import {
  type AddFrom,
  type CwdRepository,
  defaultServerPath,
  missingImportFolder,
  planProjectAdd,
  repositoryAt,
  suggestedProjectName,
  validServerPath,
} from '@/core/project-add.ts';
import { validNewProjectName, withLocalCopies } from '@/core/projects.ts';
import { MutagenEngine, type SyncProgress } from '@/integrations/mutagen.ts';

async function ls(context: CommandContext): Promise<CommandResult> {
  const projects = await listProjects();
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const onClient = role === 'client';
  const sessions = onClient ? await new MutagenEngine().sessions() : undefined;
  const listed =
    sessions === undefined
      ? undefined
      : withLocalCopies(
          projects,
          sessions.map((session) => ({ project: session.project, local: session.beta })),
        );

  if (context.output.json) {
    if (!onClient) {
      return { data: { projects } };
    }

    if (listed === undefined) {
      return { data: { projects, local_copies: 'unavailable' } };
    }

    return { data: listed };
  }

  const rows = (listed?.projects ?? projects).map((project) => ({
    name: project.name,
    path: project.path,
    previews: project.previews.length,
    responding: project.previews.filter((preview) => preview.responding).length,
    local:
      'local_copy' in project && typeof project.local_copy === 'string' ? project.local_copy : '-',
  }));
  type Row = (typeof rows)[number];
  const columns: Array<{ header: string; value: (row: Row) => string }> = [
    { header: 'Project', value: (row) => row.name },
    { header: 'Path', value: (row) => row.path },
    { header: 'Previews', value: (row) => String(row.previews) },
    { header: 'Responding', value: (row) => String(row.responding) },
  ];

  if (onClient) {
    columns.push({ header: 'Local', value: (row) => row.local });
  }

  const lines = [
    projects.length === 0
      ? 'No projects. Add one with corami project add <folder>.'
      : renderTable(rows, columns),
  ];

  if (onClient && sessions === undefined) {
    lines.push('Mutagen did not answer: the local copies of this machine are not shown.');
  }

  if (listed !== undefined) {
    lines.push(...renderOrphanCopies(listed.orphan_copies));
  }

  return { text: lines.join('\n') };
}

async function show(context: CommandContext): Promise<CommandResult> {
  const target = context.args.positionals[0];

  if (target === undefined || target === '.') {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project name',
      fix: 'corami project show <name>, or corami project ls to list them',
    });
  }

  const detail = await projectDetail(target);

  if (context.output.json) {
    return { data: detail };
  }

  return { text: renderDetail(detail) };
}

function renderDetail(detail: Record<string, unknown>): string {
  const name = String(detail.name ?? '');
  const path = String(detail.path ?? '');
  const lines = [name, `Path: ${path}`];
  const previews = Array.isArray(detail.previews) ? detail.previews : [];

  for (const entry of previews as Array<Record<string, unknown>>) {
    const url = entry.url === null || entry.url === undefined ? '(no public name)' : entry.url;
    const state = entry.responding === true ? 'responding' : 'not responding';
    lines.push(
      `preview ${String(entry.name ?? '')}: ${url} -> 127.0.0.1:${String(entry.target_port)} [${state}]`,
    );
  }

  return lines.join('\n');
}

function sourceOf(url: string | undefined, server: boolean): AddFrom {
  if (url !== undefined && server) {
    throw new CoramiError({
      code: 'usage',
      message: 'Give only one of --from-git or --from-server',
      fix: 'They say where the project comes from: a repository, or the server. Without both, it is a folder of this machine',
    });
  }

  if (url !== undefined) {
    return 'git';
  }

  if (server) {
    return 'server';
  }

  return 'local';
}

function addForm(from: AddFrom, folder: string, url: string | undefined): string {
  if (from === 'git') {
    return `corami project add ${folder} --from-git ${url ?? '<url>'}`;
  }

  if (from === 'server') {
    return `corami project add ${folder} --from-server`;
  }

  return `corami project add ${folder}`;
}

async function add(context: CommandContext): Promise<CommandResult> {
  const config = await readGlobalConfig().catch(() => undefined);
  const prompter = canPrompt(context.output) ? terminalPrompter() : undefined;
  const progress = progressFor(context.output);
  const dryRun = booleanFlag(context.args, 'dry-run');
  const user = stringFlag(context.args, 'user');
  const noGit = negatedFlag(context.args, 'git');
  const cwd = process.cwd();
  const urlFlag = stringFlag(context.args, 'from-git');
  const serverFlag = stringFlag(context.args, 'server-path');
  const nameFlag = stringFlag(context.args, 'name');
  const folderArg = context.args.positionals[0];

  if (folderArg === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing folder',
      fix: 'corami project add <folder> imports a folder of this machine, --from-git <url> clones a repository on the server, --from-server takes a folder that is already there',
    });
  }

  const localPath = givenPath(folderArg);
  const from = sourceOf(urlFlag, booleanFlag(context.args, 'from-server'));

  if (from === 'local' && noGit) {
    throw new CoramiError({
      code: 'usage',
      message: '--no-git does not apply to the import',
      fix: 'The .git of the folder travels with it, and the copy keeps its own',
    });
  }

  let url = urlFlag;

  if (from === 'git' && url === undefined) {
    if (prompter === undefined) {
      throw new CoramiError({
        code: 'usage',
        message: 'Missing --from-git <url>',
        fix: addForm(from, folderArg, url),
      });
    }

    url = await prompter.ask('Repository url');

    if (url === '') {
      throw new CoramiError({ code: 'usage', message: 'Missing repository url' });
    }
  }

  let cwdRepository: CwdRepository | undefined;

  if (from === 'git') {
    cwdRepository = await repositoryAt(cwd);
  }

  let name = nameFlag;
  const suggested = suggestedProjectName({
    url,
    serverPath: serverFlag,
    localPath,
  });

  if (from === 'local' && !existsSync(localPath)) {
    const project = name ?? suggested;
    const registered = project === undefined ? undefined : (await findProject(project))?.path;

    throw missingImportFolder({ given: folderArg, project, registeredPath: registered });
  }

  if (name === undefined) {
    if (prompter === undefined) {
      name = suggested;
    } else {
      name = await prompter.ask('Project name', suggested ?? '');
    }
  }

  if (name === undefined || name === '') {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing --name',
      fix: `${addForm(from, folderArg, url)} --name <name> chooses it`,
    });
  }

  if (!validNewProjectName(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${name}`,
      fix: 'A project name starts with a letter and goes on with letters, digits and dashes: --name chooses another one',
    });
  }

  const registeredPath = (await findProject(name))?.path;

  const serverDefault = defaultServerPath(name);
  let serverArg =
    serverFlag ?? (from === 'server' && registeredPath !== undefined ? registeredPath : undefined);

  if (serverArg === undefined) {
    if (prompter === undefined) {
      serverArg = serverDefault;
    } else {
      serverArg = await prompter.ask(
        `Server path (${config?.server_host ?? 'server'})`,
        serverDefault,
      );
    }
  }

  if (!validServerPath(serverArg)) {
    throw new CoramiError({
      code: 'usage',
      message: `The folder of the server is absolute or starts with ~/: ${serverArg}`,
      fix: 'Give it as the server sees it, for example ~/projects/myapp',
    });
  }

  const engine = new MutagenEngine();
  const onClient = config?.role === 'client';
  const sessions = onClient
    ? await progress.wait('name', 'Reading the copies of this machine', () => syncSessions(engine))
    : [];
  const session = sessions.find((entry) => entry.project === name)?.beta;

  planProjectAdd({
    role: config?.role,
    from,
    project: name,
    url,
    localPath,
    home: homeDirectory(),
    explicitName: nameFlag,
    serverPath: serverFlag,
    registeredPath,
    session,
    sessionIsFolder:
      session !== undefined &&
      localPath !== undefined &&
      canonicalPath(session) === canonicalPath(localPath),
    cwdRepository,
  });

  const place = await progress.wait('name', 'Choosing the folder of the copy', () =>
    copyPlace(engine, name, localPath, from === 'local'),
  );
  const target = from === 'server' && registeredPath !== undefined ? registeredPath : serverArg;

  if (dryRun) {
    return planAdd({
      context,
      from,
      name,
      url,
      target,
      place,
      registered: registeredPath !== undefined,
    });
  }

  if (from === 'local') {
    return runImport({
      project: name,
      localPath: place.local,
      serverPath: target,
      user,
      dryRun: false,
      output: context.output,
      progress,
    });
  }

  let registered = false;

  if (from === 'git') {
    if (url === undefined) {
      throw new CoramiError({ code: 'usage', message: 'Missing repository url' });
    }

    await progress.wait('clone', 'Cloning the repository on the server', () =>
      addProject({ name, url, path: target }),
    );
    registered = true;
  } else if (registeredPath === undefined) {
    await progress.wait('register', 'Registering the project', () =>
      addProject({ name, path: target }),
    );
    registered = true;
  }

  let copy: Awaited<ReturnType<typeof createLocalCopy>>;

  try {
    copy = await progress.count('sync', 'Creating the local copy', 'objects', (update) =>
      createLocalCopy({
        project: name,
        localPath: place.local,
        serverPath: target,
        user,
        git: !noGit,
        engine,
        onGitProgress: (git) => update(gitUpdate(git)),
      }),
    );
  } catch (error) {
    throw await copyFailure({ error, name, target, registered, localPath: place.local });
  }

  const firstSync = progress.interactive
    ? await progress.count('first-sync', 'Waiting for the first sync', 'files', (update) =>
        waitFirstSync(engine, name, (state) => update(syncUpdate(state))),
      )
    : undefined;

  if (context.output.json) {
    return {
      data: {
        project: name,
        from,
        server_path: target,
        local_path: copy.local,
        registered,
        local_copy: { created: copy.created, git: copy.git },
      },
    };
  }

  const lines: string[] = [];

  if (from === 'git') {
    lines.push(`Project ${name} cloned on the server at ${target}.`);
  } else if (registered) {
    lines.push(`Project ${name} registered on the server at ${target}.`);
  } else {
    lines.push(`Project ${name} is on the server at ${target}.`);
  }

  lines.push(
    copy.created ? `Local copy at ${copy.local}.` : `Local copy already at ${copy.local}.`,
  );
  lines.push(`git: ${copy.git.summary}`);

  if (copy.git.detail !== undefined) {
    lines.push(`  ${copy.git.detail}`);
  }

  if (firstSync !== undefined) {
    lines.push(describeFirstSync(firstSync));
  }

  return { text: lines.join('\n') };
}

function describeFirstSync(progress: SyncProgress): string {
  if (progress.state === 'done') {
    const files = progress.files ?? 0;

    return `First sync complete: ${files} ${files === 1 ? 'file' : 'files'}.`;
  }

  if (progress.state === 'halted') {
    return `First sync stopped: ${progress.activity}.`;
  }

  return 'First sync still running: corami sync status shows it.';
}

function gitUpdate(progress: GitProgress): ProgressUpdate {
  if (progress.done !== undefined && progress.total !== undefined && progress.total > 0) {
    return { done: progress.done, total: progress.total, activity: progress.phase };
  }

  return { done: 0, total: undefined, activity: progress.phase };
}

interface PlanInput {
  context: CommandContext;
  from: AddFrom;
  name: string;
  url: string | undefined;
  target: string;
  place: { session: unknown; local: string };
  registered: boolean;
}

function planAdd(input: PlanInput): CommandResult {
  const { context, from, name, url, target, place, registered } = input;
  const lines: string[] = [];

  if (from === 'git') {
    lines.push(`Clone ${url ?? ''} on the server at ${target}.`);
  } else if (from === 'local') {
    lines.push(`Copy ${place.local} to the server at ${target}: it stays here as the synced copy.`);
  } else if (registered) {
    lines.push(`Project ${name} is on the server at ${target}: only its copy is added.`);
  } else {
    lines.push(`Register the folder ${target} on the server as ${name}.`);
  }

  lines.push(`Local copy at ${place.local}.`);
  lines.push('Nothing done (--dry-run).');

  if (context.output.json) {
    return {
      data: {
        project: name,
        from,
        server_path: target,
        local_path: place.local,
        registered,
        existing_copy: place.session !== undefined,
        dry_run: true,
      },
    };
  }

  return { text: lines.join('\n') };
}

async function copyFailure(input: {
  error: unknown;
  name: string;
  target: string;
  registered: boolean;
  localPath: string;
}): Promise<CoramiError> {
  const code = input.error instanceof CoramiError ? input.error.code : 'generic';
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const fix = input.error instanceof CoramiError ? input.error.fix : undefined;

  if (!input.registered) {
    return new CoramiError({ code, message, fix });
  }

  const cleared = await removeProject(input.name).then(
    () => true,
    () => false,
  );

  return new CoramiError({
    code,
    message: `${message}. ${
      cleared
        ? 'The project was taken off the server again: nothing is left there without a copy'
        : `The project stays on the server at ${input.target}, with no copy of this machine`
    }`,
    fix: cleared
      ? (fix ?? 'Run the command again')
      : `corami project rm ${input.name} --on server --yes removes it, then run the command again`,
  });
}

async function rm(context: CommandContext): Promise<CommandResult> {
  const name = context.args.positionals[0];
  const on = stringFlag(context.args, 'on');

  if (name === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project name',
      fix: 'corami project rm <name> --on client removes the copy of this machine, --on server removes the project from the server',
    });
  }

  if (on !== 'client' && on !== 'server') {
    throw new CoramiError({
      code: 'usage',
      message:
        on === undefined
          ? `Missing --on: the copy of ${name} and the project on the server are removed apart`
          : `Unknown --on ${on}`,
      fix: `corami project rm ${name} --on client removes the copy of this machine, --on server removes the project from the server`,
    });
  }

  if (on === 'server' && booleanFlag(context.args, 'force')) {
    throw new CoramiError({
      code: 'usage',
      message: '--force applies to the copy of this machine',
      fix: `corami project rm ${name} --on client --force`,
    });
  }

  if (on === 'server' && booleanFlag(context.args, 'dry-run')) {
    throw new CoramiError({
      code: 'usage',
      message: '--dry-run applies to the copy of this machine',
      fix: `corami project ls shows the project, corami project rm ${name} --on client --dry-run the copy`,
    });
  }

  if (on === 'client') {
    if (!booleanFlag(context.args, 'dry-run') && !booleanFlag(context.args, 'yes')) {
      throw new CoramiError({
        code: 'usage',
        message: `Confirmation required to remove the copy of ${name}`,
        fix: `Run corami project rm ${name} --on client --yes`,
      });
    }

    return removeLocalCopy(name, context);
  }

  if (!booleanFlag(context.args, 'yes')) {
    throw new CoramiError({
      code: 'usage',
      message: `Confirmation required to remove ${name}`,
      fix: `Run corami project rm ${name} --on server --yes`,
    });
  }

  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const engine = new MutagenEngine();
  const session =
    role === 'client'
      ? (await syncSessions(engine)).find((entry) => entry.project === name)
      : undefined;

  if (session !== undefined) {
    await engine.terminate(name);
  }

  let result: Record<string, unknown>;

  try {
    result = await removeProject(name);
  } catch (error) {
    if (session === undefined) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new CoramiError({
      code: error instanceof CoramiError ? error.code : 'generic',
      message: `${message}. The sync of this machine is closed, the files stay at ${session.beta}`,
      fix: `Run corami project rm ${name} --on server --yes again`,
    });
  }

  const keptFolder = result.folder === 'kept' && typeof result.path === 'string';
  const localCopy = session === undefined ? null : { local: session.beta, session_closed: true };

  if (context.output.json) {
    return { data: { ...result, local_copy: localCopy } };
  }

  const lines = [`Project ${name} removed from the server.`];

  if (keptFolder) {
    lines.push(`Folder kept at ${result.path}: it was registered where it was.`);
  }

  if (localCopy !== null) {
    lines.push(`Local files kept at ${localCopy.local}: the sync of this machine is closed.`);

    if (!keptFolder) {
      lines.push(
        'They are now the only copy of the uncommitted work. Remove that folder before adding the project again with the same name.',
      );
    }
  }

  return { text: lines.join('\n') };
}

const NAME_FLAG = { name: 'name', value: 'name', description: 'Project name on the server' };
const DRY_RUN_FLAG = { name: 'dry-run', description: 'Show what it would do, without doing it' };

export const projectCommand: CommandSpec = {
  name: 'project',
  summary: 'Manages projects',
  usage: 'corami project <action> [arguments]',
  actions: [
    {
      name: 'ls',
      summary: 'Lists the projects with their previews',
      usage: 'corami project ls',
      examples: ['corami project ls'],
      run: ls,
    },
    {
      name: 'show',
      summary: 'Shows a project: path, git, previews',
      usage: 'corami project show <name>',
      arguments: 1,
      examples: ['corami project show myapp'],
      run: show,
    },
    {
      name: 'add',
      summary: 'Adds a project: it goes on the server, and its copy on this machine',
      usage:
        'corami project add <folder> [--from-git <url> | --from-server] [--server-path <folder>] [--name <name>] [--user <user>] [--no-git] [--dry-run]',
      arguments: 1,
      flags: [
        {
          name: 'from-git',
          value: 'url',
          description: 'Repository cloned on the server, then the copy here',
        },
        {
          name: 'from-server',
          description: 'Folder that is already on the server, or a registered project',
        },
        {
          name: 'server-path',
          value: 'folder',
          description: 'Folder of the project on the server, ~/projects/<name> by default',
        },
        NAME_FLAG,
        {
          name: 'user',
          value: 'user',
          description: 'User on the server, default the one of the configuration',
        },
        { name: 'no-git', description: 'Do not give the new local copy its own .git' },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami project add ~/dev/myapp',
        'corami project add ~/dev/myapp --from-git git@github.com:me/myapp.git',
        'corami project add ~/dev/myapp --from-server',
      ],
      run: add,
    },
    {
      name: 'rm',
      summary: 'Removes the copy of this machine, the project on the server, or both apart',
      usage: 'corami project rm <name> --on client|server --yes [--force] [--dry-run]',
      arguments: 1,
      flags: [
        {
          name: 'on',
          value: 'where',
          description: 'client removes the copy of this machine, server the project on the server',
        },
        { name: 'yes', description: 'Confirm the removal' },
        { name: 'force', description: 'With --on client: proceeds even with conflicts' },
        DRY_RUN_FLAG,
      ],
      examples: [
        'corami project rm myapp --on client --yes',
        'corami project rm myapp --on server --yes',
      ],
      run: rm,
    },
  ],
};

export type { ProjectSummary };
