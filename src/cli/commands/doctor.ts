import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { shortName } from '@/cli/exec-client-system.ts';
import { health, listClients, listProjects } from '@/cli/server-client.ts';
import { projectRoot, projectsRootFor, readGlobalConfig } from '@/core/config.ts';
import {
  type CheckResult,
  type CheckStatus,
  checkListeningPorts,
  checkPinnedTools,
  checkServeRules,
  checkTailscale,
} from '@/core/doctor.ts';
import { toCoramiError } from '@/core/errors.ts';
import { run as runCommand } from '@/core/exec.ts';
import { findExecLine } from '@/core/exec-ssh-keys.ts';
import { ignoreDrift, ignoresFor } from '@/core/ignore-file.ts';
import { findTool, MUTAGEN } from '@/core/pinned-tools.ts';
import { orphanServerFolders, serverPathsOf } from '@/core/project-add.ts';
import { canSudo, ownerOfServer, privilegedGroups } from '@/core/server-user.ts';
import {
  otherPeople,
  peopleText,
  type SshAccount,
  type SshPolicy,
  sshAccountsText,
  sshExposureFromHealth,
  sshPolicyFromHealth,
  sshPolicyText,
  sshRootText,
} from '@/core/ssh-policy.ts';
import {
  daemonServiceActive,
  MutagenEngine,
  pollingCurrent,
  type SyncSession,
  WATCH_POLLING_SECONDS,
} from '@/integrations/mutagen.ts';
import {
  gitWatchSpec,
  launchAgentPath,
  type ServiceHealth,
  serviceDirHint,
  serviceHealth,
  servicePlatform,
} from '@/integrations/service.ts';
import { sshDir } from '@/integrations/ssh.ts';
import { homeDirectoryForUser, systemctlAsUser } from '@/integrations/systemd.ts';
import { peers, sshState, tailnetLogins } from '@/integrations/tailscale.ts';

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: 'ok',
  warn: 'warning',
  fail: 'error',
  skip: 'skipped',
};

async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const checks = await collectChecks();

  if (context.output.json) {
    return {
      data: {
        counts: countByStatus(checks),
        checks,
      },
    };
  }

  return { text: render(checks) };
}

async function collectChecks(): Promise<CheckResult[]> {
  const groups = await Promise.all([
    checkTailscale(),
    checkServeRules(),
    checkListeningPorts(),
    checkPinnedTools(),
    checkGitService(),
    checkSyncDaemon(),
    checkSyncSessions(),
    checkServerAccount(),
    checkServerDisk(),
    checkOrphanFolders(),
    checkDaemon(),
    checkSsh(),
    checkPeople(),
    checkExec(),
  ]);

  return groups.flat();
}

async function checkDaemon(): Promise<CheckResult[]> {
  const role = (await readGlobalConfig().catch(() => undefined))?.role;

  if (role !== 'server' && role !== 'client') {
    return [];
  }

  try {
    await health();
  } catch (error) {
    const failure = toCoramiError(error);

    return [
      {
        id: 'server.daemon',
        status: 'fail',
        summary: 'The Corami daemon does not answer',
        detail: failure.message,
        fix: failure.fix,
      },
    ];
  }

  return [{ id: 'server.daemon', status: 'ok', summary: 'Corami daemon answers' }];
}

async function checkSsh(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);
  const checks: CheckResult[] = [];

  if (config?.role === 'server') {
    const user = config.server_user;

    if (user === undefined) {
      return [];
    }

    const state = await sshState(user).catch(() => undefined);

    if (state === undefined) {
      return [];
    }

    checks.push(...policyFor(state.policy, user));

    if (state.exposure.root !== undefined) {
      checks.push(rootFor(state.exposure.root));
    }

    checks.push(accountsFor(state.exposure.accounts, user));
  } else if (config?.role === 'client') {
    const answer = await health().catch(() => undefined);
    const user = typeof answer?.user === 'string' ? answer.user : config.server_user;
    const exposure = sshExposureFromHealth(answer);

    checks.push(...policyFor(sshPolicyFromHealth(answer), user));

    if (exposure !== undefined) {
      if (exposure.root !== undefined) {
        checks.push(rootFor(exposure.root));
      }

      if (user !== undefined) {
        checks.push(accountsFor(exposure.accounts, user));
      }
    }
  }

  return checks;
}

async function checkExec(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role === 'client') {
    return checkExecClient(config.server_host ?? '');
  }

  if (config?.role === 'server') {
    return checkExecServer();
  }

  return [];
}

async function checkExecClient(serverHost: string): Promise<CheckResult[]> {
  const server = shortName(serverHost);
  const line = findExecLine(await authorizedKeysText(), server);

  if (line === undefined) {
    return [
      {
        id: 'exec.setup',
        status: 'ok',
        summary: `${server} cannot run commands here: run corami exec setup to connect`,
      },
    ];
  }

  return [
    {
      id: 'exec.setup',
      status: 'ok',
      summary: `${server} can run commands here, in the copies of the projects`,
    },
  ];
}

async function authorizedKeysText(): Promise<string> {
  try {
    return await Bun.file(join(sshDir(), 'authorized_keys')).text();
  } catch {
    return '';
  }
}

async function checkExecServer(): Promise<CheckResult[]> {
  const clients = await listClients().catch(() => []);
  const list = await peers().catch(() => []);
  const unreachable = clients.filter((client) => {
    const peer = list.find(
      (entry) => entry.hostName === client.name || entry.dnsName.split('.')[0] === client.name,
    );

    return peer === undefined || !peer.online;
  });

  if (clients.length === 0) {
    return [
      {
        id: 'exec.clients',
        status: 'ok',
        summary: 'No clients are registered',
      },
    ];
  }

  if (unreachable.length === 0) {
    return [
      {
        id: 'exec.clients',
        status: 'ok',
        summary: `${clients.length} ${clients.length === 1 ? 'client is' : 'clients are'} registered and reachable`,
      },
    ];
  }

  return [
    {
      id: 'exec.clients',
      status: 'warn',
      summary: `Clients that are unreachable: ${unreachable.map((client) => client.name).join(', ')}`,
      fix: 'Wake them, or check Tailscale on both machines',
    },
  ];
}

async function checkPeople(): Promise<CheckResult[]> {
  const logins = await tailnetLogins().catch(() => []);

  if (logins.length === 0) {
    return [];
  }

  const config = await readGlobalConfig().catch(() => undefined);
  const others = otherPeople(logins, config?.owner_login);
  const text = peopleText(others);

  return [
    {
      id: 'tailscale.people',
      status: others.length === 0 ? 'ok' : 'warn',
      summary: text.summary,
      fix: text.fix,
    },
  ];
}

function rootFor(policy: SshPolicy): CheckResult {
  const text = sshRootText(policy);

  return {
    id: 'tailscale.ssh_root',
    status: policy === 'accept' ? 'warn' : 'ok',
    summary: text.summary,
    fix: text.fix,
  };
}

function accountsFor(accounts: readonly SshAccount[], user: string): CheckResult {
  const text = sshAccountsText(accounts, user);

  return {
    id: 'tailscale.ssh_accounts',
    status: accounts.length === 0 ? 'ok' : 'warn',
    summary: text.summary,
    fix: text.fix,
  };
}

function policyFor(policy: SshPolicy | undefined, user: string | undefined): CheckResult[] {
  if (policy === undefined || user === undefined) {
    return [];
  }

  const text = sshPolicyText(policy, user);
  let status: CheckStatus;

  if (policy === 'accept') {
    status = 'ok';
  } else if (policy === 'check') {
    status = 'warn';
  } else {
    status = 'fail';
  }

  return [
    {
      id: 'tailscale.ssh_policy',
      status,
      summary: text.summary,
      fix: text.fix,
    },
  ];
}

interface ServerAccount {
  user: string;
  home: string;
}

async function serverAccount(): Promise<ServerAccount | undefined> {
  const config = await readGlobalConfig().catch(() => undefined);
  const user = ownerOfServer(config);

  if (user === undefined || user === userInfo().username) {
    return undefined;
  }

  const home = await homeDirectoryForUser(user);
  return home === undefined ? undefined : { user, home };
}

async function checkServerAccount(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'server') {
    return [];
  }

  const user = config.server_user;

  if (user === undefined) {
    return [
      {
        id: 'server.account',
        status: 'warn',
        summary: 'No account owns the projects: they live in the home of root',
        detail: 'Run corami setup server --user <account> as root to create one',
      },
    ];
  }

  const projects = await projectsFolderForServer();
  const legacy = join('/root', 'corami', 'projects');
  const [groups, sudo, foreign] = await Promise.all([
    runCommand('id', ['-nG', user]),
    runCommand('sudo', ['-n', '-l', '-U', user]),
    runCommand('find', [projects, '!', '-user', user, '-print', '-quit']),
  ]);
  const checks: CheckResult[] = [
    {
      id: 'server.account',
      status: 'ok',
      summary: `The projects are owned by ${user}`,
      detail: projects,
    },
  ];

  if (existsSync(legacy)) {
    checks.push({
      id: 'server.legacy',
      status: 'fail',
      summary: 'Projects of root are still in /root/corami/projects',
      detail: 'They are not the ones the clients sync',
      fix: 'Move them to the account of the projects, then remove /root/corami',
    });
  }

  const foreignEntry = foreign.ok ? foreign.stdout.trim() : '';

  if (foreignEntry !== '') {
    checks.push({
      id: 'server.owner',
      status: 'warn',
      summary: `Some files in the projects are not owned by ${user}`,
      detail: foreignEntry,
      fix: `chown -R ${user}:${user} ${projects}`,
    });
  }

  const privileged = privilegedGroups(groups.ok ? groups.stdout : '');
  const sudoAllowed = sudo.ok && canSudo(sudo.stdout);

  if (privileged.length > 0 || sudoAllowed) {
    const ways = [...privileged, ...(sudoAllowed ? ['sudo'] : [])].join(', ');

    checks.push({
      id: 'server.privileges',
      status: 'warn',
      summary: `${user} can become root (${ways})`,
      detail: 'The separation only holds when the account that runs the agents is not privileged',
    });
  } else {
    checks.push({
      id: 'server.privileges',
      status: 'ok',
      summary: `${user} cannot become root`,
    });
  }

  return checks;
}

async function projectsFolderForServer(): Promise<string> {
  const config = await readGlobalConfig().catch(() => undefined);
  const user = config?.server_user;

  if (user === undefined) {
    return projectRoot();
  }

  const home = await homeDirectoryForUser(user);

  return home === undefined ? projectRoot() : projectsRootFor(home);
}

async function checkSyncSessions(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'client') {
    return [];
  }

  const sessions = await new MutagenEngine().sessions();

  if (sessions === undefined || sessions.length === 0) {
    return [];
  }

  return [checkSyncIgnores(sessions), checkSyncWatch(sessions)];
}

function checkSyncWatch(sessions: SyncSession[]): CheckResult {
  const stale = sessions.filter((session) => !pollingCurrent(session));

  if (stale.length === 0) {
    return {
      id: 'mutagen.watch',
      status: 'ok',
      summary: `Every session checks the server for changes every ${WATCH_POLLING_SECONDS} s`,
    };
  }

  return {
    id: 'mutagen.watch',
    status: 'warn',
    summary: `${stale.length} sessions check the server for changes less often than every ${WATCH_POLLING_SECONDS} s`,
    detail: stale
      .map((session) => `${session.project}: every ${session.pollingInterval} s`)
      .join('\n'),
    fix: `corami sync refresh ${stale[0]?.project ?? '<project>'}`,
  };
}

function checkSyncIgnores(sessions: SyncSession[]): CheckResult {
  const stale = sessions
    .map((session) => ({ session, drift: ignoreDrift(session.ignore, ignoresFor(session.beta)) }))
    .filter(({ drift }) => drift.missing.length > 0 || drift.extra.length > 0);

  if (stale.length === 0) {
    return {
      id: 'mutagen.ignores',
      status: 'ok',
      summary: 'Every session carries the current exclusions',
    };
  }

  return {
    id: 'mutagen.ignores',
    status: 'warn',
    summary: `${stale.length} sessions carry older exclusions`,
    detail: stale
      .map(({ session, drift }) => {
        const parts = [
          drift.missing.length > 0 ? `missing ${drift.missing.join(', ')}` : '',
          drift.extra.length > 0 ? `no longer ignored ${drift.extra.join(', ')}` : '',
        ].filter((part) => part !== '');

        return `${session.project}: ${parts.join('; ')}`;
      })
      .join('\n'),
    fix: `corami sync refresh ${stale[0]?.session.project ?? '<project>'}`,
  };
}

async function checkServerDisk(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'server') {
    return [];
  }

  const projects = await projectsFolderForServer();
  const result = await runCommand('df', ['-Pk', projects]);

  if (!result.ok) {
    return [];
  }

  const line = result.stdout.trim().split('\n').pop() ?? '';
  const fields = line.split(/\s+/);
  const blocks = Number(fields[1]);
  const available = Number(fields[3]);

  if (!Number.isFinite(blocks) || !Number.isFinite(available) || blocks <= 0) {
    return [];
  }

  const freePercent = Math.round((available / blocks) * 100);

  if (freePercent >= 10) {
    return [
      {
        id: 'server.disk',
        status: 'ok',
        summary: `${freePercent}% of the projects filesystem is free`,
        detail: projects,
      },
    ];
  }

  return [
    {
      id: 'server.disk',
      status: 'fail',
      summary: `${freePercent}% of the projects filesystem is free`,
      detail: projects,
      fix: 'A build cache that the sync carries is the usual cause: corami sync status on the client names the heavy folders, add them to .coramiignore there',
    },
  ];
}

async function checkOrphanFolders(): Promise<CheckResult[]> {
  const config = await readGlobalConfig().catch(() => undefined);

  if (config?.role !== 'server') {
    return [];
  }

  const projects = await listProjects().catch(() => undefined);

  if (projects === undefined) {
    return [];
  }

  const folder = await projectsFolderForServer();
  const orphans = orphanServerFolders(foldersIn(folder), serverPathsOf(projects));

  if (orphans.unregistered.length === 0 && orphans.staging.length === 0) {
    return [
      {
        id: 'server.orphan_folders',
        status: 'ok',
        summary: 'Every folder of the projects root belongs to a project',
        detail: folder,
      },
    ];
  }

  const checks: CheckResult[] = [];

  if (orphans.unregistered.length > 0) {
    checks.push({
      id: 'server.orphan_folders',
      status: 'warn',
      summary: `Folders of the projects root that no project names: ${namesOf(orphans.unregistered)}`,
      detail: orphans.unregistered.join(', '),
      fix: 'From a client: corami project add <folder> --from-server --server-path <path> registers one. Otherwise remove it from the server',
    });
  }

  if (orphans.staging.length > 0) {
    checks.push({
      id: 'server.import_staging',
      status: 'warn',
      summary: `Folders left by an import that stopped: ${namesOf(orphans.staging)}`,
      detail: orphans.staging.join(', '),
      fix: `Remove them from the server: rm -rf ${orphans.staging.join(' ')}`,
    });
  }

  return checks;
}

function foldersIn(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

function namesOf(paths: string[]): string {
  return paths.map((path) => basename(path)).join(', ');
}

async function accountGitHealth(user: string, name: string): Promise<ServiceHealth | undefined> {
  const active = (await systemctlAsUser(user, ['is-active', name])).stdout.trim() === 'active';

  if (active) {
    return { status: 'running', detail: 'running' };
  }

  return { status: 'stopped', detail: 'not running' };
}

async function checkGitService(): Promise<CheckResult[]> {
  const spec = gitWatchSpec(process.execPath);
  const account = await serverAccount();
  const health =
    account === undefined
      ? await serviceHealth(spec).catch(() => undefined)
      : await accountGitHealth(account.user, spec.name);

  if (health?.status === 'running') {
    return [
      {
        id: 'git.service',
        status: 'ok',
        summary: 'git alignment service running',
      },
    ];
  }

  const dir =
    account === undefined ? serviceDirHint() : join(account.home, '.config', 'systemd', 'user');
  const detail = `The service is ${health?.detail ?? 'absent'}. Expected under ${dir} (${servicePlatform()})`;
  const waiting = servicePlatform() === 'macos' && existsSync(launchAgentPath(spec));

  return [
    {
      id: 'git.service',
      status: 'warn',
      summary: 'git alignment service not running',
      detail: waiting ? `${detail}. The plist is there, launchd does not hold the agent` : detail,
      fix: 'corami setup client <server> --step git-watch on a client, corami setup server --step git-watch on the server',
    },
  ];
}

async function checkSyncDaemon(): Promise<CheckResult[]> {
  const role = (await readGlobalConfig().catch(() => undefined))?.role;
  const binary = await findTool(MUTAGEN);

  if (role !== 'client' || binary === undefined) {
    return [];
  }

  const active = await daemonServiceActive(binary).catch(() => false);

  if (active === undefined) {
    return [];
  }

  if (active) {
    return [
      {
        id: 'mutagen.service',
        status: 'ok',
        summary: 'Mutagen daemon service running',
      },
    ];
  }

  return [
    {
      id: 'mutagen.service',
      status: 'warn',
      summary: 'Mutagen daemon service not running: the sync stops after a reboot',
      fix: 'corami setup client <server> --step mutagen-daemon',
    },
  ];
}

function countByStatus(checks: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };

  for (const check of checks) {
    counts[check.status] += 1;
  }

  return counts;
}

function render(checks: CheckResult[]): string {
  if (checks.length === 0) {
    return 'No checks.';
  }

  return checks
    .map((check) => {
      const lines = [`[${STATUS_LABEL[check.status]}] ${check.id}: ${check.summary}`];

      if (check.detail !== undefined) {
        lines.push(`  ${check.detail}`);
      }

      if (check.fix !== undefined) {
        lines.push(`  fix: ${check.fix}`);
      }

      return lines.join('\n');
    })
    .join('\n');
}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Checks network, HTTPS, tools and services',
  usage: 'corami doctor',
  examples: ['corami doctor', 'corami doctor --json'],
  run,
};
