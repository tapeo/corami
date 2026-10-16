export const ERROR_CODES = [
  'capability_missing',
  'server_unreachable',
  'sync_conflict',
  'local_only_files',
  'project_exists',
  'config_invalid',
  'usage',
  'generic',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT_CODES = {
  ok: 0,
  generic: 1,
  usage: 2,
  capability: 3,
  sync_conflict: 4,
  server_unreachable: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const EXIT_CODE_BY_ERROR: Record<ErrorCode, ExitCode> = {
  capability_missing: EXIT_CODES.capability,
  server_unreachable: EXIT_CODES.server_unreachable,
  sync_conflict: EXIT_CODES.sync_conflict,
  local_only_files: EXIT_CODES.generic,
  project_exists: EXIT_CODES.generic,
  config_invalid: EXIT_CODES.generic,
  usage: EXIT_CODES.usage,
  generic: EXIT_CODES.generic,
};

export interface CoramiErrorOptions {
  code: ErrorCode;
  message: string;
  fix?: string | undefined;
  details?: Record<string, unknown> | undefined;
  exitCode?: ExitCode | undefined;
}

export class CoramiError extends Error {
  readonly code: ErrorCode;
  readonly fix: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly exitCode: ExitCode;

  constructor(options: CoramiErrorOptions) {
    super(options.message);
    this.name = 'CoramiError';
    this.code = options.code;
    this.fix = options.fix;
    this.details = options.details;
    this.exitCode = options.exitCode ?? EXIT_CODE_BY_ERROR[options.code];
  }
}

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_CODE_BY_ERROR[code];
}

export function toCoramiError(error: unknown): CoramiError {
  if (error instanceof CoramiError) {
    return error;
  }

  if (error instanceof Error) {
    return new CoramiError({ code: 'generic', message: error.message });
  }

  return new CoramiError({ code: 'generic', message: String(error) });
}
