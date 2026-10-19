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
  serverPath: string;
  staging: string;
  folder: string;
  localHead: string;
}

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

export function remoteExtractCommand(folder: string): string {
  return `mkdir -p ${shellQuote(folder)} && tar -xzf - --no-same-owner -C ${shellQuote(folder)}`;
}

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

export async function transfer(
  source: string,
  user: string,
  host: string,
  folder: string,
  entries: string[],
  onBytes?: (bytes: number) => void,
): Promise<{ ok: boolean; detail: string }> {
  const remote = remoteExtractCommand(folder);
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
