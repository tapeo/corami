import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { type ExecGrant, grantsFromJson, grantsJson } from '@/core/exec-grants.ts';
import { type ExecRule, rulesFromJson, rulesJson } from '@/core/exec-rules.ts';

export interface PendingRequest {
  id: string;
  project: string;
  argv: string[];
  created_at: string;
}

export interface PendingDecision {
  decision: 'allow' | 'deny';
}

export interface RunningCommand {
  id: string;
  project: string;
  program: string;
  pgid: number;
  started_at: string;
}

export interface ExecState {
  server: string;
  name: string;
  since: string;
}

export interface ExecLogEntry {
  at: string;
  project: string;
  program: string;
  decision: string;
  rule?: string | undefined;
  duration_ms: number;
  exit_code: number;
}

export function ensureExecDirs(): void {
  const { root, exec, execPending, execRunning, logs } = paths();

  for (const folder of [root, exec, execPending, execRunning, logs]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
}

export function newExecId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
}

export async function readRules(): Promise<ExecRule[]> {
  const path = paths().execRules;

  if (!(await Bun.file(path).exists())) {
    return [];
  }

  const rules = rulesFromJson(await Bun.file(path).text());

  if (rules === undefined) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `Invalid rules in ${path}`,
      fix: 'Run corami exec rules to see them, or remove the file to start again',
    });
  }

  return rules;
}

export async function writeRules(rules: ExecRule[]): Promise<void> {
  ensureExecDirs();
  await Bun.write(paths().execRules, rulesJson(rules));
}

export async function readGrants(): Promise<ExecGrant[]> {
  const path = paths().execGrants;

  if (!(await Bun.file(path).exists())) {
    return [];
  }

  return grantsFromJson(await Bun.file(path).text());
}

export async function writeGrants(grants: ExecGrant[]): Promise<void> {
  ensureExecDirs();
  await Bun.write(paths().execGrants, grantsJson(grants));
}

export async function removeGrants(): Promise<void> {
  await removeFile(paths().execGrants);
}

export async function writePending(request: PendingRequest): Promise<void> {
  ensureExecDirs();
  await Bun.write(pendingPath(request.id), `${JSON.stringify(request, null, 2)}\n`);
}

export async function listPending(): Promise<PendingRequest[]> {
  const folder = paths().execPending;
  const requests: PendingRequest[] = [];

  for (const name of jsonFiles(folder)) {
    if (name.endsWith('.decision.json')) {
      continue;
    }

    const text = await Bun.file(`${folder}/${name}`).text();
    const request = parsePending(text);

    if (request !== undefined) {
      requests.push(request);
    }
  }

  return requests.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function removePending(id: string): Promise<void> {
  await removeFile(pendingPath(id));
  await removeFile(decisionPath(id));
}

export function isPending(id: string): boolean {
  return existsSync(pendingPath(id));
}

export function writeDecision(id: string, decision: PendingDecision): boolean {
  if (!isPending(id)) {
    return false;
  }

  try {
    writeFileSync(decisionPath(id), `${JSON.stringify(decision)}\n`, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export async function readDecision(id: string): Promise<PendingDecision | undefined> {
  const path = decisionPath(id);

  if (!(await Bun.file(path).exists())) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const decision = (parsed as Record<string, unknown>).decision;

    return decision === 'allow' || decision === 'deny' ? { decision } : undefined;
  } catch {
    return undefined;
  }
}

export async function writeRunning(command: RunningCommand): Promise<void> {
  ensureExecDirs();
  await Bun.write(runningPath(command.id), `${JSON.stringify(command, null, 2)}\n`);
}

export async function listRunning(): Promise<RunningCommand[]> {
  const folder = paths().execRunning;
  const commands: RunningCommand[] = [];

  for (const name of jsonFiles(folder)) {
    try {
      const parsed: unknown = JSON.parse(await Bun.file(`${folder}/${name}`).text());
      const command = parseRunning(parsed);

      if (command !== undefined) {
        commands.push(command);
      }
    } catch {}
  }

  return commands;
}

export async function removeRunning(id: string): Promise<void> {
  await removeFile(runningPath(id));
}

export function appendExecLog(entry: ExecLogEntry): void {
  ensureExecDirs();
  appendFileSync(paths().execLog, `${JSON.stringify(entry)}\n`);
}

export async function readExecState(): Promise<ExecState | undefined> {
  const path = paths().execState;

  if (!(await Bun.file(path).exists())) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.server !== 'string' || typeof record.since !== 'string') {
      return undefined;
    }

    return {
      server: record.server,
      name: typeof record.name === 'string' ? record.name : record.server,
      since: record.since,
    };
  } catch {
    return undefined;
  }
}

export async function writeExecState(state: ExecState): Promise<void> {
  ensureExecDirs();
  await Bun.write(paths().execState, `${JSON.stringify(state, null, 2)}\n`);
}

export async function removeExecState(): Promise<void> {
  await removeFile(paths().execState);
}

function pendingPath(id: string): string {
  return `${paths().execPending}/${id}.json`;
}

function decisionPath(id: string): string {
  return `${paths().execPending}/${id}.decision.json`;
}

function runningPath(id: string): string {
  return `${paths().execRunning}/${id}.json`;
}

async function removeFile(path: string): Promise<void> {
  try {
    const file = Bun.file(path);

    if (await file.exists()) {
      await file.delete();
    }
  } catch {
    return;
  }
}

function jsonFiles(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

function parsePending(text: string): PendingRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const argv = record.argv;

    if (
      typeof record.id !== 'string' ||
      typeof record.project !== 'string' ||
      typeof record.created_at !== 'string' ||
      !Array.isArray(argv)
    ) {
      return undefined;
    }

    const tokens = argv.filter((token): token is string => typeof token === 'string');

    if (tokens.length === 0) {
      return undefined;
    }

    return {
      id: record.id,
      project: record.project,
      argv: tokens,
      created_at: record.created_at,
    };
  } catch {
    return undefined;
  }
}

function parseRunning(value: unknown): RunningCommand | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id !== 'string' ||
    typeof record.project !== 'string' ||
    typeof record.program !== 'string' ||
    typeof record.pgid !== 'number' ||
    typeof record.started_at !== 'string'
  ) {
    return undefined;
  }

  return {
    id: record.id,
    project: record.project,
    program: record.program,
    pgid: record.pgid,
    started_at: record.started_at,
  };
}
