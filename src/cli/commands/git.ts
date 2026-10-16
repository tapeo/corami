// The cycle that keeps the two sides aligned with `origin`: one on the server,
// one on every local copy. The same code on both, because they are peers. Only
// the sync moves the files, here the refs are moved.

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { booleanFlag } from '@/cli/parser.ts';
import { projectGitOrigin } from '@/cli/server-client.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import type { GitRelationStatus, GitRepoState } from '@/core/git-align.ts';
import {
  describeOrigin,
  fetchFailed,
  followOrigin,
  type GitOriginStatus,
  gitOriginState,
  ORIGIN_CYCLE_MS,
  originChanged,
  originChangeJson,
  originStatusJson,
} from '@/core/git-follow.ts';
import { listProjects } from '@/core/state.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';

export interface GitSides {
  local: string;
  project: string;
  client: GitOriginStatus;
  server: GitOriginStatus | undefined;
  // The state of the local side, handy for the `sync status` line.
  status: GitRelationStatus;
}

// The state of the two sides, read without network: the server is told by the
// daemon, the local side is read on this machine. Only the cycle does a fetch.
export async function gitSides(project: string, local: string): Promise<GitSides> {
  const client = await gitOriginState(local);
  const server = await projectGitOrigin(project).catch(() => undefined);

  return { project, local, client, server, status: client.status };
}

// The summary of one side for a text line: branch, commit and work in
// progress. Used by `sync status` and the tests.
export function summarizeSide(state: GitRepoState | undefined): string {
  if (state === undefined || state.commit === '') {
    return 'n/a';
  }

  const branch = state.branch === '' ? 'HEAD' : state.branch;
  const parts = [branch, state.commit.slice(0, 8)];

  if (state.operation !== undefined) {
    parts.push(state.operation);
  }

  if (state.staged) {
    parts.push('stage');
  }

  if (state.dirtyChanges > 0) {
    parts.push(`${state.dirtyChanges} file`);
  }

  return parts.join(' ');
}

interface WatchedRoot {
  project: string;
  root: string;
}

// The repositories to watch: local copies on a client, projects on the server.
async function rootsToWatch(single: string | undefined): Promise<WatchedRoot[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'client') {
    return listProjects()
      .filter((row) => single === undefined || row.name === single)
      .map((row) => ({ project: row.name, root: row.path }));
  }

  const engine = new MutagenEngine();
  const sessions = await engine.list().catch(() => []);

  return sessions
    .filter((session) => single === undefined || session.project === single)
    .map((session) => ({ project: session.project, root: session.beta }));
}

async function watch(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const single = context.args.positionals[0];

  if (booleanFlag(context.args, 'once')) {
    const roots = await rootsToWatch(single);

    if (roots.length === 0) {
      throw new CoramiError({
        code: 'usage',
        message: 'No repository to align',
        fix: 'corami sync <project> to create a local copy',
      });
    }

    const results: Array<{ project: string; root: string; status: GitOriginStatus }> = [];

    for (const item of roots) {
      results.push({ ...item, status: await followOrigin(item.root) });
    }

    if (context.output.json) {
      return {
        data: {
          projects: results.map((row) => ({
            project: row.project,
            root: row.root,
            ...originStatusJson(row.status),
          })),
        },
      };
    }

    return {
      text: results.map((row) => `${row.project}: ${describeOrigin(row.status)}`).join('\n'),
    };
  }

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  const known = new Set<string>();
  const failing = new Map<string, boolean>();
  let empty = false;

  // One cycle at once, then one a minute. The list is read again at every
  // cycle, so projects born after startup are picked up.
  while (!abort.signal.aborted) {
    const roots = await rootsToWatch(single).catch(() => []);

    for (const item of roots) {
      if (!known.has(item.project)) {
        known.add(item.project);

        // In JSON mode startup does not dirty the output: the service journal
        // collects the state change lines, which are JSON.
        if (!context.output.json) {
          process.stdout.write(`corami git watch: ${item.project}\n`);
        }
      }
    }

    if (roots.length === 0 && !empty && !context.output.json) {
      empty = true;
      process.stdout.write('corami git watch: no repository, listening\n');
    }

    for (const item of roots) {
      if (abort.signal.aborted) {
        break;
      }

      const before = await gitOriginState(item.root).catch(() => undefined);
      const status = await followOrigin(item.root).catch(() => undefined);

      if (status === undefined) {
        continue;
      }

      // Only sides with an `origin` to follow can have a failed fetch: a
      // project without a repository is not a fault.
      const nowFailing = fetchFailed(status);
      const wasFailing = failing.get(item.project) === true;
      failing.set(item.project, nowFailing);

      if (!originChanged(before, status, wasFailing)) {
        continue;
      }

      if (context.output.json) {
        // One JSON object per line on stderr: stdout stays the only envelope
        // of the command, and the service finds it in the journal.
        const line = originChangeJson(item.project, status, before?.state.commit);
        process.stderr.write(`${JSON.stringify(line)}\n`);
        continue;
      }

      const text =
        nowFailing && !wasFailing
          ? `${item.project}: origin unreachable (fetch failed)`
          : `${item.project}: ${describeOrigin(status)}`;

      process.stdout.write(`${text}\n`);
    }

    await sleep(ORIGIN_CYCLE_MS, abort.signal);
  }

  return { data: { stopped: true } };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // A signal already aborted never fires `abort` again: a SIGTERM received
    // during the cycle would otherwise wait the whole minute.
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export const gitCommand: CommandSpec = {
  name: 'git',
  summary: 'Keeps the two sides of a project aligned with origin',
  usage: 'corami git watch [<project>] [--once]',
  flags: [
    { name: 'json', description: 'JSON output' },
    { name: 'once', description: 'One cycle only, without staying in listen mode' },
  ],
  examples: ['corami git watch', 'corami git watch myapp --once'],
  run: (context) => {
    const action = context.args.positionals[0];
    const rest: CommandContext = {
      ...context,
      args: { ...context.args, positionals: context.args.positionals.slice(1) },
    };

    switch (action) {
      case undefined:
      case 'watch':
        return watch(rest);
      default:
        throw new CoramiError({
          code: 'usage',
          message: `Unknown command: git ${action}`,
          fix: 'corami git watch [<project>] [--once]',
        });
    }
  },
};
