import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { stringFlag } from '@/cli/parser.ts';
import { deletePreview, listPreviews, listProjects, putPreview } from '@/cli/server-client.ts';
import { requireServerRole } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { projectForPath, validatePreviewName, validateTargetPort } from '@/core/previews.ts';

const DEFAULT_NAME = 'web';

// The project a folder belongs to, from the paths the server knows.
async function projectFromCwd(): Promise<string> {
  const projects = await listProjects();
  const found = projectForPath(process.cwd(), projects);

  if (found === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `No project of this server contains ${process.cwd()}`,
      fix: 'Run corami serve from inside a project folder, or pass --project <name>',
    });
  }

  return found;
}

async function projectOf(context: CommandContext): Promise<string> {
  return stringFlag(context.args, 'project') ?? (await projectFromCwd());
}

async function open(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  await requireServerRole();

  const raw = context.args.positionals[0];

  if (raw === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing port',
      fix: 'corami serve <port>, the port the dev server listens on',
    });
  }

  const port = Number(raw);

  validateTargetPort(port);

  const name = stringFlag(context.args, 'name') ?? DEFAULT_NAME;
  validatePreviewName(name);

  const project = await projectOf(context);
  const preview = await putPreview(project, name, port);

  if (context.output.json) {
    return { data: preview };
  }

  const lines = [
    preview.url === null
      ? `Preview ${project}/${name} registered, no public name known for this server.`
      : `${preview.url} -> http://127.0.0.1:${preview.target_port}`,
  ];

  if (preview.responding) {
    lines.push(`responding on port ${preview.target_port}`);
  } else {
    lines.push(
      `nothing is listening on port ${preview.target_port} yet: start the dev server with 127.0.0.1 and $PORT`,
    );
  }

  lines.push('Keep it running outside the harness: see docs/previews.md');

  return { text: lines.join('\n') };
}

async function ls(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const project = context.args.positionals[0];
  const previews = (await listPreviews()).filter(
    (preview) => project === undefined || preview.project === project,
  );

  if (context.output.json) {
    return { data: { previews } };
  }

  if (previews.length === 0) {
    return {
      text: 'No previews. Register one with corami serve <port> from the project folder on the server.',
    };
  }

  return {
    text: renderTable(previews, [
      { header: 'Project', value: (row) => row.project },
      { header: 'Name', value: (row) => row.name },
      { header: 'URL', value: (row) => row.url ?? '' },
      { header: 'Target', value: (row) => `127.0.0.1:${row.target_port}` },
      { header: 'Responding', value: (row) => (row.responding ? 'yes' : 'no') },
    ]),
  };
}

async function rm(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const name = context.args.positionals[0];

  if (name === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing preview name',
      fix: 'corami serve rm <name>',
    });
  }

  const project = await projectOf(context);
  const result = await deletePreview(project, name);

  if (context.output.json) {
    return { data: result };
  }

  return {
    text: result.removed ? `Preview ${project}/${name} removed.` : `No preview ${project}/${name}.`,
  };
}

const PROJECT_FLAG = {
  name: 'project',
  value: 'project',
  description: 'Project name, derived from the folder',
};

export const serveCommand: CommandSpec = {
  name: 'serve',
  summary: 'Gives a project port a stable HTTPS address on the tailnet',
  usage: 'corami serve <port> [--name <name>] [--project <project>]',
  flags: [{ name: 'name', value: 'name', description: 'Preview name, default web' }, PROJECT_FLAG],
  arguments: 1,
  examples: ['corami serve 3000', 'corami serve 4100 --name api'],
  actions: [
    {
      name: 'ls',
      summary: 'Lists the registered addresses and whether they respond',
      usage: 'corami serve ls [<project>]',
      arguments: 1,
      examples: ['corami serve ls', 'corami serve ls myapp'],
      run: ls,
    },
    {
      name: 'rm',
      summary: 'Removes an address and its record',
      usage: 'corami serve rm <name> [--project <project>]',
      flags: [PROJECT_FLAG],
      arguments: 1,
      examples: ['corami serve rm web', 'corami serve rm api --project myapp'],
      run: rm,
    },
  ],
  run: open,
};
