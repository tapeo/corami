import { userInfo } from 'node:os';
import { join } from 'node:path';

import type { StepContext, StepResult } from '@/cli/commands/setup-steps.ts';
import { run } from '@/core/exec.ts';
import { isValidServerUser, ownerBinary, type ServerStep } from '@/core/server-user.ts';
import { homeDirectoryForUser, userId } from '@/integrations/systemd.ts';
import { setOperator } from '@/integrations/tailscale.ts';

const RUNTIME_DIR_POLLS = 20;

export async function stepServerUser(context: StepContext): Promise<StepResult> {
  const user = context.serverUser;
  const done = (summary: string, detail?: string): StepResult => ({
    step: 'user',
    status: 'done',
    summary,
    detail,
  });

  if (!isValidServerUser(user)) {
    return {
      step: 'user',
      status: 'failed',
      summary: `"${user}" is not a name an account can have`,
      detail: 'A lowercase name of letters, digits, underscores and hyphens, at most 32 characters',
    };
  }

  if (context.dryRun) {
    const existing = await homeDirectoryForUser(user);
    return {
      step: 'user',
      status: 'skipped',
      summary: `Would prepare the account ${user}`,
      detail: existing === undefined ? 'Would create it' : existing,
    };
  }

  let home = await homeDirectoryForUser(user);
  let created = false;

  if (home === undefined) {
    const result = await run('useradd', ['--create-home', '--shell', '/bin/bash', user]);

    if (!result.ok) {
      return {
        step: 'user',
        status: 'failed',
        summary: `Cannot create the account ${user}`,
        detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' '),
      };
    }

    home = await homeDirectoryForUser(user);
    created = true;
  }

  if (home === undefined) {
    return {
      step: 'user',
      status: 'failed',
      summary: `The account ${user} has no home directory`,
    };
  }

  let failed = await copyAuthorizedKeys(home);

  if (failed === undefined) {
    failed = await enableLinger(user);
  }

  if (failed === undefined) {
    failed = await waitForRuntimeDir(user);
  }

  if (failed === undefined) {
    failed = await copyBinary(home);
  }

  if (failed === undefined) {
    failed = await addBinToPath(home);
  }

  if (failed !== undefined) {
    return { step: 'user', status: 'failed', summary: failed };
  }

  const operator = (await setOperator(user)).ok ? ', operator of tailscale' : '';

  return done(
    created ? `Created the account ${user}` : `Account ${user} ready`,
    `${home}${operator}`,
  );
}

export async function runStepAsOwner(context: StepContext, step: ServerStep): Promise<StepResult> {
  const user = context.serverUser;
  const home = (await homeDirectoryForUser(user)) ?? defaultHome(user);
  const uid = await userId(user);
  const args = [
    '-u',
    user,
    '--',
    ownerBinary(home),
    'setup',
    'server',
    '--step',
    step,
    '--user',
    user,
    '--json',
  ];

  if (context.fqdn !== undefined) {
    args.push('--fqdn', context.fqdn);
  }

  if (context.ownerLogin !== undefined) {
    args.push('--owner', context.ownerLogin);
  }

  const result = await run('runuser', args, {
    cwd: home,
    env: {
      HOME: home,
      ...(uid === undefined ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
    },
    timeoutMs: 5 * 60_000,
  });
  const parsed = parseStepEnvelope(result.stdout);

  if (parsed !== undefined) {
    return parsed;
  }

  return {
    step,
    status: 'failed',
    summary: `The step ${step} did not run as ${user}`,
    detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' '),
  };
}

function parseStepEnvelope(stdout: string): StepResult | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const data = (parsed as { data?: unknown }).data;

  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const list = (data as { steps?: unknown }).steps;

  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }

  const first = list[0] as StepResult;

  return typeof first.step === 'string' && typeof first.status === 'string' ? first : undefined;
}

async function copyAuthorizedKeys(home: string): Promise<string | undefined> {
  const source = '/root/.ssh/authorized_keys';
  const sshDir = join(home, '.ssh');
  const target = join(sshDir, 'authorized_keys');

  if (!(await Bun.file(source).exists())) {
    return undefined;
  }

  await run('mkdir', ['-p', sshDir]);
  const result = await run('cp', ['-f', source, target]);

  if (!result.ok) {
    return `Cannot copy the SSH keys into ${home}`;
  }

  await run('chown', ['-R', `${await ownerOf(home)}:${await groupOf(home)}`, sshDir]);
  await run('chmod', ['700', sshDir]);
  await run('chmod', ['600', target]);

  return undefined;
}

async function enableLinger(user: string): Promise<string | undefined> {
  const result = await run('loginctl', ['enable-linger', user]);

  return result.ok ? undefined : `Cannot enable linger for ${user}`;
}

async function waitForRuntimeDir(user: string): Promise<string | undefined> {
  const uid = await userId(user);

  if (uid === undefined) {
    return `The account ${user} has no user id`;
  }

  for (let attempt = 0; attempt < RUNTIME_DIR_POLLS; attempt += 1) {
    if ((await run('test', ['-d', `/run/user/${uid}`])).ok) {
      return undefined;
    }

    await Bun.sleep(500);
  }

  return `The runtime directory of ${user} does not exist yet: is systemd running?`;
}

async function copyBinary(home: string): Promise<string | undefined> {
  const source = process.execPath;
  const target = ownerBinary(home);

  if (source === target || !(await Bun.file(source).exists())) {
    return undefined;
  }

  if ((await Bun.file(target).exists()) && (await sameFile(source, target))) {
    return undefined;
  }

  await run('mkdir', ['-p', join(home, '.corami', 'bin')]);
  const result = await run('cp', ['-f', source, target]);

  if (!result.ok) {
    return `Cannot copy the binary into ${home}`;
  }

  await run('chown', [
    '-R',
    `${await ownerOf(home)}:${await groupOf(home)}`,
    join(home, '.corami'),
  ]);

  return undefined;
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    Bun.file(left)
      .arrayBuffer()
      .then((buffer) => new Bun.CryptoHasher('sha256').update(buffer).digest('hex')),
    Bun.file(right)
      .arrayBuffer()
      .then((buffer) => new Bun.CryptoHasher('sha256').update(buffer).digest('hex')),
  ]);

  return a === b;
}

async function addBinToPath(home: string): Promise<string | undefined> {
  const profile = join(home, '.bashrc');
  const line = `export PATH="${join(home, '.corami', 'bin')}:$PATH"`;
  const existing = (await Bun.file(profile).exists()) ? await Bun.file(profile).text() : '';

  if (existing.split('\n').some((entry) => entry.trim() === line)) {
    return undefined;
  }

  const prefix = existing !== '' && !existing.endsWith('\n') ? `${existing}\n` : existing;
  await Bun.write(profile, `${prefix}\n# corami\n${line}\n`);
  await run('chown', [`${await ownerOf(home)}:${await groupOf(home)}`, profile]);

  return undefined;
}

async function ownerOf(home: string): Promise<string> {
  const result = await run('stat', ['-c', '%U', home]);
  return result.ok && result.stdout.trim() !== '' ? result.stdout.trim() : '0';
}

async function groupOf(home: string): Promise<string> {
  const result = await run('stat', ['-c', '%G', home]);
  return result.ok && result.stdout.trim() !== '' ? result.stdout.trim() : '0';
}

function defaultHome(user: string): string {
  const parent = userInfo().homedir.replace(/\/[^/]+\/?$/, '');
  return join(parent === '' ? '/home' : parent, user);
}
