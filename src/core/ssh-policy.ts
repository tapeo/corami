const TAILSCALE_CHECK_URL = /To authenticate, visit: (https:\/\/\S+)/;

const SSH_ADVICE = 'Check that ssh works, and that the account owns the projects';

const POLICY_FIX =
  'In the tailnet policy, give the SSH rule for autogroup:nonroot the action accept. See docs/quickstart.md';

export type SshPolicy = 'accept' | 'check' | 'denied';

export interface SshPolicyText {
  summary: string;
  fix?: string | undefined;
}

export function sshPolicyText(policy: SshPolicy, user: string): SshPolicyText {
  if (policy === 'accept') {
    return { summary: `Tailscale SSH lets ${user} in without a periodic check` };
  }

  if (policy === 'check') {
    return {
      summary: `Tailscale SSH asks ${user} for a periodic check: the sync and the import stop each time it expires`,
      fix: POLICY_FIX,
    };
  }

  return {
    summary: `Tailscale SSH denies ${user} on this machine`,
    fix: `In the tailnet policy, let the SSH rule reach ${user}`,
  };
}

export function sshPolicyFromHealth(health: unknown): SshPolicy | undefined {
  const tailscale = isRecord(health) ? health.tailscale : undefined;
  const value = isRecord(tailscale) ? tailscale.ssh_policy : undefined;

  if (value === 'accept' || value === 'check' || value === 'denied') {
    return value;
  }

  return undefined;
}

export function sshFailureFix(sshOutput: string): string {
  const checkUrl = TAILSCALE_CHECK_URL.exec(sshOutput)?.[1];

  if (checkUrl !== undefined) {
    return `Tailscale SSH asks for a check: open ${checkUrl}, then run the command again. The accept action in the SSH rule of the tailnet policy skips the check`;
  }

  const sshSaid = sshOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 2)
    .join(' ');

  if (sshSaid === '') {
    return SSH_ADVICE;
  }

  return `${SSH_ADVICE}. ssh said: ${sshSaid}`;
}

interface SshRule {
  keys: string[];
  users: Record<string, string>;
  action: SshPolicy;
}

const PRINCIPAL_FIELDS = ['node', 'nodeIP', 'userLogin'];

const ANY_PRINCIPAL = 'any';

export function sshPolicyFor(netmap: unknown, user: string, now: Date): SshPolicy | undefined {
  const rules = rulesOf(netmap, now);
  const decisions = new Map<string, SshPolicy>();

  for (const rule of rules) {
    if (!ruleReaches(rule, user)) {
      continue;
    }

    for (const key of rule.keys) {
      const known = decisions.get(key);

      if (known === undefined || known === 'denied') {
        decisions.set(key, rule.action);
      }
    }
  }

  const values = [...decisions.values()];

  if (values.includes('check')) {
    return 'check';
  }

  if (values.includes('accept')) {
    return 'accept';
  }

  if (values.length > 0) {
    return 'denied';
  }

  return undefined;
}

function rulesOf(netmap: unknown, now: Date): SshRule[] {
  const policy = isRecord(netmap) ? netmap.SSHPolicy : undefined;
  const rawRules = isRecord(policy) ? policy.rules : undefined;

  if (!Array.isArray(rawRules)) {
    return [];
  }

  const rules: SshRule[] = [];

  for (const raw of rawRules) {
    const rule = ruleOf(raw);

    if (rule === undefined || isTemporary(raw, now)) {
      continue;
    }

    rules.push(rule);
  }

  return rules;
}

function ruleOf(raw: unknown): SshRule | undefined {
  if (!isRecord(raw) || !isRecord(raw.action) || !isRecord(raw.sshUsers)) {
    return undefined;
  }

  const principals = Array.isArray(raw.principals) ? raw.principals : [];
  const keys = principals.flatMap(principalKeys);
  const users = stringEntries(raw.sshUsers);

  if (raw.action.accept === true) {
    return { keys, users, action: 'accept' };
  }

  if (raw.action.reject === true) {
    return { keys, users, action: 'denied' };
  }

  if (typeof raw.action.holdAndDelegate === 'string' && raw.action.holdAndDelegate !== '') {
    return { keys, users, action: 'check' };
  }

  return { keys, users, action: 'denied' };
}

function ruleReaches(rule: SshRule, user: string): boolean {
  const mapped = rule.users[user] ?? rule.users['*'];
  return mapped !== undefined && mapped !== '';
}

function principalKeys(principal: unknown): string[] {
  if (!isRecord(principal)) {
    return [];
  }

  if (principal.any === true) {
    return [ANY_PRINCIPAL];
  }

  const keys: string[] = [];

  for (const field of PRINCIPAL_FIELDS) {
    const value = principal[field];

    if (typeof value === 'string' || typeof value === 'number') {
      keys.push(`${field}:${String(value)}`);
    }
  }

  return keys;
}

function isTemporary(raw: unknown, now: Date): boolean {
  if (!isRecord(raw) || typeof raw.ruleExpires !== 'string') {
    return false;
  }

  const expires = Date.parse(raw.ruleExpires);

  return Number.isNaN(expires) ? false : expires > now.getTime();
}

function stringEntries(source: Record<string, unknown>): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      entries[key] = value;
    }
  }

  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
