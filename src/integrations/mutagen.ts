import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import { PATH_RULES, type PathRule } from '@/core/local-copy.ts';
import { ensureTool, findTool, MUTAGEN } from '@/core/pinned-tools.ts';
import {
  installService,
  type ServiceResult,
  type ServiceSpec,
  serviceActive,
  servicePlatform,
} from '@/integrations/service.ts';

export interface SyncSession {
  name: string;
  project: string;
  status: string;
  mode: string;
  alpha: string;
  beta: string;
  conflicts: string[];
  lastError: string | undefined;
  /** Links Mutagen leaves on this machine, one by one: they are not an error. */
  localLinks: string[];
}

export interface SyncEngine {
  create(options: CreateOptions): Promise<void>;
  list(): Promise<SyncSession[]>;
  terminate(project: string): Promise<void>;
  flush(project: string): Promise<void>;
  status(project: string): Promise<SyncSession | undefined>;
}

export interface CreateOptions {
  project: string;
  serverHost: string;
  serverUser: string;
  serverPath: string;
  localPath: string;
  ignore: string[];
}

/**
 * A path rule as Mutagen reads it. A pattern with a slash matches at any
 * depth, like a name rule does in Mutagen, and the doublestar prefix also
 * matches the pattern at the root: `ios/.symlinks` becomes a doublestar
 * prefix followed by `ios/.symlinks/`, which covers the app at the root and
 * the one under `apps/demo`, as `classifyPath` does. A folder rule keeps its
 * trailing slash: a file with the same name travels.
 */
export function mutagenPattern(rule: PathRule): string {
  const base = rule.pattern.includes('/') ? `**/${rule.pattern}` : rule.pattern;

  return rule.directories === true ? `${base}/` : base;
}

// `.git` and `._*` are not here: the first is the `--ignore-vcs` of the
// session, the second is an AppleDouble artifact the import already leaves
// out. The rest comes from the path rules, so the sync, the import and the
// removal checks agree on what a copy never carries: what is regenerable, and
// what belongs to one machine. Everything else travels, keys included.
export const DEFAULT_IGNORES = PATH_RULES.filter(
  (rule) => rule.class !== 'synced' && rule.pattern !== '.git' && rule.pattern !== '._*',
).map(mutagenPattern);

export function sessionName(project: string): string {
  return `corami-${project}`;
}

export class MutagenEngine implements SyncEngine {
  private binary: string | undefined;

  async path(): Promise<string> {
    if (this.binary !== undefined) {
      return this.binary;
    }

    const existing = await findTool(MUTAGEN);

    if (existing !== undefined) {
      this.binary = existing;
      return existing;
    }

    const installed = await ensureTool(MUTAGEN);
    this.binary = installed.path;
    return installed.path;
  }

  async create(options: CreateOptions): Promise<void> {
    const binary = await this.path();
    const ignores = [...DEFAULT_IGNORES, ...options.ignore].flatMap((pattern) => [
      '--ignore',
      pattern,
    ]);

    const result = await run(
      binary,
      [
        'sync',
        'create',
        '--name',
        sessionName(options.project),
        '--mode',
        'two-way-safe',
        '--ignore-vcs',
        ...ignores,
        `${options.serverUser}@${options.serverHost}:${options.serverPath}`,
        options.localPath,
      ],
      { timeoutMs: 600_000 },
    );

    if (!result.ok) {
      throw new CoramiError({
        code: 'generic',
        message: `Cannot create the sync session for ${options.project}`,
        fix: `${result.stdout}${result.stderr}`.trim().split('\n').slice(-3).join(' '),
      });
    }
  }

  async list(): Promise<SyncSession[]> {
    return (await this.sessions()) ?? [];
  }

  /**
   * The sessions of the engine, undefined when it did not answer: no binary,
   * no daemon, or output that is not JSON. `list` reads that as no session at
   * all; a command that reports them says it instead.
   */
  async sessions(): Promise<SyncSession[] | undefined> {
    const binary = await this.path().catch(() => undefined);

    if (binary === undefined) {
      return undefined;
    }

    const result = await run(binary, ['sync', 'list', '--template', '{{ json . }}']);

    if (!result.ok) {
      return undefined;
    }

    return parseSessions(result.stdout);
  }

  async status(project: string): Promise<SyncSession | undefined> {
    const sessions = await this.list();
    return sessions.find((session) => session.project === project);
  }

  /**
   * The first cycle of a session, undefined when Mutagen does not answer the
   * one session it was asked. A session that is not there is none of the two.
   */
  async progress(project: string): Promise<SyncProgress | undefined> {
    const binary = await this.path().catch(() => undefined);

    if (binary === undefined) {
      return undefined;
    }

    const result = await run(
      binary,
      ['sync', 'list', sessionName(project), '--template', '{{ json . }}'],
      { timeoutMs: 60_000 },
    );

    return result.ok ? syncProgress(result.stdout, project) : undefined;
  }

  async terminate(project: string): Promise<void> {
    await this.simple(['sync', 'terminate', sessionName(project)]);
  }

  async flush(project: string): Promise<void> {
    const binary = await this.path();
    const result = await run(binary, ['sync', 'flush', sessionName(project)], {
      timeoutMs: 300_000,
    });

    if (result.ok) {
      return;
    }

    const output = `${result.stdout}${result.stderr}`;

    // The session of a project that is gone from the registry is the one case
    // where there is nothing to flush: every other failure is real, and the
    // caller of `flush` decides on it.
    if (/did not match any sessions|no sessions/i.test(output)) {
      return;
    }

    throw new CoramiError({
      code: 'sync_pending',
      message: `mutagen sync flush failed for ${project}`,
      fix: output.trim().split('\n').slice(-2).join(' '),
    });
  }

  private async simple(args: string[]): Promise<void> {
    const binary = await this.path();
    const result = await run(binary, args, { timeoutMs: 300_000 });

    if (result.ok) {
      return;
    }

    throw new CoramiError({
      code: 'generic',
      message: `mutagen ${args.slice(0, 2).join(' ')} failed`,
      fix: `${result.stdout}${result.stderr}`.trim().split('\n').slice(-2).join(' '),
    });
  }
}

export function parseSessions(raw: string): SyncSession[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const sessions: SyncSession[] = [];

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = String(record.name ?? record.identifier ?? '');

    if (!name.startsWith('corami-')) {
      continue;
    }

    const described = describeProblems(record);

    sessions.push({
      name,
      project: name.slice('corami-'.length),
      status: String(record.status ?? 'unknown'),
      mode: String(record.mode ?? 'two-way-safe'),
      alpha: describeEndpoint(record.alpha),
      beta: describeEndpoint(record.beta),
      conflicts: collectConflicts(record),
      lastError: described.error,
      localLinks: described.links,
    });
  }

  return sessions;
}

function describeEndpoint(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : '';
  const host = typeof record.host === 'string' ? record.host : '';
  const user = typeof record.user === 'string' ? record.user : '';

  if (host !== '') {
    return `${user === '' ? '' : `${user}@`}${host}:${path}`;
  }

  return path;
}

/** What the first cycle of a session is doing, as the progress line says it. */
export interface SyncProgress {
  state: 'waiting' | 'count' | 'done' | 'halted';
  /** What to say while it works, or why it stopped. */
  activity: string;
  /** `count`: how much is done and the total, in `unit`. */
  received?: number | undefined;
  total?: number | undefined;
  /** `count`: bytes when the two sides know the size, files otherwise. */
  unit?: 'bytes' | 'files' | undefined;
  /** `done`: the files the copy holds. */
  files?: number | undefined;
}

const SYNC_ACTIVITY: Record<string, string> = {
  'connecting-alpha': 'Connecting to the server',
  'connecting-beta': 'Connecting',
  scanning: 'Scanning the files',
  'waiting-for-rescan': 'Scanning the files again',
  reconciling: 'Comparing the two sides',
  transitioning: 'Applying the changes',
  'staging-alpha': 'Writing the files on the server',
  saving: 'Saving the session',
  watching: 'Waiting for the first cycle to finish',
  disconnected: 'Waiting for the server',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  // The JSON of Mutagen has numbers, but an older build may quote them.
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return 0;
}

/**
 * The state of the first cycle of a session, read from the JSON Mutagen gives
 * for it. Mutagen counts the files, never the total of the bytes, so the
 * progress of a copy is in files. `successfulCycles` alone is not the end: it
 * counts a cycle before the files of the copy are all written, so the session
 * is done only when it is back to `watching`.
 */
export function syncProgress(raw: string, project: string): SyncProgress | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  const record = records
    .map((entry) => asRecord(entry))
    .find((entry) => String(entry?.name ?? entry?.identifier ?? '') === sessionName(project));

  if (record === undefined) {
    return undefined;
  }

  const cycles = asCount(record.successfulCycles);
  const beta = asRecord(record.beta);
  const files = asCount(beta?.files);
  const lastError = typeof record.lastError === 'string' ? record.lastError.trim() : '';
  const status = typeof record.status === 'string' ? record.status : 'unknown';

  if (status === 'watching' && cycles >= 1) {
    return { state: 'done', activity: 'The first sync is complete', files };
  }

  if (status.startsWith('halted')) {
    const reason =
      lastError === '' ? status.replaceAll('-', ' ') : (lastError.split('\n')[0] ?? '');

    return { state: 'halted', activity: reason };
  }

  const staging = asRecord(beta?.stagingProgress);
  const expected = asCount(staging?.expectedFiles);

  if (staging !== undefined && expected > 0) {
    // The bytes of the whole project are the smoothest count there is: a
    // single big file would leave the files at 0 for the whole transfer.
    const totalBytes = asCount(asRecord(record.alpha)?.totalFileSize);

    if (totalBytes > 0) {
      return {
        state: 'count',
        activity: 'Writing the files here',
        received: asCount(staging?.totalReceivedSize),
        total: totalBytes,
        unit: 'bytes',
      };
    }

    return {
      state: 'count',
      activity: 'Writing the files here',
      received: asCount(staging?.receivedFiles),
      total: expected,
      unit: 'files',
    };
  }

  const activity =
    lastError === ''
      ? (SYNC_ACTIVITY[status] ?? 'Waiting for the sync')
      : `Retrying: ${(lastError.split('\n')[0] ?? '').slice(0, 80)}`;

  return { state: 'waiting', activity };
}

export function collectConflicts(record: Record<string, unknown>): string[] {
  const conflicts = record.conflicts;

  if (!Array.isArray(conflicts)) {
    return [];
  }

  return conflicts.map((item) => {
    if (typeof item === 'string') {
      return item;
    }

    if (typeof item === 'object' && item !== null) {
      const root = (item as Record<string, unknown>).root;

      if (typeof root === 'string') {
        return root;
      }

      return JSON.stringify(item);
    }

    return String(item);
  });
}

/**
 * The reason Mutagen gives for an entry it leaves alone. Only the ones about a
 * link are read: Corami keeps such a link on this machine on purpose, so the
 * session says it instead of showing a problem of the transport. The texts are
 * the errors of `normalizeSymbolicLinkAndEnsurePortable` in Mutagen v0.18.1.
 */
const LINK_PROBLEMS = [
  'target empty',
  'target too long',
  'colon in target',
  'backslash in target',
  'target is absolute',
  'target references location outside synchronization root',
];

function describeProblems(record: Record<string, unknown>): {
  error: string | undefined;
  links: string[];
} {
  const links: string[] = [];
  let error: string | undefined;

  for (const side of ['alpha', 'beta']) {
    const endpoint = record[side];

    if (typeof endpoint !== 'object' || endpoint === null) {
      continue;
    }

    const problems =
      (endpoint as Record<string, unknown>).scanProblems ??
      (endpoint as Record<string, unknown>).transitionProblems;

    if (!Array.isArray(problems)) {
      continue;
    }

    const described = problems.map((item) => describeProblemEntry(item));

    for (const entry of described) {
      if (entry.link) {
        if (!links.includes(entry.path)) {
          links.push(entry.path);
        }
      }
    }

    const rest = described.filter((entry) => !entry.link);

    if (rest.length > 0 && error === undefined) {
      error = `${side}: ${rest.map((entry) => entry.text).join(', ')}`.slice(0, 300);
    }
  }

  if (error === undefined) {
    const last = record.lastError;

    error = typeof last === 'string' ? last : undefined;
  }

  return { error, links };
}

function describeProblemEntry(item: unknown): { text: string; path: string; link: boolean } {
  if (typeof item !== 'object' || item === null) {
    const text = String(item);

    return { text, path: '', link: false };
  }

  const record = item as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : '';
  const error = typeof record.error === 'string' ? record.error : JSON.stringify(item);
  const link = LINK_PROBLEMS.some((known) => error.toLowerCase().includes(known));

  return {
    text: path === '' ? error : `${path}: ${error}`,
    path: path === '' ? error : path,
    link: link && path !== '',
  };
}

// The Mutagen daemon carries the sync sessions. Started on demand by the CLI it
// does not come back after a reboot, and the sessions stay paused until the
// next mutagen command: on a client it runs as a service. On macOS and Windows
// Mutagen registers itself with the system (`mutagen daemon register`); on
// Linux it has no such command, and a user systemd unit runs `daemon run`.
export function mutagenDaemonSpec(binary: string): ServiceSpec {
  return {
    name: 'corami-mutagen',
    description: 'Mutagen daemon for the Corami sync',
    binary,
    args: ['daemon', 'run'],
    restart: true,
  };
}

export function mutagenLaunchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'io.mutagen.mutagen.plist');
}

export async function installDaemonService(binary: string): Promise<ServiceResult> {
  const platform = servicePlatform();

  if (platform === 'linux') {
    const spec = mutagenDaemonSpec(binary);

    // A daemon started on demand holds the lock, and the unit could not start
    // next to it.
    if (!(await serviceActive(spec))) {
      await run(binary, ['daemon', 'stop']);
    }

    return installService(spec);
  }

  if (platform === 'macos' || platform === 'windows') {
    return registerDaemon(binary, platform);
  }

  return { installed: false, path: '', detail: `Unsupported platform: ${process.platform}` };
}

export async function daemonServiceActive(binary: string): Promise<boolean | undefined> {
  const platform = servicePlatform();

  if (platform === 'linux') {
    return serviceActive(mutagenDaemonSpec(binary));
  }

  if (platform === 'macos') {
    if (!existsSync(mutagenLaunchAgentPath())) {
      return false;
    }

    const result = await run('launchctl', [
      'print',
      `gui/${process.getuid?.() ?? 0}/io.mutagen.mutagen`,
    ]);
    return result.ok;
  }

  return undefined;
}

async function registerDaemon(
  binary: string,
  platform: 'macos' | 'windows',
): Promise<ServiceResult> {
  const plist = platform === 'macos' ? mutagenLaunchAgentPath() : '';

  // A registration left by another Mutagen binary (an older install, Homebrew)
  // would start that one at login: Mutagen keeps an existing registration as
  // it is, so it is removed first.
  if (
    plist !== '' &&
    existsSync(plist) &&
    !readFileSync(plist, 'utf8').includes(`<string>${binary}</string>`)
  ) {
    await run(binary, ['daemon', 'stop']);
    await run(binary, ['daemon', 'unregister']);
  }

  let registered = await run(binary, ['daemon', 'register']);

  // Registering needs the daemon lock, held by a daemon started on demand. A
  // launchd job whose plist is already gone keeps that daemon alive and cannot
  // be unregistered; bootout removes the job, then the lock is free.
  if (!registered.ok) {
    await run(binary, ['daemon', 'stop']);

    if (platform === 'macos') {
      await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/io.mutagen.mutagen`]);
    }

    registered = await run(binary, ['daemon', 'register']);
  }

  if (!registered.ok) {
    return { installed: false, path: plist, detail: firstLines(registered) };
  }

  const started = await run(binary, ['daemon', 'start']);

  if (!started.ok) {
    return { installed: false, path: plist, detail: firstLines(started) };
  }

  return {
    installed: true,
    path: plist === '' ? binary : plist,
    detail: platform === 'macos' ? 'launchd agent' : 'started at logon',
  };
}

function firstLines(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' ');
}
