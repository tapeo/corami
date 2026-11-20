import type { FlagValue } from '@/cli/parser.ts';
import { type CoramiError, type ErrorCode, toCoramiError } from '@/core/errors.ts';

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    fix?: string;
    details?: Record<string, unknown>;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface OutputOptions {
  json: boolean;
  color: boolean;
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
}

const pendingWrites: Promise<void>[] = [];
const streamEnds = new WeakMap<NodeJS.WriteStream, Promise<void>>();
const brokenStreams = new WeakSet<NodeJS.WriteStream>();

function streamEnd(stream: NodeJS.WriteStream): Promise<void> {
  const cached = streamEnds.get(stream);

  if (cached !== undefined) {
    return cached;
  }

  const end = new Promise<void>((resolve) => {
    stream.once('error', () => {
      brokenStreams.add(stream);
      resolve();
    });
    stream.once('close', () => {
      brokenStreams.add(stream);
      resolve();
    });
  });
  streamEnds.set(stream, end);
  return end;
}

export function write(stream: NodeJS.WriteStream, text: string): void {
  const end = streamEnd(stream);

  if (brokenStreams.has(stream)) {
    return;
  }

  if (stream.write(text)) {
    return;
  }

  pendingWrites.push(
    Promise.race([
      new Promise<void>((resolve) => {
        stream.once('drain', () => resolve());
      }),
      end,
    ]),
  );
}

export async function flushOutput(): Promise<void> {
  await Promise.all(pendingWrites);
}

export function success<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

export function failure(error: CoramiError): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    ok: false,
    error: { code: error.code, message: error.message },
  };

  if (error.fix !== undefined) {
    envelope.error.fix = error.fix;
  }

  if (error.details !== undefined) {
    envelope.error.details = error.details;
  }

  return envelope;
}

export function emit<T>(envelope: Envelope<T>, options: OutputOptions): void {
  if (options.json) {
    write(process.stdout, `${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (!envelope.ok) {
    const lines = [`Error: ${envelope.error.message}`, `Code: ${envelope.error.code}`];

    if (envelope.error.fix !== undefined) {
      lines.push(`Fix: ${envelope.error.fix}`);
    }

    write(process.stderr, `${lines.join('\n')}\n`);
    return;
  }

  write(process.stdout, `${renderData(envelope.data)}\n`);
}

export function renderData(data: unknown): string {
  if (data === null || data === undefined) {
    return '';
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  return JSON.stringify(data, null, 2);
}

export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  const widths = columns.map((column) => {
    const cells = rows.map((row) => column.value(row).length);
    return Math.max(column.header.length, ...cells);
  });

  const header = columns
    .map((column, index) => column.header.padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd();

  const body = rows.map((row) =>
    columns
      .map((column, index) => column.value(row).padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd(),
  );

  return [header, ...body].join('\n');
}

export interface StepRow {
  step: string;
  status: string;
  summary: string;
  detail?: string | undefined;
}

export function renderSteps(steps: StepRow[]): string[] {
  const lines = [
    renderTable(steps, [
      { header: 'Step', value: (row) => row.step },
      { header: 'Result', value: (row) => row.status },
      { header: 'Detail', value: (row) => row.summary },
    ]),
  ];

  for (const step of steps) {
    if (step.detail !== undefined) {
      lines.push(`${step.step}: ${step.detail}`);
    }
  }

  return lines;
}

export function renderNextSteps(steps: string[]): string[] {
  if (steps.length === 0) {
    return [];
  }

  if (steps.length === 1) {
    return ['', `Next step: ${steps[0]}`];
  }

  return ['', 'Next steps:', ...steps.map((step) => `  ${step}`)];
}

export function renderOrphanCopies(orphans: Array<{ project: string; local: string }>): string[] {
  return orphans.map(
    (orphan) =>
      `Copy of a removed project: ${orphan.project} at ${orphan.local}. corami sync stop ${orphan.project} stops the sync and keeps the files.`,
  );
}

export function reportError(error: unknown, options: OutputOptions): number {
  const coramiError = toCoramiError(error);
  emit(failure(coramiError), options);
  return coramiError.exitCode;
}

export function resolveOutputOptions(values: Record<string, FlagValue>): OutputOptions {
  const forced = values.json === true;
  const isTty = process.stdout.isTTY === true;
  const color = isTty && process.env.NO_COLOR === undefined;

  return { json: forced || !isTty, color };
}
