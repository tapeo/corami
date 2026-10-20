import { describe, expect, test } from 'bun:test';

import {
  addRule,
  allowPrefix,
  decide,
  newRule,
  parseRule,
  removeRule,
  ruleMatches,
  rulesFromJson,
  ruleText,
  runsArbitraryCode,
  validRuleArgv,
} from '@/core/exec-rules.ts';

const added = '2026-10-20T09:00:00.000Z';

describe('validRuleArgv', () => {
  test('accepts a command with a star at the end', () => {
    expect(validRuleArgv(['flutter', 'build', '*'])).toBe(true);
  });

  test('rejects an empty command and a star in the middle', () => {
    expect(validRuleArgv([])).toBe(false);
    expect(validRuleArgv(['flutter', '*', 'ios'])).toBe(false);
  });
});

describe('ruleMatches', () => {
  test('matches the same tokens', () => {
    const rule = newRule('allow', ['flutter', 'devices'], undefined, added);
    expect(ruleMatches(rule, 'myapp', ['flutter', 'devices'])).toBe(true);
    expect(ruleMatches(rule, 'myapp', ['flutter', 'devices', '--json'])).toBe(false);
  });

  test('lets a trailing star cover any rest, empty included', () => {
    const rule = newRule('allow', ['flutter', 'build', '*'], undefined, added);
    expect(ruleMatches(rule, 'myapp', ['flutter', 'build'])).toBe(true);
    expect(ruleMatches(rule, 'myapp', ['flutter', 'build', 'ios'])).toBe(true);
    expect(ruleMatches(rule, 'myapp', ['flutter', 'devices'])).toBe(false);
  });

  test('limits a rule to its project', () => {
    const rule = newRule('deny', ['rm', '*'], 'myapp', added);
    expect(ruleMatches(rule, 'myapp', ['rm', 'build'])).toBe(true);
    expect(ruleMatches(rule, 'other', ['rm', 'build'])).toBe(false);
  });
});

describe('decide', () => {
  test('asks when no rule covers the command', () => {
    expect(decide([], 'myapp', ['flutter', 'devices']).decision).toBe('ask');
  });

  test('allows through a matching rule', () => {
    const rule = newRule('allow', ['flutter', '*'], undefined, added);
    const choice = decide([rule], 'myapp', ['flutter', 'devices']);
    expect(choice.decision).toBe('allow');
    expect(choice.rule).toBe(rule);
  });

  test('lets deny win over allow', () => {
    const rules = [
      newRule('allow', ['rm', '*'], undefined, added),
      newRule('deny', ['rm', 'build'], undefined, added),
    ];
    expect(decide(rules, 'myapp', ['rm', 'build']).decision).toBe('deny');
  });

  test('ignores a rule of another project', () => {
    const rule = newRule('allow', ['flutter', '*'], 'other', added);
    expect(decide([rule], 'myapp', ['flutter', 'devices']).decision).toBe('ask');
  });
});

describe('ruleText', () => {
  test('is the decision and the tokens', () => {
    expect(ruleText(newRule('deny', ['rm', '*'], undefined, added))).toBe('deny rm *');
  });
});

describe('runsArbitraryCode', () => {
  test('warns for a package runner and for a shell', () => {
    expect(runsArbitraryCode(newRule('allow', ['npx', '*'], undefined, added))).toBe(true);
    expect(runsArbitraryCode(newRule('allow', ['/bin/zsh', '*'], undefined, added))).toBe(true);
    expect(runsArbitraryCode(newRule('allow', ['pnpm', 'dlx', '*'], undefined, added))).toBe(true);
  });

  test('stays quiet for a normal tool', () => {
    expect(runsArbitraryCode(newRule('allow', ['flutter', '*'], undefined, added))).toBe(false);
  });
});

describe('allowPrefix', () => {
  test('keeps the program alone', () => {
    expect(allowPrefix(['xcrun', 'simctl', 'boot', 'iPhone 16'])).toEqual(['xcrun', '*']);
    expect(allowPrefix(['flutter', 'devices'])).toEqual(['flutter', '*']);
    expect(allowPrefix(['adb'])).toEqual(['adb', '*']);
  });
});

describe('addRule and removeRule', () => {
  test('replaces the same rule instead of duplicating it', () => {
    const rule = newRule('allow', ['flutter', '*'], undefined, added);
    const next = addRule([rule], { ...rule, added: '2026-10-21T09:00:00.000Z' });
    expect(next).toHaveLength(1);
    expect(next[0]?.added).toBe('2026-10-21T09:00:00.000Z');
  });

  test('removes only the matching command and project', () => {
    const one = newRule('allow', ['flutter', '*'], undefined, added);
    const two = newRule('allow', ['flutter', '*'], 'myapp', added);
    expect(removeRule([one, two], ['flutter', '*'], 'myapp')).toEqual([one]);
  });
});

describe('parseRule', () => {
  test('reads a stored rule', () => {
    expect(
      parseRule({ decision: 'allow', argv: ['flutter', '*'], project: 'myapp', added }),
    ).toEqual({ decision: 'allow', argv: ['flutter', '*'], project: 'myapp', added });
  });

  test('rejects a wrong decision and a star in the middle', () => {
    expect(parseRule({ decision: 'maybe', argv: ['flutter'], added })).toBeUndefined();
    expect(parseRule({ decision: 'allow', argv: ['flutter', '*', 'ios'], added })).toBeUndefined();
  });
});

describe('rulesFromJson', () => {
  test('reads the file of the client', () => {
    const text = JSON.stringify([{ decision: 'allow', argv: ['flutter', '*'], added }]);
    expect(rulesFromJson(text)).toHaveLength(1);
  });

  test('gives nothing for broken JSON or a broken rule', () => {
    expect(rulesFromJson('{')).toBeUndefined();
    expect(rulesFromJson(JSON.stringify([{ decision: 'allow', argv: [] }]))).toBeUndefined();
  });
});
