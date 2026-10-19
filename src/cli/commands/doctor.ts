import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { health, listProjects } from '@/cli/server-client.ts';
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
import { daemonServiceActive } from '@/integrations/mutagen.ts';
import {
  gitWatchSpec,
  serviceActive,
  serviceDirHint,
  servicePlatform,
} from '@/integrations/service.ts';
import { homeDirectoryForUser, systemctlAsUser } from '@/integrations/systemd.ts';
import { sshState, tailnetLogins } from '@/integrations/tailscale.ts';

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
    checkServerAccount(),
    checkOrphanFolders(),
    checkDaemon(),
    checkSsh(),
    checkPeople(),
  ]);

  return groups.flat();
}

// Both roles: the daemon answers, from the server on the loopback, from a
// client through `tailscale serve`. A service that did not come back after a
// reboot shows here, before a command fails on it.
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

// Both roles: the server reads the netmap, a client the fields the daemon
// reports. The account of the projects is the one the commands use; root and
// the other accounts are what the policy does with the rest of the machine.
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

// Warns when the tailnet holds people who are not the owner: they reach every
// preview and agent published with `tailscale serve`.
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

// Servers only, and only when this process is not the account: the home, the
// projects and the user units of the account are then somewhere else.
async function serverAccount(): Promise<ServerAccount | undefined> {
  const config = await readGlobalConfig().catch(() => undefined);
  const user = ownerOfServer(config);

  if (user === undefined || user === userInfo().username) {
    return undefined;
  }

  const home = await homeDirectoryForUser(user);
  return home === undefined ? undefined : { user, home };
}

// Servers only: the account that owns the projects. Root would work, but a
// wrong agent or dependency would then take the whole machine, so it is worth
// a warning rather than nothing. The paths are the ones of the account, which
// are not the ones of the home of this process when doctor runs as root.
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

/** The projects root of the account that owns the projects, not of this process. */
async function projectsFolderForServer(): Promise<string> {
  const config = await readGlobalConfig().catch(() => undefined);
  const user = config?.server_user;

  if (user === undefined) {
    return projectRoot();
  }

  const home = await homeDirectoryForUser(user);

  return home === undefined ? projectRoot() : projectsRootFor(home);
}

// Servers only: a folder of the projects root that no project names is a
// leftover, the one an import that stopped leaves included. The import writes
// into a staging folder next to the project, so a stopped one never takes the
// name of a project, but it stays on disk until someone removes it.
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

async function checkGitService(): Promise<CheckResult[]> {
  const spec = gitWatchSpec(process.execPath);
  const account = await serverAccount();
  const active =
    account === undefined
      ? await serviceActive(spec).catch(() => false)
      : (await systemctlAsUser(account.user, ['is-active', spec.name])).stdout.trim() === 'active';

  if (active) {
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

  return [
    {
      id: 'git.service',
      status: 'warn',
      summary: 'git alignment service not running',
      detail: `Expected under ${dir} (${servicePlatform()})`,
      fix: 'corami setup client <server> --step git-watch on a client, corami setup server --step git-watch on the server',
    },
  ];
}

// Clients only: without the Mutagen daemon as a service, the sync sessions stay
// paused after a reboot until the next mutagen command.
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
