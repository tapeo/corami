import { CoramiError, ERROR_CODES, type ErrorCode } from '@/core/errors.ts';

export const GATE_ERROR_PREFIX = 'corami-exec-error:';

export function gateErrorLine(error: CoramiError): string {
  const body = { code: error.code, message: error.message, fix: error.fix };

  return `${GATE_ERROR_PREFIX}${JSON.stringify(body)}`;
}

export function gateErrorFromLine(line: string): CoramiError | undefined {
  if (!line.startsWith(GATE_ERROR_PREFIX)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(line.slice(GATE_ERROR_PREFIX.length));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const code = record.code;
  const message = record.message;

  if (typeof message !== 'string' || !ERROR_CODES.includes(code as ErrorCode)) {
    return undefined;
  }

  return new CoramiError({
    code: code as ErrorCode,
    message,
    fix: typeof record.fix === 'string' ? record.fix : undefined,
  });
}

export interface RemoteFailure {
  client: string;
  exitCode: number;
  stderr: string;
}

export function remoteExecError(failure: RemoteFailure): CoramiError | undefined {
  if (failure.exitCode !== 255) {
    return undefined;
  }

  const output = failure.stderr.toLowerCase();

  if (output.includes('permission denied')) {
    return new CoramiError({
      code: 'generic',
      message: `${failure.client} does not allow commands from this server`,
      fix: `On ${failure.client}, run corami exec allow`,
    });
  }

  if (output.includes('host key verification failed')) {
    return new CoramiError({
      code: 'generic',
      message: `The host key of ${failure.client} changed`,
      fix: `On ${failure.client}, run corami exec allow again to register the new key`,
    });
  }

  return new CoramiError({
    code: 'server_unreachable',
    message: `Cannot reach ${failure.client}`,
    fix: `Wake ${failure.client}, check Tailscale on both machines and that sshd runs on ${failure.client} (Remote Login in the Sharing settings on macOS)`,
  });
}
