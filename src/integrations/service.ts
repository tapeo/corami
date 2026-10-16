import { mkdirSync } from 'node:fs';
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
  // Linux only: 'user' (default, as on the clients) or 'system' when user
  // services are not available. `systemdUser` becomes `User=` in the system
  // unit, `systemdHome` is the home a user unit belongs to.
  systemdScope?: 'user' | 'system' | undefined;
  systemdUser?: string | undefined;
  systemdHome?: string | undefined;
  // macOS only: where launchd writes what the service prints. On Linux the
  // output goes to the journal on its own.
  logFile?: string | undefined;
}

export interface ServiceResult {
  installed: boolean;
  path: string;
  detail: string;
}

export type ServicePlatform = 'macos' | 'linux' | 'windows' | 'other';

const PRODUCT_PREFIX = 'corami-';
const LAUNCHD_LABEL_PREFIX = 'dev.corami';

/**
 * The short service name, without the product prefix: `corami-git-watch`
 * becomes `git-watch`. Used for the launchd label, where the product already
 * shows in the reverse domain, and for the windows task name.
 */
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

export async function serviceActive(spec: ServiceSpec): Promise<boolean> {
  const platform = servicePlatform();

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

  if (platform === 'macos') {
    const result = await run('launchctl', [
      'print',
      `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}`,
    ]);
    return result.ok;
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

async function installLaunchAgent(spec: ServiceSpec): Promise<ServiceResult> {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const path = join(dir, `${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}.plist`);
  const uid = process.getuid?.() ?? 0;

  try {
    mkdirSync(dir, { recursive: true });

    if (spec.logFile !== undefined) {
      mkdirSync(dirname(spec.logFile), { recursive: true });
    }

    await Bun.write(path, renderLaunchAgent(spec));
  } catch (error) {
    return {
      installed: false,
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  await run('launchctl', ['bootout', `gui/${uid}`, path]);
  const boot = await run('launchctl', ['bootstrap', `gui/${uid}`, path]);

  if (!boot.ok) {
    return {
      installed: false,
      path,
      detail: (boot.stderr || boot.stdout).trim().split('\n').slice(0, 2).join(' '),
    };
  }

  await run('launchctl', [
    'enable',
    `gui/${uid}/${LAUNCHD_LABEL_PREFIX}.${serviceShortName(spec.name)}`,
  ]);

  return { installed: true, path, detail: 'launchd agent' };
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

// The git alignment service. It runs on the server and on every client, and
// it is the same on both: a single way to install it, with the systemd scope
// decided by the caller. `home` is the home of the account it runs as, when
// that is not the home of the process installing it.
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
    // Without these lines launchd throws away the output of the service: the
    // JSON lines of the cycle go to a file, as on the server they go to the
    // journal.
    logFile: join(home ?? homedir(), '.corami', 'logs', 'git-watch.log'),
    ...(scope === undefined ? {} : { systemdScope: scope }),
  };
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
