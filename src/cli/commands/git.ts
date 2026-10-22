import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { tailnetIdentity } from '@/cli/exec-client-system.ts';
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
  originNeedsWatch,
  originStatusJson,
} from '@/core/git-follow.ts';
import {
  type PeerMove,
  type PeerSwitch,
  type PeerSyncResult,
  peerFingerprint,
  syncPeers,
} from '@/core/git-peers-sync.ts';
import { listProjects } from '@/core/state.ts';
import { MutagenEngine } from '@/integrations/mutagen.ts';
import { gitWatchSpec, serviceHealth } from '@/integrations/service.ts';

const TICK_MS = 2_000;
const FETCH_TICKS = Math.max(1, Math.round(ORIGIN_CYCLE_MS / TICK_MS));

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

interface WatchedRoot {
  project: string;
  root: string;
}

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
      const peers = await syncPeers(item.root, { machine }).catch(() => emptyPeers());
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
  const known = new Set<string>();
  const failing = new Map<string, boolean>();
  const fingerprints = new Map<string, string>();
  const config = await readGlobalConfig().catch(() => undefined);
  const client = config?.role === 'client';
  let empty = false;
  let turn = 0;

  while (!abort.signal.aborted) {
    const roots = await rootsToWatch(single).catch(() => []);

    for (const item of roots) {
      if (!known.has(item.project)) {
        known.add(item.project);

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

      const fingerprint = peerFingerprint(item.root);
      const fetchNow = turn % FETCH_TICKS === 0;

      if (!fetchNow && fingerprints.get(item.project) === fingerprint) {
        continue;
      }

      fingerprints.set(item.project, fingerprint);

      const before = await gitOriginState(item.root).catch(() => undefined);

      if (fetchNow) {
        await followOrigin(item.root).catch(() => undefined);
      }

      const peerDir = join(item.root, '.git', 'corami');
      const existed = existsSync(peerDir);
      const peers = await syncPeers(item.root, { machine }).catch(() => emptyPeers());

      if (!existed && existsSync(peerDir) && client) {
        await new MutagenEngine().reset(item.project).catch(() => undefined);
      }

      const status = await gitOriginState(item.root).catch(() => undefined);

      if (status === undefined) {
        continue;
      }

      const notes: string[] = [];

      if (peers.moved !== undefined) {
        notes.push(moveText(peers.moved));
      }

      if (peers.switched !== undefined) {
        notes.push(switchText(peers.switched));
      }

      const nowFailing = fetchFailed(status);
      const wasFailing = failing.get(item.project) === true;
      failing.set(item.project, nowFailing);

      if (!originChanged(before, status, wasFailing) && notes.length === 0) {
        continue;
      }

      if (context.output.json) {
        const line = originChangeJson(item.project, status, before?.state.commit);

        process.stderr.write(`${JSON.stringify(line)}\n`);

        for (const note of notes) {
          process.stderr.write(`${JSON.stringify({ project: item.project, event: note })}\n`);
        }

        continue;
      }

      const text =
        nowFailing && !wasFailing
          ? `${item.project}: origin unreachable (fetch failed)`
          : `${item.project}: ${describeOrigin(status)}`;

      process.stdout.write(`${text}\n`);

      for (const note of notes) {
        process.stdout.write(`${item.project}: ${note}\n`);
      }
    }

    await sleep(TICK_MS, abort.signal);
    turn += 1;
  }

  return { data: { stopped: true } };
}

function emptyPeers(): PeerSyncResult {
  return { peers: [], moved: undefined, switched: undefined };
}

function moveText(move: PeerMove): string {
  return `aligned with ${move.source} commit ${move.to.slice(0, 8)}`;
}

function switchText(switched: PeerSwitch): string {
  return `branch ${switched.from} -> ${switched.to}, following ${switched.commit.slice(0, 8)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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
