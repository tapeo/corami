import type { CommandContext, CommandSpec } from '@/cli/command.ts';
import { readGlobalConfig } from '@/core/config.ts';
import { startDaemon } from '@/daemon/server.ts';

// The daemon listens on the loopback port the documentation promises: the
// HTTPS address of `tailscale serve` is the only way in, local processes
// included.
const HOSTNAME = '127.0.0.1';
const PORT = 7420;

async function run(context: CommandContext): Promise<{ data?: unknown; text?: string }> {
  const config = await readGlobalConfig().catch(() => undefined);
  const { server } = await startDaemon({
    hostname: HOSTNAME,
    port: PORT,
    ownerLogin: config?.owner_login,
    fqdn: config?.server_host,
  });

  if (!context.output.json) {
    process.stdout.write(`corami daemon listening on http://${HOSTNAME}:${PORT}\n`);
  }

  await waitForShutdown(server);

  return { data: { stopped: true } };
}

function waitForShutdown(server: ReturnType<typeof Bun.serve>): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      server.stop(true);
      resolve();
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const daemonCommand: CommandSpec = {
  name: 'daemon',
  summary: 'Runs the server service',
  usage: 'corami daemon',
  flags: [{ name: 'json', description: 'JSON output' }],
  examples: ['corami daemon', 'systemctl --user start corami-daemon'],
  run,
};
