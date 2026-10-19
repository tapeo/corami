export interface AuthRequest {
  login: string | undefined;
  token: string | undefined;
  ownerLogin: string | undefined;
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
    return { allow: false, reason: 'no-owner' };
  }

  if (request.login === request.ownerLogin) {
    return { allow: true, as: 'owner' };
  }

  return { allow: false, reason: 'not-owner' };
}

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

export function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export function bearerToken(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }

  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

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
