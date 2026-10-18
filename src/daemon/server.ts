import { ensureDaemonToken } from '@/core/config.ts';
import {
  authorize,
  bearerToken,
  checkRequestShape,
  isJsonContentType,
} from '@/core/daemon-auth.ts';
import { type ErrorCode, toCoramiError } from '@/core/errors.ts';
import type { SshPolicy } from '@/core/ssh-policy.ts';
import { handleApi } from '@/daemon/api.ts';
import { type PreviewOptions, reconcileServeRules } from '@/daemon/previews.ts';
import { sshPolicy, status as tailscaleStatus } from '@/integrations/tailscale.ts';
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
  /** The token local processes present, at the path of `paths()`. */
  token: string;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const startedAt = Date.now();
  const token = await ensureDaemonToken();
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
      const rejected = rejectNonOwner(request, options, token);

      if (rejected !== undefined) {
        return rejected;
      }

      const shape = checkRequestShape({
        method: request.method,
        origin: request.headers.get('origin') ?? undefined,
        secFetchSite: request.headers.get('sec-fetch-site') ?? undefined,
      });

      if (!shape.ok) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: 'usage',
              message:
                shape.reason === 'from-a-page'
                  ? 'The daemon is not called from a browser'
                  : 'The request is not in the format of the API',
            },
          },
          403,
        );
      }

      if (
        hasBody(request) &&
        !isJsonContentType(request.headers.get('content-type') ?? undefined)
      ) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: 'usage',
              message: 'The body of the request must be JSON (content-type: application/json)',
            },
          },
          415,
        );
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
          statusForError(coramiError.code),
        );
      }

      return jsonResponse(
        { ok: false, error: { code: 'usage', message: `Unknown route: ${url.pathname}` } },
        404,
      );
    },
  });

  return { server, previews, token };
}

function rejectNonOwner(
  request: Request,
  options: DaemonOptions,
  expectedToken: string,
): Response | undefined {
  const decision = authorize({
    login: request.headers.get('Tailscale-User-Login') ?? undefined,
    token: bearerToken(request.headers.get('authorization')),
    ownerLogin: options.ownerLogin,
    expectedToken,
  });

  if (decision.allow) {
    return undefined;
  }

  return jsonResponse(
    {
      ok: false,
      error: {
        code: 'generic',
        message:
          decision.reason === 'not-owner'
            ? `Not allowed: ${request.headers.get('Tailscale-User-Login') ?? ''}`
            : 'Not allowed: the request has no identity of the owner and no token of this machine',
        fix:
          decision.reason === 'no-owner'
            ? 'The setup did not choose an owner: run corami setup server --owner <login> on the server'
            : 'Local commands read ~/.corami/daemon-token, written by the daemon: check that it exists and that the command runs as the account that owns it',
      },
    },
    403,
  );
}

/** Whether a request declares a body: a length, or a chunked transfer. */
function hasBody(request: Request): boolean {
  const length = request.headers.get('content-length');

  if (length !== null) {
    return Number(length) > 0;
  }

  return request.headers.get('transfer-encoding') !== null;
}

/**
 * The status of an answer, from the error code: what was asked for is not
 * there (404), it clashes with what is there (409), the daemon could not reach
 * something else (502), the request was wrong (400), anything else is a
 * failure of the daemon (500).
 */
function statusForError(code: ErrorCode): number {
  if (code === 'usage') {
    return 400;
  }

  if (code === 'config_invalid') {
    return 404;
  }

  if (code === 'project_exists') {
    return 409;
  }

  if (code === 'server_unreachable') {
    return 502;
  }

  return 500;
}

const SSH_POLICY_TTL_MS = 60_000;

let sshPolicyCache: { user: string; at: number; policy: SshPolicy | undefined } | undefined;

async function cachedSshPolicy(user: string | undefined): Promise<SshPolicy | undefined> {
  if (user === undefined) {
    return undefined;
  }

  const cached = sshPolicyCache;
  const now = Date.now();

  if (cached !== undefined && cached.user === user && now - cached.at < SSH_POLICY_TTL_MS) {
    return cached.policy;
  }

  const policy = await sshPolicy(user).catch(() => undefined);
  sshPolicyCache = { user, at: now, policy };

  return policy;
}

/** What this daemon can do for a client that is newer than the server: the import asks for the staging folder. */
export const CAPABILITIES = ['import_staging'] as const;

async function healthData(options: DaemonOptions, startedAt: number) {
  const ts = await tailscaleStatus().catch(() => undefined);

  return {
    name: 'corami',
    version: VERSION,
    hostname: options.hostname,
    port: options.port,
    user: options.user,
    fqdn: options.fqdn ?? ts?.dnsName,
    capabilities: [...CAPABILITIES],
    tailscale: {
      installed: ts?.installed ?? false,
      online: ts?.online ?? false,
      dns_name: ts?.dnsName,
      tailnet: ts?.tailnetName,
      ssh_policy: (await cachedSshPolicy(options.user)) ?? null,
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
