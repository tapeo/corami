import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { paths, readGlobalConfig } from '@/core/config.ts';
import { run } from '@/core/exec.ts';
import { replaceBinary } from '@/core/release.ts';
import {
  execApproverSpec,
  gitWatchSpec,
  launchAgentPath,
  refreshService,
  type ServiceSpec,
  serviceInstalled,
  servicePlatform,
} from '@/integrations/service.ts';

const windows = servicePlatform() === 'windows';
const executable = windows ? 'corami.exe' : 'corami';
const source = join(import.meta.dir, '..', 'dist', executable);
const target = join(paths().bin, executable);

if (!existsSync(source)) {
  console.error(`Missing ${source}`);
  console.error('Build it first: bun run bin');
  process.exit(1);
}

const role = (await readGlobalConfig().catch(() => undefined))?.role;

const services: Array<{ spec: ServiceSpec; fix: string; expected: boolean }> = [
  {
    spec: {
      name: 'corami-daemon',
      description: 'Corami daemon',
      binary: target,
      args: ['daemon'],
    },
    fix: 'corami setup server --step daemon',
    expected: role === 'server',
  },
  {
    spec: gitWatchSpec(target),
    fix:
      role === 'server'
        ? 'corami setup server --step git-watch'
        : 'corami setup client <server> --step git-watch',
    expected: role !== undefined,
  },
  {
    spec: execApproverSpec(target),
    fix: 'corami exec allow',
    expected: false,
  },
];

function hasUnitFile(spec: ServiceSpec): boolean {
  return servicePlatform() === 'macos' && existsSync(launchAgentPath(spec));
}

const installedServices: ServiceSpec[] = [];
const missing: Array<{ name: string; fix: string }> = [];

for (const service of services) {
  if ((await serviceInstalled(service.spec)) || hasUnitFile(service.spec)) {
    installedServices.push(service.spec);
  } else if (service.expected) {
    missing.push({ name: service.spec.name, fix: service.fix });
  }
}

if (windows) {
  for (const spec of installedServices) {
    await run('schtasks', ['/end', '/tn', spec.name]);
  }
}

mkdirSync(paths().bin, { recursive: true });
const staged = `${target}.new`;
copyFileSync(source, staged);
chmodSync(staged, 0o755);
replaceBinary(target, staged);

const version = await run(target, ['--version', '--json']);
const installed = version.ok
  ? (JSON.parse(version.stdout) as { data?: { version?: string } }).data?.version
  : undefined;

console.log(`Installed ${source} to ${target} (version ${installed ?? 'unknown'})`);

let failed = false;

for (const spec of installedServices) {
  const scope = servicePlatform() === 'linux' ? ` (${spec.systemdScope ?? 'user'})` : '';
  const refreshed = await refreshService(spec);

  if (refreshed.ok) {
    console.log(`Restarted ${spec.name}${scope}: ${refreshed.detail}`);
  } else {
    failed = true;
    console.error(`Could not restart ${spec.name}${scope}: ${refreshed.detail}`);
  }
}

if (installedServices.length === 0) {
  console.log('No Corami service to restart');
}

for (const service of missing) {
  console.log(`${service.name} is not running. Install it with: ${service.fix}`);
}

if (role === undefined) {
  console.log(
    'No Corami configuration here: run corami setup server, or corami setup client <server>',
  );
}

process.exit(failed ? 1 : 0);
