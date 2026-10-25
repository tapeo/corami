import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { GATE_ERROR_PREFIX, gateErrorFromLine, remoteExecError } from '@/core/exec-errors.ts';
import type { ClientRow } from '@/core/state.ts';
import { execKeyPath } from '@/integrations/ssh.ts';

export interface RemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteOptions {
  stream?: boolean | undefined;
  terminal?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export async function runOnClient(
  client: ClientRow,
  payload: string,
  options: RemoteOptions = {},
): Promise<RemoteResult> {
  const key = execKeyPath();

  if (!existsSync(key)) {
    throw new CoramiError({
      code: 'config_invalid',
      message: 'The dedicated key of the server for corami exec is missing',
      fix: 'Restart the daemon on the server, or call GET /v1/exec/key',
    });
  }

  const knownHosts = paths().execKnownHosts;

  mkdirSync(dirname(knownHosts), { recursive: true, mode: 0o700 });

  if (!existsSync(knownHosts)) {
    await Bun.write(knownHosts, '');
  }

  const terminal = options.terminal === true;
  const child = Bun.spawn({
    cmd: [
      'ssh',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=10',
      terminal ? '-tt' : '-T',
      `${client.ssh_user}@${client.ssh_host}`,
      `exec gate ${payload}`,
    ],
    stdin: 'inherit',
    stdout: stdoutMode(terminal),
    stderr: 'pipe',
  });

  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          child.kill();
        }, options.timeoutMs);

  const stdoutReader = new StreamReader(options.stream === true);
  const stderrReader = new StderrReader(options.stream === true);
  const [stdout, stderr, exitCode] = await Promise.all([
    readStdout(stdoutReader, child.stdout),
    stderrReader.read(child.stderr),
    child.exited,
  ]);

  if (timer !== undefined) {
    clearTimeout(timer);
  }

  if (stderrReader.gateError !== undefined) {
    throw stderrReader.gateError;
  }

  const failure = remoteExecError({ client: client.name, exitCode, stderr });

  if (failure !== undefined) {
    throw failure;
  }

  return { exitCode, stdout, stderr };
}

function stdoutMode(terminal: boolean): 'inherit' | 'pipe' {
  if (terminal) {
    return 'inherit';
  }

  return 'pipe';
}

async function readStdout(
  reader: StreamReader,
  source: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (source === undefined) {
    return '';
  }

  return reader.read(source);
}

class StreamReader {
  private readonly stream: boolean;
  private output = '';

  constructor(stream: boolean) {
    this.stream = stream;
  }

  async read(source: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    const reader = source.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const piece = decoder.decode(value, { stream: true });
      this.output += piece;

      if (this.stream) {
        process.stdout.write(piece);
      }
    }

    return this.output + decoder.decode();
  }
}

class StderrReader {
  readonly stream: boolean;
  output = '';
  gateError: CoramiError | undefined;
  private pending = '';
  private atLineStart = true;

  constructor(stream: boolean) {
    this.stream = stream;
  }

  async read(source: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    const reader = source.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      this.push(decoder.decode(value, { stream: true }), false);
    }

    this.push(decoder.decode(), true);

    return this.output;
  }

  private push(chunk: string, final: boolean): void {
    this.pending += chunk;

    for (;;) {
      if (this.pending === '') {
        return;
      }

      if (this.atLineStart && this.pending.startsWith(GATE_ERROR_PREFIX)) {
        const newline = this.pending.indexOf('\n');

        if (newline === -1) {
          if (!final) {
            return;
          }

          this.write(this.pending);
          this.pending = '';
          return;
        }

        const line = this.pending.slice(0, newline);
        const error = gateErrorFromLine(line);

        if (error !== undefined) {
          this.gateError = error;
          this.pending = this.pending.slice(newline + 1);
          continue;
        }

        this.atLineStart = false;
        continue;
      }

      if (this.atLineStart && GATE_ERROR_PREFIX.startsWith(this.pending)) {
        if (final) {
          this.write(this.pending);
          this.pending = '';
        }

        return;
      }

      this.atLineStart = false;

      const newline = this.pending.indexOf('\n');

      if (newline === -1) {
        this.write(this.pending);
        this.pending = '';
        return;
      }

      this.write(this.pending.slice(0, newline + 1));
      this.pending = this.pending.slice(newline + 1);
      this.atLineStart = true;
    }
  }

  private write(text: string): void {
    this.output += text;

    if (this.stream) {
      process.stderr.write(text);
    }
  }
}
