import { describe, expect, test } from 'bun:test';

import {
  authorize,
  bearerToken,
  checkRequestShape,
  isJsonContentType,
} from '@/core/daemon-auth.ts';

describe('authorize', () => {
  const owner = 'me@example.com';
  const token = 'a'.repeat(64);

  test('accepts the owner through the tailscale header', () => {
    const decision = authorize({
      login: owner,
      token: undefined,
      ownerLogin: owner,
      expectedToken: token,
    });
    expect(decision).toEqual({ allow: true, as: 'owner' });
  });

  test('accepts a local command with the token', () => {
    const decision = authorize({
      login: undefined,
      token,
      ownerLogin: owner,
      expectedToken: token,
    });
    expect(decision).toEqual({ allow: true, as: 'token' });
  });

  test('refuses a request with neither', () => {
    expect(
      authorize({ login: undefined, token: undefined, ownerLogin: owner, expectedToken: token })
        .allow,
    ).toBe(false);
    expect(
      authorize({ login: undefined, token: 'wrong', ownerLogin: owner, expectedToken: token })
        .allow,
    ).toBe(false);
  });

  test('refuses another login of the tailnet', () => {
    expect(
      authorize({
        login: 'someone@else.com',
        token: undefined,
        ownerLogin: owner,
        expectedToken: token,
      }),
    ).toEqual({ allow: false, reason: 'not-owner' });
  });

  test('refuses every login when no owner is set, the token excepted', () => {
    expect(
      authorize({ login: owner, token: undefined, ownerLogin: undefined, expectedToken: token }),
    ).toEqual({ allow: false, reason: 'no-owner' });
    expect(
      authorize({ login: undefined, token, ownerLogin: undefined, expectedToken: token }).allow,
    ).toBe(true);
  });

  test('a token of another length is not a match', () => {
    expect(
      authorize({ login: undefined, token: 'short', ownerLogin: owner, expectedToken: token })
        .allow,
    ).toBe(false);
  });
});

describe('bearerToken', () => {
  test('reads the token of an authorization header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('  Bearer abc123  ')).toBe('abc123');
  });

  test('answers nothing for other schemes', () => {
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken('Basic abc123')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
  });
});

describe('checkRequestShape', () => {
  test('a command of the CLI passes', () => {
    expect(
      checkRequestShape({ method: 'POST', origin: undefined, secFetchSite: undefined }),
    ).toEqual({ ok: true });
  });

  test('a request from a page is refused', () => {
    expect(
      checkRequestShape({
        method: 'POST',
        origin: 'https://corami.tail1a2b3c.ts.net:7420',
        secFetchSite: undefined,
      }),
    ).toEqual({ ok: false, reason: 'from-a-page' });
    expect(
      checkRequestShape({ method: 'POST', origin: undefined, secFetchSite: 'same-site' }),
    ).toEqual({ ok: false, reason: 'from-a-page' });
  });

  test('the browser of the daemon itself passes', () => {
    expect(checkRequestShape({ method: 'GET', origin: undefined, secFetchSite: 'none' })).toEqual({
      ok: true,
    });
  });
});

describe('isJsonContentType', () => {
  test('accepts the JSON the API speaks', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
  });

  test('refuses what a page can send without a preflight', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});
