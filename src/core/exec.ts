export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function redactUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(url);

  if (scheme === null) {
    return url;
  }

  const [, prefix, authority, rest] = scheme;
  const at = authority?.lastIndexOf('@') ?? -1;

  if (authority === undefined || rest === undefined || at === -1) {
    return url;
  }

  return `${prefix}${authority.slice(at + 1)}${rest}`;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'ignore' | 'inherit' | 'pipe';
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

function mergeEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  if (env === undefined) {
    return merged;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const spawnOptions = {
    cmd: [command, ...args],
    env: mergeEnv(options.env),
    stdin: options.stdin ?? ('ignore' as const),
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };

  let child: Bun.Subprocess<'ignore' | 'inherit' | 'pipe', 'pipe', 'pipe'>;

  try {
    child = Bun.spawn(
      options.cwd === undefined ? spawnOptions : { ...spawnOptions, cwd: options.cwd },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { ok: false, stdout: '', stderr: message, exitCode: 127 };
  }

  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          child.kill();
        }, options.timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    readText(child.stderr, options.onStderr),
    child.exited,
  ]);

  if (timer !== undefined) {
    clearTimeout(timer);
  }

  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

async function readText(
  stream: ReadableStream<Uint8Array>,
  onChunk: ((chunk: string) => void) | undefined,
): Promise<string> {
  if (onChunk === undefined) {
    return new Response(stream).text();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const piece = decoder.decode(value, { stream: true });
    text += piece;
    onChunk(piece);
  }

  return text + decoder.decode();
}

export async function runOrThrow(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const result = await run(command, args, options);

  if (!result.ok) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${command} exited with ${result.exitCode}: ${detail}`);
  }

  return result;
}

export async function commandPath(name: string): Promise<string | undefined> {
  const result = await run('which', [name]);

  if (!result.ok) {
    return undefined;
  }

  const path = result.stdout.trim();
  return path === '' ? undefined : path;
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
