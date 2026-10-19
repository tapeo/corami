import { describe, expect, test } from 'bun:test';

import {
  otherPeople,
  PROTECTIONS_OFF,
  peopleText,
  protectionsOff,
  type SshAccount,
  sshAccountsText,
  sshExposure,
  sshExposureFromHealth,
  sshFailureFix,
  sshPolicyFor,
  sshPolicyFromHealth,
  sshPolicyText,
  sshRootText,
} from '@/core/ssh-policy.ts';

const NOW = new Date('2026-10-18T18:00:00Z');

function netmapWith(rules: unknown[]): unknown {
  return { SSHPolicy: { rules } };
}

const checkRule = {
  principals: [{ nodeIP: '100.64.0.7' }, { nodeIP: 'fd7a:115c:a1e0::7' }],
  sshUsers: { '*': '=', 0: '', root: 'root' },
  action: {
    holdAndDelegate: 'https://controlplane.tailscale.com/a/hold',
    allowAgentForwarding: true,
  },
};

const acceptRule = {
  principals: [{ nodeIP: '100.64.0.7' }, { nodeIP: 'fd7a:115c:a1e0::7' }],
  sshUsers: { '*': '=' },
  action: { accept: true },
};

describe('the SSH policy of the netmap', () => {
  test('a check rule asks for a periodic check', () => {
    expect(sshPolicyFor(netmapWith([checkRule]), 'corami', NOW)).toBe('check');
  });

  test('an accept rule lets the user in', () => {
    expect(sshPolicyFor(netmapWith([acceptRule]), 'corami', NOW)).toBe('accept');
  });

  test('an approval that expires stays out: the check behind it decides', () => {
    const approval = {
      ...acceptRule,
      ruleExpires: '2026-10-19T04:25:12Z',
    };

    expect(sshPolicyFor(netmapWith([approval, checkRule]), 'corami', NOW)).toBe('check');
  });

  test('an expired approval is a rule like the others', () => {
    const approval = {
      ...acceptRule,
      ruleExpires: '2026-10-18T17:00:00Z',
    };

    expect(sshPolicyFor(netmapWith([approval, checkRule]), 'corami', NOW)).toBe('accept');
  });

  test('accept for a user and check for root are read per user', () => {
    const acceptCorami = { ...acceptRule, sshUsers: { corami: '=' } };

    expect(sshPolicyFor(netmapWith([acceptCorami, checkRule]), 'corami', NOW)).toBe('accept');
    expect(sshPolicyFor(netmapWith([acceptCorami, checkRule]), 'root', NOW)).toBe('check');
  });

  test('a rule with an empty user for this account does not match', () => {
    const closed = { ...acceptRule, sshUsers: { corami: '', '*': '' } };

    expect(sshPolicyFor(netmapWith([closed]), 'corami', NOW)).toBeUndefined();
  });

  test('a reject rule denies the user', () => {
    const reject = { ...acceptRule, action: { reject: true } };

    expect(sshPolicyFor(netmapWith([reject]), 'corami', NOW)).toBe('denied');
  });

  test('a rule for any principal covers the account', () => {
    const anyCheck = { ...checkRule, principals: [{ any: true }] };

    expect(sshPolicyFor(netmapWith([anyCheck]), 'corami', NOW)).toBe('check');
  });

  test('a netmap without an SSH policy says nothing', () => {
    expect(sshPolicyFor({}, 'corami', NOW)).toBeUndefined();
    expect(sshPolicyFor(undefined, 'corami', NOW)).toBeUndefined();
  });
});

describe('what the policy means for the user', () => {
  test('accept is ok, check and denied carry a fix', () => {
    expect(sshPolicyText('accept', 'corami').fix).toBeUndefined();
    expect(sshPolicyText('check', 'corami').summary).toContain('periodic check');
    expect(sshPolicyText('check', 'corami').fix).toContain('for corami');
    expect(sshPolicyText('check', 'corami').fix).toContain('docs/security.md');
    expect(sshPolicyText('denied', 'corami').summary).toContain('denies corami');
  });
});

describe('the policy in the health answer', () => {
  test('reads the value of the daemon', () => {
    expect(sshPolicyFromHealth({ tailscale: { ssh_policy: 'check' } })).toBe('check');
    expect(sshPolicyFromHealth({ tailscale: { ssh_policy: null } })).toBeUndefined();
    expect(sshPolicyFromHealth({})).toBeUndefined();
  });
});

describe('the fix of a failed ssh', () => {
  test('a pending Tailscale SSH check gives its link to open', () => {
    const output = [
      '',
      '# Tailscale SSH requires an additional check.',
      '# To authenticate, visit: https://login.tailscale.com/a/l9f0e0de3a6276',
      '',
    ].join('\n');

    expect(sshFailureFix(output)).toBe(
      'Tailscale SSH asks for a check: open https://login.tailscale.com/a/l9f0e0de3a6276, then run the command again. The accept action in the SSH rule of the tailnet policy skips the check',
    );
  });

  test('another failure carries the first lines ssh printed', () => {
    const output = '\ncorami@host: Permission denied (publickey).\n\n';

    expect(sshFailureFix(output)).toBe(
      'Check that ssh works, and that the account owns the projects. ssh said: corami@host: Permission denied (publickey).',
    );
  });

  test('a silent ssh keeps the generic advice', () => {
    expect(sshFailureFix('\n')).toBe(
      'Check that ssh works, and that the account owns the projects',
    );
  });
});

describe('what the policy does with root and the other accounts', () => {
  const accounts: SshAccount[] = [
    { name: 'corami', rootThrough: [] },
    { name: 'ubuntu', rootThrough: ['sudo', 'lxd', 'adm'] },
    { name: 'backup', rootThrough: [] },
  ];

  test('a rule that reaches every account lets root and the others in', () => {
    const exposure = sshExposure(netmapWith([acceptRule]), 'corami', accounts, NOW);

    expect(exposure.root).toBe('accept');
    expect(exposure.accounts.map((account) => account.name)).toEqual(['ubuntu', 'backup']);
  });

  test('a rule that names the account leaves root and the others out', () => {
    const named = {
      principals: [{ nodeIP: '100.64.0.7' }],
      sshUsers: { corami: 'corami' },
      action: { accept: true },
    };
    const rootCheck = { ...checkRule, sshUsers: { root: 'root' } };
    const exposure = sshExposure(netmapWith([named, rootCheck]), 'corami', accounts, NOW);

    expect(exposure.root).toBe('check');
    expect(exposure.accounts).toEqual([]);
  });

  test('the health answer carries root and the accounts of the daemon', () => {
    const health = {
      tailscale: {
        ssh_policy: 'accept',
        ssh_root: 'accept',
        ssh_accounts: [{ name: 'ubuntu', root_through: ['sudo'] }, { name: 'backup' }],
      },
    };

    expect(sshExposureFromHealth(health)).toEqual({
      root: 'accept',
      accounts: [
        { name: 'ubuntu', rootThrough: ['sudo'] },
        { name: 'backup', rootThrough: [] },
      ],
    });
  });

  test('an older daemon has no exposure to read', () => {
    expect(sshExposureFromHealth({ tailscale: { ssh_policy: 'accept' } })).toBeUndefined();
    expect(sshExposureFromHealth({})).toBeUndefined();
  });

  test('root on accept carries the fix, a check on root does not', () => {
    expect(sshRootText('accept').fix).toContain('give root the action check');
    expect(sshRootText('check').fix).toBeUndefined();
    expect(sshRootText('denied').summary).toContain('denies root');
  });

  test('the other accounts are named with the way to root they have', () => {
    const text = sshAccountsText(accounts.slice(1), 'corami');

    expect(text.summary).toContain('ubuntu (can become root: sudo, lxd, adm)');
    expect(text.summary).toContain('backup');
    expect(text.fix).toContain('name corami in the SSH rule');
    expect(sshAccountsText([], 'corami').fix).toBeUndefined();
  });
});

describe('the people of the tailnet', () => {
  test('every login that is not the owner is someone else', () => {
    expect(
      otherPeople(['me@example.com', 'other@example.com', 'tagged-devices'], 'me@example.com'),
    ).toEqual(['other@example.com']);
  });

  test('tagged devices belong to no person', () => {
    expect(otherPeople(['me@example.com', 'tagged-devices'], 'me@example.com')).toEqual([]);
  });

  test('without the owner, a single login is not enough', () => {
    expect(otherPeople(['me@example.com'], undefined)).toEqual([]);
    expect(otherPeople(['me@example.com', 'other@example.com'], undefined)).toEqual([
      'me@example.com',
      'other@example.com',
    ]);
  });

  test('the text names them and says what they reach', () => {
    expect(peopleText([]).summary).toBe('Only you in the tailnet');
    expect(peopleText(['a@example.com']).summary).toContain('previews and the agents');
    expect(peopleText(['a@example.com']).fix).toContain('#people-in-your-tailnet');
  });
});

describe('the protections the setup names once', () => {
  test('any of them off is enough', () => {
    expect(protectionsOff({ root: 'accept' })).toBe(true);
    expect(protectionsOff({ accounts: [{ name: 'ubuntu', rootThrough: [] }] })).toBe(true);
    expect(protectionsOff({ people: ['a@example.com'] })).toBe(true);
    expect(protectionsOff({ root: 'check', accounts: [], people: [] })).toBe(false);
  });

  test('the line points at doctor', () => {
    expect(PROTECTIONS_OFF).toContain('corami doctor');
  });
});
