import { validProjectName } from '@/core/projects.ts';

export interface GateProbe {
  v: 1;
  probe: true;
}

export interface GateCommand {
  v: 1;
  project: string;
  argv: string[];
}

export type GateRequest = GateProbe | GateCommand;

export function probeRequest(): GateProbe {
  return { v: 1, probe: true };
}

export function commandRequest(project: string, argv: string[]): GateCommand {
  return { v: 1, project, argv };
}

export function encodeGateRequest(request: GateRequest): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
}

export function parseGateRequest(text: string): GateRequest | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  if (record.v !== 1) {
    return undefined;
  }

  if (record.probe === true) {
    return { v: 1, probe: true };
  }

  const project = record.project;
  const argv = record.argv;

  if (typeof project !== 'string' || !validProjectName(project)) {
    return undefined;
  }

  if (!Array.isArray(argv) || argv.length === 0) {
    return undefined;
  }

  if (!argv.every((token) => typeof token === 'string' && token !== '')) {
    return undefined;
  }

  return { v: 1, project, argv: argv as string[] };
}

export function gatePayload(original: string | undefined): string | undefined {
  if (original === undefined) {
    return undefined;
  }

  const [verb, gate, payload, ...extra] = original.trim().split(/\s+/);

  if (verb !== 'exec' || gate !== 'gate' || payload === undefined || extra.length > 0) {
    return undefined;
  }

  return payload;
}

export type GateCopy = 'ok' | 'missing' | 'pending' | 'unavailable';

export interface GateSession {
  project: string;
  status: string;
}

export function gateCopyDecision(sessions: GateSession[] | undefined, project: string): GateCopy {
  if (sessions === undefined) {
    return 'unavailable';
  }

  const session = sessions.find((entry) => entry.project === project);

  if (session === undefined) {
    return 'missing';
  }

  return session.status === 'watching' ? 'ok' : 'pending';
}
