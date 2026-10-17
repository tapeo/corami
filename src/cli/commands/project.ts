import type { CommandContext, CommandResult, CommandSpec } from '@/cli/command.ts';
import { runImport } from '@/cli/commands/import.ts';
import {
  copyPlace,
  createLocalCopy,
  givenPath,
  removeLocalCopy,
  syncSessions,
} from '@/cli/commands/sync.ts';
import { renderOrphanCopies, renderTable } from '@/cli/output.ts';
import { booleanFlag, negatedFlag, stringFlag } from '@/cli/parser.ts';
import { canPrompt, type Prompter, terminalPrompter } from '@/cli/prompt.ts';
import {
  addProject,
  listProjects,
  type ProjectSummary,
  projectDetail,
  removeProject,
} from '@/cli/server-client.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import {
  type AddFrom,
  type CwdRepository,
  defaultLocalPath,
  defaultServerPath,
  planProjectAdd,
  repositoryAt,
  suggestedProjectName,
  validServerPath,
} from '@/core/project-add.ts';
import { validProjectName, withLocalCopies } from '@/core/projects.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

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
      ? 'No projects. Add one with corami project add --from-git <url>.'
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

/** The source flag given on the command line, when there is exactly one. */
function sourceOf(url: string | undefined, local: boolean, server: boolean): AddFrom | undefined {
  const given: AddFrom[] = [];

  if (url !== undefined) {
    given.push('git');
  }

  if (local) {
    given.push('local');
  }

  if (server) {
    given.push('server');
  }

  if (given.length > 1) {
    throw new CoramiError({
      code: 'usage',
      message: 'Give one of --from-git, --from-local or --from-server',
      fix: 'They say where the project comes from: a repository, this machine, or the server',
    });
  }

  return given[0];
}

async function chooseSource(prompter: Prompter | undefined): Promise<AddFrom> {
  if (prompter === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing --from-git, --from-local or --from-server',
      fix: 'corami project add --from-git <url> --local-path <folder> adds a repository, --from-local --local-path <folder> a folder of this machine, --from-server --local-path <folder> a folder of the server',
    });
  }

  return prompter.choose('What are you adding', [
    { label: 'A git repository, cloned on the server', value: 'git' as AddFrom },
    { label: 'A folder of this machine, moved to the server', value: 'local' as AddFrom },
    { label: 'A folder that is already on the server', value: 'server' as AddFrom },
  ]);
}

function sourceHint(from: AddFrom, url: string | undefined): string {
  if (from === 'git') {
    return `--from-git ${url ?? '<url>'}`;
  }

  if (from === 'local') {
    return '--from-local';
  }

  return '--from-server';
}

async function add(context: CommandContext): Promise<CommandResult> {
  const config = await readGlobalConfig().catch(() => undefined);
  const prompter = canPrompt(context.output) ? terminalPrompter() : undefined;
  const dryRun = booleanFlag(context.args, 'dry-run');
  const user = stringFlag(context.args, 'user');
  const noGit = negatedFlag(context.args, 'git');
  const cwd = process.cwd();
  const urlFlag = stringFlag(context.args, 'from-git');
  const localFlag = stringFlag(context.args, 'local-path');
  const serverFlag = stringFlag(context.args, 'server-path');
  const nameFlag = stringFlag(context.args, 'name');

  const from =
    sourceOf(
      urlFlag,
      booleanFlag(context.args, 'from-local'),
      booleanFlag(context.args, 'from-server'),
    ) ?? (await chooseSource(prompter));

  let url = urlFlag;

  if (from === 'git' && url === undefined) {
    if (prompter === undefined) {
      throw new CoramiError({
        code: 'usage',
        message: 'Missing --from-git <url>',
        fix: 'corami project add --from-git <url> --local-path <folder>',
      });
    }

    url = await prompter.ask('Repository url');

    if (url === '') {
      throw new CoramiError({ code: 'usage', message: 'Missing repository url' });
    }
  }

  // The root of the clone this command runs in: the folder of `--from-local`
  // by default, and the clone the check compares with the url.
  const gitRoot = from === 'local' ? (await repositoryAt(cwd))?.root : undefined;
  let cwdRepository: CwdRepository | undefined;

  if (from === 'git') {
    cwdRepository = await repositoryAt(cwd);
  }

  let name = nameFlag;

  if (name === undefined) {
    const suggested = suggestedProjectName({
      url,
      serverPath: serverFlag,
      localPath: localFlag ?? gitRoot,
    });

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
      fix: `corami project add ${sourceHint(from, url)} --name <name> chooses it`,
    });
  }

  if (!validProjectName(name)) {
    throw new CoramiError({
      code: 'usage',
      message: `Invalid project name: ${name}`,
      fix: 'A project name is letters, digits, dot, dash and underscore: --name chooses another one',
    });
  }

  // The folder of this machine: the one of the project itself with
  // `--from-local`, a folder of the working directory otherwise.
  const localDefault = from === 'local' ? (gitRoot ?? cwd) : defaultLocalPath(cwd, name);
  let localArg = localFlag;

  if (localArg === undefined) {
    if (prompter === undefined) {
      throw new CoramiError({
        code: 'usage',
        message: 'Missing --local-path',
        fix: `corami project add ${sourceHint(from, url)} --local-path <folder>`,
      });
    }

    localArg = await prompter.ask('Local path (this machine)', localDefault);
  }

  const localPath = givenPath(localArg);
  const serverDefault = defaultServerPath(name);
  let serverArg = serverFlag;

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
  const sessions = onClient ? await syncSessions(engine) : [];
  const session = sessions.find((entry) => entry.project === name)?.beta;
  const detail = await projectDetail(name).catch(() => undefined);
  const registeredPath = typeof detail?.path === 'string' ? detail.path : undefined;

  planProjectAdd({
    role: config?.role,
    from,
    project: name,
    url,
    explicitName: nameFlag,
    serverPath: serverFlag,
    registeredPath,
    session,
    cwdRepository,
  });

  // The folder of the copy: with `--from-local` it is the folder that moves,
  // anywhere else it is created. An empty folder is fine, the session takes it.
  const place = await copyPlace(engine, name, localPath, from === 'local');
  // The project is where the server says it is: a registered one knows its
  // folder, and no path typed here overrides it.
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
    if (noGit) {
      throw new CoramiError({
        code: 'usage',
        message: '--no-git does not apply to --from-local',
        fix: 'The .git of the folder moves with it, and the copy keeps its own',
      });
    }

    return runImport({
      project: name,
      localPath: place.local,
      serverPath: target,
      user,
      dryRun: false,
      output: context.output,
    });
  }

  let registered = false;

  if (from === 'git') {
    if (url === undefined) {
      throw new CoramiError({ code: 'usage', message: 'Missing repository url' });
    }

    await addProject({ name, url, path: target });
    registered = true;
  } else if (registeredPath === undefined) {
    await addProject({ name, path: target });
    registered = true;
  }

  let copy: Awaited<ReturnType<typeof createLocalCopy>>;

  try {
    copy = await createLocalCopy({
      project: name,
      localPath: place.local,
      serverPath: target,
      user,
      git: !noGit,
    });
  } catch (error) {
    throw await copyFailure({ error, name, target, registered, localPath: place.local });
  }

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

  return { text: lines.join('\n') };
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
    lines.push(`Move ${place.local} to the server at ${target}.`);
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

/**
 * A copy that failed after the server was already given the project: the
 * project goes away again, because a project without its copy is what this
 * command never leaves behind.
 */
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
    return removeLocalCopy(name, context);
  }

  if (!booleanFlag(context.args, 'yes')) {
    throw new CoramiError({
      code: 'usage',
      message: `Confirmation required to remove ${name}`,
      fix: `Run corami project rm ${name} --on server --yes`,
    });
  }

  // The session of this client goes first: the server deletes the folder of
  // the project, and the copy should not be there when it happens. The
  // sessions of the other clients stay where they are.
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

    // The project is still on the server, the copy of this machine is closed:
    // say both, and how to reopen it.
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
      examples: ['corami project show myapp'],
      run: show,
    },
    {
      name: 'add',
      summary: 'Adds a project: it goes on the server, and its copy on this machine',
      usage:
        'corami project add --from-git <url> | --from-local | --from-server [--server-path <folder>] --local-path <folder> [--name <name>] [--user <user>] [--no-git] [--dry-run]',
      flags: [
        {
          name: 'from-git',
          value: 'url',
          description: 'Repository cloned on the server, then the copy here',
        },
        {
          name: 'from-local',
          description: 'Folder of this machine that moves to the server and becomes the copy',
        },
        {
          name: 'from-server',
          description: 'Folder that is already on the server, or a registered project',
        },
        {
          name: 'local-path',
          value: 'folder',
          description: 'Folder of the copy on this machine, prompted with a default',
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
        'corami project add --from-git git@github.com:me/myapp.git --local-path ~/dev/myapp',
        'corami project add --from-local --local-path ~/dev/myapp',
        'corami project add --from-server --name myapp --local-path ~/dev/myapp',
      ],
      run: add,
    },
    {
      name: 'rm',
      summary: 'Removes the copy of this machine, the project on the server, or both apart',
      usage: 'corami project rm <name> --on client|server --yes [--force] [--dry-run]',
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
