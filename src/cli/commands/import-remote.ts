import { listProjects } from '@/cli/server-client.ts';
import { CoramiError } from '@/core/errors.ts';
import { run, shellQuote } from '@/core/exec.ts';
import {
  isImportStagingFor,
  serverFolderOverlaps,
  serverPathsOf,
  takenServerFolder,
} from '@/core/project-add.ts';
import { type RemoteHome, remoteFolderState, remoteGitFacts } from '@/core/transfer.ts';

/** The home directory of the account of the server, and what ssh said. */
export async function remoteHome(user: string, host: string): Promise<RemoteHome> {
  const result = await run(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, 'printf %s "$HOME"'],
    {
      timeoutMs: 60_000,
    },
  );

  const home = result.stdout.trim();
  const sshOutput = `${result.stderr}\n${result.stdout}`;

  if (result.ok && home.startsWith('/')) {
    return { home, sshOutput };
  }

  return { home: undefined, sshOutput };
}

export interface ServerFolderCheck {
  host: string;
  user: string;
  /** The folder of the project on the server: the import never writes into it. */
  serverPath: string;
  /** The folder of the import before the registration, next to the project. */
  staging: string;
  /** The folder of this machine, as the command was given it. */
  folder: string;
  /** The HEAD of the folder of this machine. */
  localHead: string;
}

/**
 * Refuses a folder of the server the import does not make: one that is already
 * there with something in it, one that overlaps another project, and one the
 * check cannot read. The command writes into the staging folder alone, and the
 * registration is what gives it the name of the project.
 */
export async function checkServerFolder(state: ServerFolderCheck): Promise<void> {
  const projects = await listProjects().catch((error: unknown) => {
    throw new CoramiError({
      code: 'server_unreachable',
      message: `Cannot read the projects of the server: ${asMessage(error)}`,
      fix: 'Check that the daemon answers, then run the command again',
    });
  });
  const others = serverPathsOf(projects);

  if (serverFolderOverlaps(state.serverPath, others)) {
    const other = overlappingProject(state.serverPath, projects);

    throw new CoramiError({
      code: 'usage',
      message:
        other === undefined
          ? `The folder ${state.serverPath} overlaps another project of the server`
          : `The folder ${state.serverPath} is inside the project at ${other}, or around it`,
      fix: 'Name a free folder of the server: corami project add <folder> --server-path <folder>',
    });
  }

  const target = await remoteFolderState(state.host, state.user, state.serverPath);

  if (target === undefined) {
    throw unreadableFolder(state.serverPath);
  }

  if (target === 'taken') {
    const remote = await remoteGitFacts(state.host, state.user, state.serverPath);

    throw takenServerFolder({
      serverPath: state.serverPath,
      folder: state.folder,
      remoteHead: remote?.head,
      localHead: state.localHead,
    });
  }

  const staging = await remoteFolderState(state.host, state.user, state.staging);

  if (staging === undefined) {
    throw unreadableFolder(state.staging);
  }

  if (staging !== 'missing') {
    throw new CoramiError({
      code: 'usage',
      message: `The folder ${state.staging} is already on the server`,
      fix: 'Run the command again: the import names its folder with the time',
    });
  }
}

function unreadableFolder(path: string): CoramiError {
  return new CoramiError({
    code: 'server_unreachable',
    message: `Cannot read the folder of the server: ${path}`,
    fix: 'Check that ssh works for the account, then run the command again',
  });
}

function overlappingProject(
  serverPath: string,
  projects: Array<{ name: string; path: string }>,
): string | undefined {
  return projects.find((entry) => serverFolderOverlaps(serverPath, [entry.path]))?.name;
}

/**
 * Takes the staging folder away again, with what it holds: only for a folder
 * the import names, which the check before the transfer guaranteed. The result
 * says whether it is gone, so the step can say where the import stopped.
 */
export async function removeStaging(
  user: string,
  host: string,
  serverPath: string,
  staging: string,
): Promise<{ removed: boolean; detail: string }> {
  if (!isImportStagingFor(serverPath, staging)) {
    return {
      removed: false,
      detail: `The folder ${staging} is not the staging of an import into ${serverPath}: it stays`,
    };
  }

  const result = await run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      `${user}@${host}`,
      `rm -rf ${shellQuote(staging)}`,
    ],
    { timeoutMs: 60_000 },
  );

  return result.ok
    ? { removed: true, detail: `The folder ${staging} was removed from the server` }
    : {
        removed: false,
        detail: `The folder stays at ${host}:${staging}: ${
          (result.stderr || result.stdout).trim() || `ssh exited with ${result.exitCode}`
        }`,
      };
}

/**
 * The command the server runs to receive the archive: unpack it into the
 * staging folder of the import. The sync never carries the paths of one
 * machine, and the archive leaves them out too, so there is nothing to protect.
 */
export function remoteExtractCommand(folder: string): string {
  return `mkdir -p ${shellQuote(folder)} && tar -xzf - --no-same-owner -C ${shellQuote(folder)}`;
}

/**
 * The bytes of the archive counted, then compressed: the count is of the
 * stream `tar` writes, the wire carries gzip. The server runs the same `tar -xzf`
 * it always ran, whatever the transport accepts for `ssh -C`.
 */
export function countingStream(
  source: ReadableStream<Uint8Array>,
  onBytes?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  let sent = 0;

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        onBytes?.(sent);
        controller.enqueue(chunk);
      },
    }),
  );
}

export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(
    new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>,
  );
}

/**
 * The archive reaches the server through a pipe: `tar` writes it, this process
 * counts it and compresses it, `ssh` carries it. All are started with their
 * arguments, never through a shell, and both exit codes are checked: a failure
 * of `tar` would otherwise show as the exit code of `ssh` alone. Counting here
 * is what the progress line knows against the bytes of the files: `ssh -C`
 * depends on what the server accepts, gzip does not, and the server still
 * receives the archive it always received.
 */
export async function transfer(
  source: string,
  user: string,
  host: string,
  folder: string,
  entries: string[],
  onBytes?: (bytes: number) => void,
): Promise<{ ok: boolean; detail: string }> {
  const remote = remoteExtractCommand(folder);
  // The list decides what the archive holds: `tar` follows no folder and
  // matches no pattern, so a link is carried as a link and nothing the
  // inventory left out can slip in.
  const reader = Bun.spawn(
    ['tar', '-cf', '-', '-C', source, '--null', '--no-recursion', '-T', '-'],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  reader.stdin.write(`${entries.join('\0')}\0`);
  await reader.stdin.end();

  const counted = countingStream(reader.stdout, onBytes);

  const writer = Bun.spawn(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `${user}@${host}`, remote],
    {
      stdin: gzipStream(counted),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const timeout = setTimeout(() => {
    reader.kill();
    writer.kill();
  }, 1_800_000);

  // The archive flows through this process: an `ssh` that exits early would
  // leave `tar` blocked on a full pipe until the timeout. Its exit is the
  // signal that nobody is reading any more.
  void writer.exited.then((code) => {
    if (code !== 0) {
      reader.kill();
    }
  });

  try {
    const [read, written] = await Promise.all([
      reader.exited.then(async (code) => ({
        code,
        noise: await new Response(reader.stderr).text(),
      })),
      writer.exited.then(async (code) => ({
        code,
        error: await new Response(writer.stderr).text(),
      })),
    ]);

    if (read.code !== 0 || written.code !== 0) {
      const detail = cleanTarNoise(written.code !== 0 ? written.error : read.noise);

      return {
        ok: false,
        detail: detail === '' ? `tar exited with ${read.code}, ssh with ${written.code}` : detail,
      };
    }

    return { ok: true, detail: cleanTarNoise(written.error) };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanTarNoise(raw: string): string {
  const noise = /^tar: (Ignoring unknown extended header keyword|Removing leading)/;

  return raw
    .split('\n')
    .filter((line) => line.trim() !== '' && !noise.test(line.trim()))
    .slice(0, 3)
    .join(' ');
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
