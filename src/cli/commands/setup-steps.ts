import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { Prompter } from '@/cli/prompt.ts';
import { type GlobalConfig, paths, readGlobalConfig, writeGlobalConfig } from '@/core/config.ts';
import { CoramiError, type ErrorCode } from '@/core/errors.ts';
import { run, runOrThrow } from '@/core/exec.ts';
import { isTailnetOnlyFirewall } from '@/core/setup-choices.ts';
import { otherPeople, PROTECTIONS_OFF, protectionsOff, sshPolicyText } from '@/core/ssh-policy.ts';
import { gitWatchSpec, installService } from '@/integrations/service.ts';
import {
  enableLinger,
  homeDirectoryForUser,
  installUnit,
  isUnitActive,
} from '@/integrations/systemd.ts';
import {
  serveHttps,
  sshState,
  type TailscaleStatus,
  tailnetLogins,
  status as tailscaleStatusRaw,
} from '@/integrations/tailscale.ts';

async function tailscaleStatus(): Promise<TailscaleStatus> {
  return tailscaleStatusRaw().catch(() => ({
    installed: false,
    running: false,
    online: false,
    dnsName: undefined,
    tailnetName: undefined,
    ipv4: undefined,
  }));
}

export interface StepContext {
  root: boolean;
  hostname: string;
  serverUser: string;
  daemonScope?: 'user' | 'system' | undefined;
  fqdn?: string | undefined;
  authKey?: string | undefined;
  ownerLogin?: string | undefined;
  dryRun: boolean;
}

export interface StepResult {
  step: string;
  status: 'done' | 'skipped' | 'failed' | 'waiting';
  summary: string;
  code?: ErrorCode | undefined;
  detail?: string | undefined;
  scope?: 'user' | 'system' | undefined;
}

export function isRoot(): boolean {
  return (process.getuid?.() ?? 1) === 0;
}

export function failSteps(steps: StepResult[], command: string): void {
  const failed = steps.find((step) => step.status === 'failed');

  if (failed === undefined) {
    return;
  }

  throw new CoramiError({
    code: failed.code ?? 'generic',
    message: `Setup stopped at ${failed.step}: ${failed.summary}`,
    fix: failed.detail ?? `Run corami ${command} again`,
    details: { steps },
  });
}

async function hasTailscale(): Promise<boolean> {
  const result = await run('which', ['tailscale']);
  return result.ok;
}

export function extractLoginUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/);
  return match?.[0];
}

async function waitForTailscaled(): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await run('tailscale', ['status']);

    if (result.ok) {
      return true;
    }

    await Bun.sleep(1000);
  }

  return false;
}

async function fileHasLine(path: string, line: string): Promise<boolean> {
  if (!existsSync(path)) {
    return false;
  }

  const content = await Bun.file(path).text();
  return content.split('\n').some((entry) => entry.trim() === line.trim());
}

export async function stepPreflight(context: StepContext): Promise<StepResult> {
  if (!context.dryRun && process.platform !== 'linux') {
    return {
      step: 'preflight',
      status: 'failed',
      summary: `The server role runs on Linux, this is ${process.platform}`,
    };
  }

  return {
    step: 'preflight',
    status: 'done',
    summary: `${process.platform} ${process.arch}, root: ${context.root ? 'yes' : 'no'}`,
  };
}

export async function stepPackages(context: StepContext): Promise<StepResult> {
  const wanted = ['git', 'curl', 'ca-certificates', 'unzip'];
  const missing: string[] = [];

  for (const name of wanted) {
    const result = await run('which', [name]);

    if (!result.ok) {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    return { step: 'packages', status: 'done', summary: 'Required packages present' };
  }

  if (context.dryRun) {
    return { step: 'packages', status: 'skipped', summary: `Would install: ${missing.join(', ')}` };
  }

  if (!context.root) {
    return {
      step: 'packages',
      status: 'failed',
      summary: `Missing packages: ${missing.join(', ')}`,
      detail: 'Run setup as root, or install them first',
    };
  }

  await runOrThrow('apt-get', ['update']);
  await runOrThrow('apt-get', ['install', '-y', ...missing]);

  return { step: 'packages', status: 'done', summary: `Installed: ${missing.join(', ')}` };
}

export async function stepTailscale(context: StepContext): Promise<StepResult> {
  const current = await tailscaleStatus();

  if (current.installed && current.online) {
    return {
      step: 'tailscale',
      status: 'done',
      summary: 'Tailscale already connected',
      detail: current.dnsName,
    };
  }

  if (context.dryRun) {
    return { step: 'tailscale', status: 'skipped', summary: 'Would install and connect Tailscale' };
  }

  if (!context.root) {
    return { step: 'tailscale', status: 'failed', summary: 'Root required to install Tailscale' };
  }

  if (!current.installed) {
    const script = await run('curl', ['-fsSL', 'https://tailscale.com/install.sh']);

    if (!script.ok) {
      return {
        step: 'tailscale',
        status: 'failed',
        summary: 'Cannot download the Tailscale install script',
      };
    }

    const installer = Bun.spawn(['sh'], {
      stdin: new Blob([script.stdout]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(installer.stdout).text(),
      new Response(installer.stderr).text(),
      installer.exited,
    ]);

    if (code !== 0) {
      return {
        step: 'tailscale',
        status: 'failed',
        summary: `Tailscale installer exited with ${code}`,
        detail: `${stdout}${stderr}`.trim().split('\n').slice(-3).join(' '),
      };
    }
  }

  await run('systemctl', ['enable', '--now', 'tailscaled']);
  await waitForTailscaled();

  const args = ['up', '--ssh', '--hostname', context.hostname];

  if (context.authKey !== undefined) {
    args.push(`--auth-key=${context.authKey}`);
  } else {
    const interactive = await run('tailscale', args, { timeoutMs: 30_000 });
    const loginUrl = extractLoginUrl(`${interactive.stdout}${interactive.stderr}`);

    if (!interactive.ok && loginUrl !== undefined) {
      return {
        step: 'tailscale',
        status: 'waiting',
        summary: 'Login to Tailscale required',
        detail: loginUrl,
      };
    }

    const after = await tailscaleStatus();

    return after.online
      ? { step: 'tailscale', status: 'done', summary: 'Tailscale connected', detail: after.dnsName }
      : {
          step: 'tailscale',
          status: 'failed',
          summary: 'tailscale up failed',
          detail: `${interactive.stderr}${interactive.stdout}`
            .trim()
            .split('\n')
            .slice(0, 3)
            .join(' '),
        };
  }

  const result = await run('tailscale', args);

  if (!result.ok) {
    return {
      step: 'tailscale',
      status: 'failed',
      summary: 'tailscale up failed',
      detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' '),
    };
  }

  const updated = await tailscaleStatus();

  return {
    step: 'tailscale',
    status: 'done',
    summary: 'Tailscale connected',
    detail: updated.dnsName,
  };
}

export async function stepHostsEntry(context: StepContext): Promise<StepResult> {
  if (context.fqdn === undefined) {
    return { step: 'hosts', status: 'skipped', summary: 'No FQDN known yet' };
  }

  const current = await tailscaleStatus();
  const line = `${current.ipv4 ?? '127.0.0.1'} ${context.fqdn}`;

  if (await fileHasLine('/etc/hosts', context.fqdn)) {
    return { step: 'hosts', status: 'done', summary: `/etc/hosts already maps ${context.fqdn}` };
  }

  if (context.dryRun) {
    return { step: 'hosts', status: 'skipped', summary: `Would add to /etc/hosts: ${line}` };
  }

  if (!context.root) {
    return { step: 'hosts', status: 'failed', summary: 'Root required to edit /etc/hosts' };
  }

  await Bun.write('/etc/hosts', `${await Bun.file('/etc/hosts').text()}\n${line}\n`);

  return { step: 'hosts', status: 'done', summary: `Added to /etc/hosts: ${line}` };
}

export async function stepFirewall(context: StepContext): Promise<StepResult> {
  if (context.dryRun) {
    return {
      step: 'firewall',
      status: 'skipped',
      summary: 'Would deny incoming traffic except tailscale0',
    };
  }

  if (!context.root) {
    return {
      step: 'firewall',
      status: 'failed',
      summary: 'Root required to configure the firewall',
    };
  }

  const ss = await run('which', ['ss']);

  if (!ss.ok) {
    await run('apt-get', ['update']);
    await run('apt-get', ['install', '-y', 'iproute2']);
  }

  if (!(await run('which', ['ufw'])).ok) {
    await run('apt-get', ['update']);
    await run('apt-get', ['install', '-y', 'ufw']);
  }

  await run('ufw', ['default', 'deny', 'incoming']);
  await run('ufw', ['default', 'allow', 'outgoing']);
  await run('ufw', ['allow', 'in', 'on', 'tailscale0']);
  const enabled = await run('ufw', ['--force', 'enable']);

  if (!enabled.ok) {
    return {
      step: 'firewall',
      status: 'failed',
      summary: 'ufw enable failed',
      detail: (enabled.stderr || enabled.stdout).trim().split('\n').slice(0, 2).join(' '),
    };
  }

  return {
    step: 'firewall',
    status: 'done',
    summary: 'Incoming traffic allowed only on tailscale0',
    detail: 'Public SSH is now closed. Use Tailscale SSH, or the provider console',
  };
}

export async function stepDaemon(context: StepContext): Promise<StepResult> {
  if (context.dryRun) {
    return {
      step: 'daemon',
      status: 'skipped',
      summary: 'Would install the corami daemon service',
    };
  }

  const user = context.serverUser;
  const lingerWorks = await enableLinger(user);
  const scope = lingerWorks ? 'user' : 'system';
  const binary = coramiBinary();
  const home = await homeDirectoryForUser(user);

  if (scope === 'system' && home === undefined) {
    return {
      step: 'daemon',
      status: 'failed',
      summary: `No account ${user} on this machine`,
      detail: 'Run the setup as root, which creates the account',
    };
  }

  const result = await installUnit({
    scope,
    ...(scope === 'user' && home !== undefined ? { home } : {}),
    spec: {
      name: 'corami-daemon',
      description: 'Corami daemon',
      execStart: `${binary} daemon`,
      environment: scope === 'user' ? {} : { HOME: home ?? '' },
      ...(scope === 'system' ? { user } : {}),
    },
  });

  await writeConfig(context);

  return {
    step: 'daemon',
    status: 'done',
    summary: `Daemon installed as a ${scope} systemd service (corami-daemon)`,
    detail: result.path,
    scope,
  };
}

export async function stepGitWatch(context: StepContext): Promise<StepResult> {
  if (context.dryRun) {
    return {
      step: 'git-watch',
      status: 'skipped',
      summary: 'Would install the git alignment service',
    };
  }

  const user = context.serverUser;
  const scope = context.daemonScope ?? ((await enableLinger(user)) ? 'user' : 'system');
  const home = await homeDirectoryForUser(user);

  if (scope === 'system' && home === undefined) {
    return {
      step: 'git-watch',
      status: 'failed',
      summary: `No account ${user} on this machine`,
      detail: 'Run the setup as root, which creates the account',
    };
  }

  const result = await installService({
    ...gitWatchSpec(coramiBinary(), scope, home),
    ...(scope === 'user' && home !== undefined ? { systemdHome: home } : {}),
    ...(scope === 'system' ? { systemdUser: user } : {}),
  });

  return {
    step: 'git-watch',
    status: result.installed ? 'done' : 'failed',
    summary: result.installed
      ? `Git alignment service installed as a ${scope} systemd service (corami-git-watch)`
      : 'The git alignment service could not be installed',
    detail: result.installed ? result.path : result.detail,
    scope,
  };
}

export async function stepServe(context: StepContext): Promise<StepResult> {
  if (context.fqdn === undefined) {
    return { step: 'serve', status: 'skipped', summary: 'No FQDN known yet' };
  }

  if (!(await hasTailscale())) {
    return { step: 'serve', status: 'skipped', summary: 'Tailscale is not installed' };
  }

  if (context.dryRun) {
    return {
      step: 'serve',
      status: 'skipped',
      summary: 'Would expose port 7420 with tailscale serve',
    };
  }

  const result = await serveHttps(7420);

  if (!result.ok) {
    return {
      step: 'serve',
      status: 'failed',
      summary: 'Cannot publish the daemon over HTTPS',
      detail: `${result.detail}. Enable HTTPS certificates in the Tailscale admin console, once per tailnet: https://login.tailscale.com/admin/dns`,
    };
  }

  return { step: 'serve', status: 'done', summary: `Exposed https://${context.fqdn}:7420` };
}

export async function stepSummary(context: StepContext): Promise<StepResult> {
  const active =
    context.daemonScope === undefined
      ? (await isUnitActive('corami-daemon', 'user')) ||
        (await isUnitActive('corami-daemon', 'system'))
      : await isUnitActive('corami-daemon', context.daemonScope);
  const fqdn = context.fqdn ?? 'localhost';
  const details: string[] = [];

  if (context.ownerLogin === undefined) {
    details.push(
      'Owner login not set: any tailnet member can reach the daemon. Set it with --owner',
    );
  }

  const ssh = await sshState(context.serverUser).catch(() => undefined);
  const policy = ssh?.policy;

  if (policy !== undefined && policy !== 'accept') {
    details.push(sshPolicyText(policy, context.serverUser).summary);
  }

  const others = otherPeople(await tailnetLogins().catch(() => []), context.ownerLogin);

  if (
    protectionsOff({
      root: ssh?.exposure.root,
      accounts: ssh?.exposure.accounts,
      people: others,
    })
  ) {
    details.push(PROTECTIONS_OFF);
  }

  return {
    step: 'summary',
    status: active ? 'done' : 'failed',
    summary: active ? `Ready at https://${fqdn}:7420` : 'Daemon is not running',
    detail: details.length === 0 ? undefined : details.join('. '),
  };
}

async function writeConfig(context: StepContext): Promise<void> {
  const existing = await readGlobalConfig().catch(() => undefined);
  const serverHost = context.fqdn ?? existing?.server_host;
  const ownerLogin = context.ownerLogin ?? existing?.owner_login;
  const config: GlobalConfig = { role: 'server' };

  if (serverHost !== undefined) {
    config.server_host = serverHost;
  }

  if (ownerLogin !== undefined) {
    config.owner_login = ownerLogin;
  }

  if (!context.root) {
    config.server_user = context.serverUser;
  }

  await writeGlobalConfig(config);
  await ensureDirectories();
}

export async function ensureDirectories(): Promise<void> {
  const dirs = paths();

  for (const dir of [dirs.root, dirs.logs, dirs.bin]) {
    await run('mkdir', ['-p', dir]);
  }
}

function coramiBinary(): string {
  try {
    const real = realpathSync(process.execPath);

    if (real.endsWith('corami') || real.endsWith('corami.exe')) {
      return real;
    }
  } catch {}

  return join(paths().bin, 'corami');
}

export function stepLine(result: StepResult): string {
  const line = `${result.status.padEnd(8)} ${result.step.padEnd(15)} ${result.summary}`;

  return result.detail === undefined ? line : `${line}\n${' '.repeat(25)}${result.detail}`;
}

export function progressLine(
  step: string,
  activity: string,
  elapsedMs: number,
  width = 80,
): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const prefix = `${'running'.padEnd(8)} ${step.padEnd(15)} `;
  const suffix = seconds < 2 ? '...' : `... ${seconds}s`;
  const columns = width > 0 ? width : 80;
  const room = Math.max(0, columns - 1 - prefix.length - suffix.length);
  const text = activity.length <= room ? activity : activity.slice(0, room).trimEnd();

  return `${prefix}${text}${suffix}`;
}

export async function runStepInTerminal(
  prompter: Prompter,
  step: { name: string; activity: string },
  runStep: () => Promise<StepResult>,
): Promise<StepResult> {
  for (;;) {
    const started = Date.now();
    const show = () =>
      prompter.progress(
        progressLine(step.name, step.activity, Date.now() - started, process.stdout.columns),
      );
    show();
    const ticker = setInterval(show, 1000);
    let result: StepResult;

    try {
      result = await runStep();
    } catch (error) {
      prompter.say(stepLine({ step: step.name, status: 'failed', summary: step.activity }));
      throw error;
    } finally {
      clearInterval(ticker);
    }

    prompter.say(stepLine(result));

    if (result.status !== 'failed' || !(await prompter.confirm('Try again?', true))) {
      return result;
    }
  }
}

export async function firewallClosed(): Promise<boolean> {
  const result = await run('ufw', ['status']);

  return result.ok && isTailnetOnlyFirewall(result.stdout);
}
