import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { tailnetIdentity } from '@/cli/exec-client-system.ts';
import { booleanFlag } from '@/cli/parser.ts';
import { projectGitOrigin } from '@/cli/server-client.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import type { GitRelationStatus, GitRepoState } from '@/core/git-align.ts';
import {
  describeOrigin,
  followOrigin,
  type GitOriginStatus,
  gitOriginState,
  originChangeJson,
  originNeedsWatch,
  originStatusJson,
} from '@/core/git-follow.ts';
import { emptyPeerSync, type PeerSyncResult, syncPeers } from '@/core/git-peers-sync.ts';
import { type WatchEvent, type WatchRoot, watchProjects } from '@/core/git-watch.ts';
import { listProjects } from '@/core/state.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';
import { gitWatchSpec, serviceHealth } from '@/integrations/service.ts';

export interface GitSides {
  local: string;
  project: string;
  client: GitOriginStatus;
  server: GitOriginStatus | undefined;
  status: GitRelationStatus;
  watch: boolean;
}

export async function gitSides(project: string, local: string): Promise<GitSides> {
  const client = await gitOriginState(local);
  const server = await projectGitOrigin(project).catch(() => undefined);
  const watch = originNeedsWatch(client)
    ? (await serviceHealth(gitWatchSpec(process.execPath)).catch(() => undefined))?.status ===
      'running'
    : true;

  return { project, local, client, server, status: client.status, watch };
}

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

async function rootsToWatch(single: string | undefined): Promise<WatchRoot[]> {
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
  const machine = (await tailnetIdentity()).name;

  if (booleanFlag(context.args, 'once')) {
    const roots = await rootsToWatch(single);

    if (roots.length === 0) {
      throw new CoramiError({
        code: 'usage',
        message: 'No repository to align',
        fix: 'corami project add <folder> --from-server --name <project> takes its copy',
      });
    }

    const results: Array<{
      project: string;
      root: string;
      status: GitOriginStatus;
      peers: PeerSyncResult;
    }> = [];

    for (const item of roots) {
      await followOrigin(item.root).catch(() => undefined);
      const peers = await syncPeers(item.root, { machine }).catch(emptyPeerSync);
      results.push({ ...item, status: await gitOriginState(item.root), peers });
    }

    if (context.output.json) {
      return {
        data: {
          projects: results.map((row) => ({
            project: row.project,
            root: row.root,
            ...originStatusJson(row.status),
            peers: row.peers.peers.map((entry) => ({
              machine: entry.machine,
              branch: entry.branch,
              commit: entry.commit,
              branch_epoch: entry.branchEpoch,
            })),
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
  const config = await readGlobalConfig().catch(() => undefined);
  const client = config?.role === 'client';
  const json = context.output.json;

  await watchProjects({
    machine,
    pollsOrigin: !client,
    roots: () => rootsToWatch(single),
    signal: abort.signal,
    onEvent: (event) => writeEvent(event, json),
    onProject: (project) => {
      if (!json) {
        process.stdout.write(`corami git watch: ${project}\n`);
      }
    },
    onEmpty: () => {
      if (!json) {
        process.stdout.write('corami git watch: no repository, listening\n');
      }
    },
    ...(client
      ? {
          resetSession: async (project: string): Promise<void> => {
            await new MutagenEngine().reset(project);
          },
        }
      : {}),
  });

  return { data: { stopped: true } };
}

function writeEvent(event: WatchEvent, json: boolean): void {
  if (json) {
    const line =
      event.kind === 'origin'
        ? originChangeJson(event.project, event.status, event.from)
        : { project: event.project, event: eventText(event) };

    process.stderr.write(`${JSON.stringify(line)}\n`);
    return;
  }

  process.stdout.write(`${event.project}: ${eventText(event)}\n`);
}

function eventText(event: WatchEvent): string {
  switch (event.kind) {
    case 'origin':
      return describeOrigin(event.status);
    case 'move':
      return `aligned with ${event.move.source} commit ${event.move.to.slice(0, 8)}`;
    case 'switch':
      return `branch ${event.switched.from} -> ${event.switched.to}, following ${event.switched.commit.slice(0, 8)}`;
    case 'fetch':
      return event.failed ? 'origin unreachable (fetch failed)' : 'origin reachable again';
  }
}

export const gitCommand: CommandSpec = {
  name: 'git',
  summary: 'Keeps the two sides of a project aligned with origin',
  usage: 'corami git <action> [arguments]',
  actions: [
    {
      name: 'watch',
      summary: 'Runs the alignment cycle in the foreground, as the service does',
      usage: 'corami git watch [<project>] [--once]',
      flags: [{ name: 'once', description: 'One cycle only, without staying in listen mode' }],
      arguments: 1,
      examples: ['corami git watch', 'corami git watch myapp --once'],
      run: watch,
    },
  ],
};
