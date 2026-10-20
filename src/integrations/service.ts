import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '@/core/exec.ts';
import { installUnit, isUnitActive } from '@/integrations/systemd.ts';

export interface ServiceSpec {
  name: string;
  description: string;
  binary: string;
  args: string[];
  restart?: boolean | undefined;
  systemdScope?: 'user' | 'system' | undefined;
  systemdUser?: string | undefined;
  systemdHome?: string | undefined;
  logFile?: string | undefined;
}

export interface ServiceResult {
  installed: boolean;
  path: string;
  detail: string;
}

export type ServiceHealthStatus = 'running' | 'stopped' | 'absent';

export interface ServiceHealth {
  status: ServiceHealthStatus;
  detail: string;
}

export interface LaunchdState {
  loaded: boolean;
  running: boolean;
  pid: number;
  exitCode: number | undefined;
}

export interface ServiceRefresh {
  ok: boolean;
  detail: string;
}

export type ServicePlatform = 'macos' | 'linux' | 'windows' | 'other';

const PRODUCT_PREFIX = 'corami-';
const LAUNCHD_LABEL_PREFIX = 'dev.corami';

function serviceShortName(name: string): string {
  return name.startsWith(PRODUCT_PREFIX) ? name.slice(PRODUCT_PREFIX.length) : name;
}

export function servicePlatform(): ServicePlatform {
  if (process.platform === 'darwin') {
    return 'macos';
  }

  if (process.platform === 'win32') {
    return 'windows';
  }

  if (process.platform === 'linux') {
    return 'linux';
  }

  return 'other';
}

export function parseLaunchdPrint(text: string): LaunchdState {
  const state = /^[ \t]*state = (.*?)[ \t]*$/m.exec(text);
  const pid = /^[ \t]*pid = (\d+)$/m.exec(text);
  const lastExit = /^[ \t]*last exit code = (-?\d+)/m.exec(text);

  return {
    loaded: state !== null,
    running: state?.[1] === 'running' && pid !== null,
    pid: pid === null ? 0 : Number(pid[1]),
    exitCode: lastExit === null ? undefined : Number(lastExit[1]),
  };
}

export function describeLaunchdState(state: LaunchdState): string {
  if (!state.loaded) {
    return 'not loaded';
  }

  if (state.running) {
    return 'running';
  }

  if (state.exitCode === undefined) {
    return 'loaded, not running';
  }

  if (state.exitCode === 78) {
    return 'exits at start with code 78 (EX_CONFIG, the launch constraint of the binary)';
  }

  if (state.exitCode < 0) {
    return `stopped by signal ${-state.exitCode}`;
  }

  return `exits at start with code ${state.exitCode}`;
}

export function renderLaunchAgent(spec: ServiceSpec): string {
  const args = [spec.binary, ...spec.args].map(
    (value) => `    <string>${escapeXml(value)}</string>`,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL_PREFIX}.${escapeXml(serviceShortName(spec.name))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    spec.restart === false ? '  <false/>' : '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    ...(spec.logFile === undefined
      ? []
      : [
          '  <key>StandardOutPath</key>',
          `  <string>${escapeXml(spec.logFile)}</string>`,
          '  <key>StandardErrorPath</key>',
          `  <string>${escapeXml(spec.logFile)}</string>`,
        ]),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderScheduledTask(spec: ServiceSpec): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(spec.description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(spec.binary)}</Command>`,
    `      <Arguments>${escapeXml(spec.args.join(' '))}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

export async function installService(spec: ServiceSpec): Promise<ServiceResult> {
  const platform = servicePlatform();

  if (platform === 'macos') {
    return installLaunchAgent(spec);
  }

  if (platform === 'linux') {
    const unit = await installUnit({
      scope: spec.systemdScope ?? 'user',
      ...(spec.systemdHome === undefined ? {} : { home: spec.systemdHome }),
      spec: {
        name: spec.name,
        description: spec.description,
        execStart: [spec.binary, ...spec.args].join(' '),
        restart: spec.restart === false ? 'no' : 'always',
        ...(spec.systemdUser === undefined ? {} : { user: spec.systemdUser }),
      },
    });

    return { installed: true, path: unit.path, detail: `${unit.scope} unit` };
  }

  if (platform === 'windows') {
    return installScheduledTask(spec);
  }

  return { installed: false, path: '', detail: `Unsupported platform: ${process.platform}` };
}

export async function restartService(spec: ServiceSpec): Promise<boolean> {
  const platform = servicePlatform();

  if (platform === 'macos') {
    const uid = process.getuid?.() ?? 0;
    const result = await run('launchctl', [
      'kickstart',
      '-k',
      `gui/${uid}/${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}`,
    ]);
    return result.ok;
  }

  if (platform === 'linux') {
    const scope = spec.systemdScope ?? 'user';
    const args = [...(scope === 'user' ? ['--user'] : []), 'restart', `${spec.name}.service`];
    const result = await run('systemctl', args, {
      env: { XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}` },
    });
    return result.ok;
  }

  if (platform === 'windows') {
    const name = `corami-${serviceShortName(spec.name)}`;
    await run('schtasks', ['/end', '/tn', name]);
    const start = await run('schtasks', ['/run', '/tn', name]);
    return start.ok;
  }

  return false;
}

export async function serviceHealth(spec: ServiceSpec): Promise<ServiceHealth> {
  const platform = servicePlatform();

  if (platform === 'macos') {
    const launchd = await launchdState(spec);

    if (launchd === undefined) {
      return { status: 'absent', detail: 'not loaded' };
    }

    return {
      status: launchd.running ? 'running' : 'stopped',
      detail: describeLaunchdState(launchd),
    };
  }

  const active = await serviceRunning(spec);

  return { status: active ? 'running' : 'stopped', detail: active ? 'running' : 'not running' };
}

export async function serviceActive(spec: ServiceSpec): Promise<boolean> {
  return (await serviceHealth(spec)).status === 'running';
}

export async function serviceInstalled(spec: ServiceSpec): Promise<boolean> {
  if (servicePlatform() !== 'macos') {
    return serviceActive(spec);
  }

  return (await launchdState(spec)) !== undefined;
}

async function serviceRunning(spec: ServiceSpec): Promise<boolean> {
  const platform = servicePlatform();

  if (platform === 'macos') {
    return (await launchdState(spec))?.running === true;
  }

  if (platform === 'linux') {
    const first = spec.systemdScope ?? 'user';
    const scopes: Array<'user' | 'system'> =
      first === 'user' ? ['user', 'system'] : ['system', 'user'];

    for (const scope of scopes) {
      if (await isUnitActive(spec.name, scope)) {
        spec.systemdScope = scope;
        return true;
      }
    }

    return false;
  }

  if (platform === 'windows') {
    const result = await run('schtasks', [
      '/query',
      '/tn',
      `corami-${serviceShortName(spec.name)}`,
    ]);
    return result.ok;
  }

  return false;
}

export async function refreshService(
  spec: ServiceSpec,
  timeoutMs = 10_000,
): Promise<ServiceRefresh> {
  if (servicePlatform() !== 'macos') {
    const restarted = await restartService(spec);

    return { ok: restarted, detail: restarted ? 'restarted' : 'restart failed' };
  }

  const path = launchAgentPath(spec);
  const uid = process.getuid?.() ?? 0;

  try {
    mkdirSync(dirname(path), { recursive: true });

    if (spec.logFile !== undefined) {
      mkdirSync(dirname(spec.logFile), { recursive: true });
    }

    await Bun.write(path, renderLaunchAgent(spec));
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  await run('launchctl', ['bootout', `gui/${uid}`, path]);
  const boot = await bootstrapLaunchAgent(path, uid);

  if (!boot.ok) {
    return { ok: false, detail: boot.detail };
  }

  await run('launchctl', [
    'enable',
    `gui/${uid}/${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}`,
  ]);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const health = await serviceHealth(spec);

    if (health.status === 'running') {
      return { ok: true, detail: 'registered again and running' };
    }

    await Bun.sleep(250);
  }

  return { ok: false, detail: `registered again, but ${(await serviceHealth(spec)).detail}` };
}

async function launchdState(spec: ServiceSpec): Promise<LaunchdState | undefined> {
  const result = await run('launchctl', [
    'print',
    `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}`,
  ]);

  return result.ok ? parseLaunchdPrint(result.stdout) : undefined;
}

async function bootstrapLaunchAgent(
  path: string,
  uid: number,
): Promise<{ ok: boolean; detail: string }> {
  let detail = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const boot = await run('launchctl', ['bootstrap', `gui/${uid}`, path]);

    if (boot.ok) {
      return { ok: true, detail: 'bootstrapped' };
    }

    detail = (boot.stderr || boot.stdout).trim().split('\n').slice(0, 2).join(' ');
    await Bun.sleep(250);
  }

  return { ok: false, detail };
}

export function launchAgentPath(spec: ServiceSpec): string {
  return join(
    homedir(),
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}.plist`,
  );
}

async function installLaunchAgent(spec: ServiceSpec): Promise<ServiceResult> {
  const path = launchAgentPath(spec);
  const refreshed = await refreshService(spec);

  if (!refreshed.ok) {
    return { installed: false, path, detail: refreshed.detail };
  }

  return { installed: true, path, detail: refreshed.detail };
}

async function installScheduledTask(spec: ServiceSpec): Promise<ServiceResult> {
  const dir = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.corami');
  const path = join(dir, `${spec.name}.task.xml`);

  try {
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, renderScheduledTask(spec));
  } catch (error) {
    return {
      installed: false,
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const result = await run('schtasks', [
    '/create',
    '/tn',
    `corami-${serviceShortName(spec.name)}`,
    '/xml',
    path,
    '/f',
  ]);

  if (!result.ok) {
    return {
      installed: false,
      path,
      detail: (result.stderr || result.stdout).trim().split('\n').slice(0, 2).join(' '),
    };
  }

  return { installed: true, path, detail: 'scheduled task at logon' };
}

export function gitWatchSpec(
  binary: string,
  scope?: 'user' | 'system',
  home?: string,
): ServiceSpec {
  return {
    name: 'corami-git-watch',
    description: 'Corami git alignment',
    binary,
    args: ['git', 'watch'],
    restart: true,
    logFile: join(home ?? homedir(), '.corami', 'logs', 'git-watch.log'),
    ...(scope === undefined ? {} : { systemdScope: scope }),
  };
}

export function execApproverSpec(binary: string): ServiceSpec {
  return {
    name: 'corami-exec-approver',
    description: 'Corami exec approval dialog',
    binary,
    args: ['exec', 'approver'],
    restart: true,
    logFile: join(homedir(), '.corami', 'logs', 'exec-approver.log'),
  };
}

export async function removeService(spec: ServiceSpec): Promise<boolean> {
  const platform = servicePlatform();
  const short = serviceShortName(spec.name);

  if (platform === 'macos') {
    const path = join(
      homedir(),
      'Library',
      'LaunchAgents',
      `${LAUNCHD_LABEL_PREFIX}.${short}.plist`,
    );

    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, path]);
    rmSync(path, { force: true });
    return true;
  }

  if (platform === 'linux') {
    const env = { XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}` };

    await run('systemctl', ['--user', 'disable', '--now', `${spec.name}.service`], { env });
    rmSync(join(homedir(), '.config', 'systemd', 'user', `${spec.name}.service`), { force: true });
    await run('systemctl', ['--user', 'daemon-reload'], { env });
    return true;
  }

  if (platform === 'windows') {
    return (await run('schtasks', ['/delete', '/tn', `corami-${short}`, '/f'])).ok;
  }

  return false;
}

export function serviceDirHint(): string {
  const platform = servicePlatform();

  if (platform === 'macos') {
    return join(homedir(), 'Library', 'LaunchAgents');
  }

  if (platform === 'linux') {
    return join(homedir(), '.config', 'systemd', 'user');
  }

  return join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.corami');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
