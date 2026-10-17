/**
 * Who may talk to the daemon, and through which door.
 *
 * `tailscale serve` puts the tailnet login in a header. The daemon used to
 * trust every request without one, as a local process of the server would be
 * the only one to reach it: that is not true on a shared tailnet and not true
 * for tagged devices, whose requests arrive through serve with no login
 * header. So a request is accepted only as the owner, or with the token of
 * this machine, which only the account that owns `~/.corami` can read.
 */
export interface AuthRequest {
  /** The login `tailscale serve` added, undefined when the request has none. */
  login: string | undefined;
  /** The bearer token of the request, undefined when it carries none. */
  token: string | undefined;
  /** The owner of the daemon, undefined when the setup did not set one. */
  ownerLogin: string | undefined;
  /** The token of this machine, never empty: the daemon writes it at startup. */
  expectedToken: string;
}

export type AuthDecision =
  | { allow: true; as: 'owner' | 'token' }
  | { allow: false; reason: 'not-owner' | 'no-token' | 'no-owner' };

export function authorize(request: AuthRequest): AuthDecision {
  if (request.token !== undefined && safeEqual(request.token, request.expectedToken)) {
    return { allow: true, as: 'token' };
  }

  if (request.login === undefined) {
    return { allow: false, reason: 'no-token' };
  }

  if (request.ownerLogin === undefined) {
    // Without an owner, no login can be checked: the request is refused and
    // the setup says how to choose one.
    return { allow: false, reason: 'no-owner' };
  }

  if (request.login === request.ownerLogin) {
    return { allow: true, as: 'owner' };
  }

  return { allow: false, reason: 'not-owner' };
}

/**
 * What a request from a browser would look like. The CLI and the agents never
 * send these headers, so a request that carries them comes from a page: it is
 * refused before the body is even read, because a page on the tailnet could
 * otherwise drive the daemon with the identity headers of its own browser.
 */
export interface RequestShape {
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
}

export type RequestVerdict = { ok: true } | { ok: false; reason: 'from-a-page' | 'not-json' };

export function checkRequestShape(request: RequestShape): RequestVerdict {
  if (request.origin !== undefined) {
    return { ok: false, reason: 'from-a-page' };
  }

  if (request.secFetchSite !== undefined && request.secFetchSite !== 'none') {
    return { ok: false, reason: 'from-a-page' };
  }

  return { ok: true };
}

/** Whether the declared content type is the JSON the API speaks. */
export function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** The bearer token of a request, from the `authorization` header. */
export function bearerToken(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }

  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

/**
 * A comparison whose duration does not say how much of the token was right.
 * The daemon is only reachable over the tailnet and from the server itself,
 * but a token is a token.
 */
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}
