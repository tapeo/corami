import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { tailnetIdentity } from '@/cli/exec-client-system.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { syncPeers } from '@/core/git-peers-sync.ts';
import { projectOfCopy } from '@/core/projects.ts';
import { MutagenEngine, type SyncProgress, type SyncSession } from '@/integrations/mutagen.ts';

export async function requireClient(action: string): Promise<void> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role === 'client') {
    return;
  }

  throw new CoramiError({
    code: 'config_invalid',
    message: `corami sync ${action} runs on a client`,
    fix: `On the client, run corami sync ${action} <project>`,
  });
}

export function canonicalPath(path: string): string {
  const real = realPath(path);

  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real;
}

function realPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;

  while (!existsSync(existing)) {
    const parent = dirname(existing);

    if (parent === existing) {
      return absolute;
    }

    existing = parent;
  }

  try {
    return join(realpathSync.native(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

export async function syncSessions(engine: MutagenEngine): Promise<SyncSession[]> {
  const sessions = await engine.sessions();

  if (sessions === undefined) {
    throw new CoramiError({
      code: 'capability_missing',
      message: 'Mutagen did not answer: no way to tell which local copies this machine has',
      fix: 'corami doctor checks the sync engine on this machine',
    });
  }

  return sessions;
}

export async function projectFromCwd(): Promise<string | undefined> {
  const sessions = await syncSessions(new MutagenEngine());

  return projectOfCopy(
    canonicalPath(process.cwd()),
    sessions.map((session) => ({ project: session.project, local: canonicalPath(session.beta) })),
  );
}

export async function projectNameOf(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }

  const found = await projectFromCwd();

  if (found === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing project',
      fix: 'Give the project name, or run the command from inside the local copy',
    });
  }

  return found;
}

export async function waitFirstSync(
  engine: MutagenEngine,
  project: string,
  update: (progress: SyncProgress) => void,
  timeoutMs = 0,
): Promise<SyncProgress | undefined> {
  const start = Date.now();

  for (;;) {
    const progress = await engine.progress(project);

    if (progress === undefined) {
      return undefined;
    }

    update(progress);

    if (progress.state === 'done' || progress.state === 'halted') {
      return progress;
    }

    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
      return progress;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function publishPeerHead(root: string): Promise<void> {
  const machine = (await tailnetIdentity()).name;

  await syncPeers(root, { machine }).catch(() => undefined);
}
