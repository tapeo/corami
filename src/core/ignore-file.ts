import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';
import { sessionIgnores } from '@/integrations/mutagen.ts';

export const IGNORE_FILE = '.coramiignore';

export interface IgnoreLine {
  line: number;
  pattern: string;
}

export function parseIgnores(text: string): IgnoreLine[] {
  const lines: IgnoreLine[] = [];

  text.split('\n').forEach((raw, index) => {
    const pattern = raw.trim();

    if (pattern === '' || pattern.startsWith('#')) {
      return;
    }

    if (pattern.startsWith('!')) {
      throw invalid(index + 1, pattern, 'a negation is not supported');
    }

    if (pattern.startsWith('/')) {
      throw invalid(index + 1, pattern, 'a leading / is not supported');
    }

    if (pattern.split('/').includes('..')) {
      throw invalid(index + 1, pattern, 'a parent folder is not supported');
    }

    lines.push({ line: index + 1, pattern });
  });

  return lines;
}

function invalid(line: number, pattern: string, reason: string): CoramiError {
  return new CoramiError({
    code: 'config_invalid',
    message: `${IGNORE_FILE} line ${line} is not a valid pattern: ${reason}`,
    fix: `Fix or remove ${pattern} in ${IGNORE_FILE}: one Mutagen pattern per line, comments start with #, no negation`,
  });
}

export function projectIgnores(root: string): string[] {
  const file = join(root, IGNORE_FILE);

  if (!existsSync(file)) {
    return [];
  }

  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  return parseIgnores(text).map((entry) => entry.pattern);
}

export function ignoresFor(root: string): string[] {
  return [...sessionIgnores(root), ...projectIgnores(root)];
}

export function sameIgnores(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();

  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((pattern, index) => pattern === sortedRight[index])
  );
}

export function ignoreDrift(
  session: string[],
  expected: string[],
): { missing: string[]; extra: string[] } {
  const missing = expected.filter((pattern) => !session.includes(pattern));
  const extra = session.filter((pattern) => !expected.includes(pattern));

  return { missing, extra };
}

const LEGACY_GIT_IGNORE = '.git/';
const GIT_PEER_IGNORE = '!/.git/corami/';

export function keptIgnores(expected: string[], session: string[]): string[] {
  const replaceable = (pattern: string): boolean =>
    pattern !== LEGACY_GIT_IGNORE || !expected.includes(GIT_PEER_IGNORE);

  return session.filter((pattern) => replaceable(pattern) && !expected.includes(pattern));
}

export interface RefreshPlan {
  current: boolean;
  refuse: boolean;
  missing: string[];
  extra: string[];
}

export function refreshPlan(session: string[], expected: string[], force: boolean): RefreshPlan {
  const drift = ignoreDrift(session, expected);

  return {
    current: drift.missing.length === 0 && drift.extra.length === 0,
    refuse: drift.extra.length > 0 && !force,
    missing: drift.missing,
    extra: drift.extra,
  };
}

export type RefreshMode = 'plain' | 'force' | 'keep-extra';

export type RefreshDecision = 'current' | 'refused' | 'refresh';

export function refreshDecision(
  plan: RefreshPlan,
  pollingCurrent: boolean,
  mode: RefreshMode,
): RefreshDecision {
  if (mode === 'plain' && plan.refuse) {
    return 'refused';
  }

  if (plan.current && pollingCurrent) {
    return 'current';
  }

  return 'refresh';
}

export const KEPT_HEADER = '# kept from an older session by corami sync refresh';

export interface AdoptResult {
  text: string;
  adopted: string[];
  sessionOnly: string[];
}

export function adoptIgnores(text: string, kept: string[]): AdoptResult {
  const known = new Set(parseIgnores(text).map((entry) => entry.pattern));
  const adopted: string[] = [];
  const sessionOnly: string[] = [];

  for (const pattern of kept) {
    if (!fitsIgnoreFile(pattern)) {
      sessionOnly.push(pattern);
      continue;
    }

    if (known.has(pattern) || adopted.includes(pattern)) {
      continue;
    }

    adopted.push(pattern);
  }

  if (adopted.length === 0) {
    return { text, adopted, sessionOnly };
  }

  const body = text.replace(/\n+$/, '');

  if (text.includes(KEPT_HEADER)) {
    return { text: `${body}\n${adopted.join('\n')}\n`, adopted, sessionOnly };
  }

  const head = body === '' ? '' : `${body}\n\n`;

  return { text: `${head}${KEPT_HEADER}\n${adopted.join('\n')}\n`, adopted, sessionOnly };
}

function fitsIgnoreFile(pattern: string): boolean {
  return !pattern.startsWith('!') && !pattern.startsWith('/') && !pattern.split('/').includes('..');
}

function withoutPrefix(pattern: string): string {
  return pattern.startsWith('**/') ? pattern.slice(3) : pattern;
}

function baseName(pattern: string): string {
  return pattern.replace(/\/$/, '').split('/').at(-1) ?? '';
}

function isNameRule(pattern: string): boolean {
  return !pattern.replace(/\/$/, '').includes('/');
}

export function unrepresentedIgnores(kept: string[], expected: string[]): string[] {
  const known = new Set(expected.map(withoutPrefix));
  const names = new Set(expected.filter(isNameRule).map(baseName));

  return kept.filter((pattern) => {
    if (known.has(withoutPrefix(pattern))) {
      return false;
    }

    return isNameRule(pattern) || !names.has(baseName(pattern));
  });
}
