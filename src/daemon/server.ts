import { toCoramiError } from '@/core/errors.ts';
import { handleApi } from '@/daemon/api.ts';
import { type PreviewOptions, reconcileServeRules } from '@/daemon/previews.ts';
import { status as tailscaleStatus } from '@/integrations/tailscale.ts';
import { VERSION } from '@/version.ts';

export interface DaemonOptions {
  hostname: string;
  port: number;
  ownerLogin?: string | undefined;
  fqdn?: string | undefined;
  /** The account that owns the projects on this server. */
  user?: string | undefined;
}

export interface DaemonHandle {
  server: ReturnType<typeof Bun.serve>;
  previews: PreviewOptions;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const startedAt = Date.now();
  const tailscale = await tailscaleStatus().catch(() => ({
    installed: false,
    running: false,
    online: false,
    dnsName: undefined,
    tailnetName: undefined,
    ipv4: undefined,
  }));
  const previews: PreviewOptions = {
    fqdn: options.fqdn ?? tailscale.dnsName,
    tailscaleAvailable: tailscale.installed,
  };

  await reconcileServeRules().catch(() => undefined);

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch: async (request) => {
      const rejected = rejectNonOwner(request, options);

      if (rejected !== undefined) {
        return rejected;
      }

      const url = new URL(request.url);

      if (url.pathname === '/v1/health') {
        return jsonResponse({ ok: true, data: await healthData(options, startedAt) });
      }

      try {
        const result = await handleApi(request, { options, previews });

        if (result !== undefined) {
          return jsonResponse(result.body, result.status);
        }
      } catch (error) {
        const coramiError = toCoramiError(error);

        return jsonResponse(
          {
            ok: false,
            error: { code: coramiError.code, message: coramiError.message, fix: coramiError.fix },
          },
          400,
        );
      }

      return jsonResponse(
        { ok: false, error: { code: 'usage', message: `Unknown route: ${url.pathname}` } },
        404,
      );
    },
  });

  return { server, previews };
}

function rejectNonOwner(request: Request, options: DaemonOptions): Response | undefined {
  const login = request.headers.get('Tailscale-User-Login');

  if (login === null || options.ownerLogin === undefined) {
    return undefined;
  }

  if (login === options.ownerLogin) {
    return undefined;
  }

  return jsonResponse(
    {
      ok: false,
      error: { code: 'generic', message: `Not allowed: ${login}` },
    },
    403,
  );
}

async function healthData(options: DaemonOptions, startedAt: number) {
  const ts = await tailscaleStatus().catch(() => undefined);

  return {
    name: 'corami',
    version: VERSION,
    hostname: options.hostname,
    port: options.port,
    user: options.user,
    fqdn: options.fqdn ?? ts?.dnsName,
    tailscale: {
      installed: ts?.installed ?? false,
      online: ts?.online ?? false,
      dns_name: ts?.dnsName,
      tailnet: ts?.tailnetName,
    },
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
