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
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (!envelope.ok) {
    const lines = [`Error: ${envelope.error.message}`, `Code: ${envelope.error.code}`];

    if (envelope.error.fix !== undefined) {
      lines.push(`Fix: ${envelope.error.fix}`);
    }

    process.stderr.write(`${lines.join('\n')}\n`);
    return;
  }

  process.stdout.write(`${renderData(envelope.data)}\n`);
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
