import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
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

export const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  '.next/',
  '.turbo/',
  '.expo/',
  'dist/',
  'build/',
  'coverage/',
  '.dart_tool/',
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
  '.fvm/',
  'ios/Pods/',
  'ios/.symlinks/',
  'ios/Flutter/Generated.xcconfig',
  'ios/Flutter/flutter_export_environment.sh',
  'android/.gradle/',
  'android/local.properties',
  'android/key.properties',
  'macos/Flutter/ephemeral/',
  'linux/flutter/ephemeral/',
  'windows/Flutter/ephemeral/',
  '*.jks',
  '*.keystore',
  '*.p8',
  '*.p12',
  '*service-account*.json',
  '.env',
  '.env.*',
];

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
    const binary = await this.path();
    const result = await run(binary, ['sync', 'list', '--template', '{{ json . }}']);

    if (!result.ok) {
      return [];
    }

    return parseSessions(result.stdout);
  }

  async status(project: string): Promise<SyncSession | undefined> {
    const sessions = await this.list();
    return sessions.find((session) => session.project === project);
  }

  async terminate(project: string): Promise<void> {
    await this.simple(['sync', 'terminate', sessionName(project)]);
  }

  async flush(project: string): Promise<void> {
    await this.simple(['sync', 'flush', sessionName(project)], true);
  }

  private async simple(args: string[], tolerateMissing = false): Promise<void> {
    const binary = await this.path();
    const result = await run(binary, args, { timeoutMs: 300_000 });

    if (result.ok || tolerateMissing) {
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

    sessions.push({
      name,
      project: name.slice('corami-'.length),
      status: String(record.status ?? 'unknown'),
      mode: String(record.mode ?? 'two-way-safe'),
      alpha: describeEndpoint(record.alpha),
      beta: describeEndpoint(record.beta),
      conflicts: collectConflicts(record),
      lastError: describeProblem(record),
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

function describeProblem(record: Record<string, unknown>): string | undefined {
  for (const side of ['alpha', 'beta']) {
    const endpoint = record[side];

    if (typeof endpoint !== 'object' || endpoint === null) {
      continue;
    }

    const problems =
      (endpoint as Record<string, unknown>).scanProblems ??
      (endpoint as Record<string, unknown>).transitionProblems;

    if (Array.isArray(problems) && problems.length > 0) {
      return `${side}: ${problems.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')}`.slice(
        0,
        300,
      );
    }
  }

  const error = record.lastError;

  return typeof error === 'string' ? error : undefined;
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
