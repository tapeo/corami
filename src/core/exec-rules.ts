export type ExecDecision = 'allow' | 'ask' | 'deny';

export interface ExecRule {
  decision: ExecDecision;
  argv: string[];
  project?: string | undefined;
  added: string;
}

export interface ExecChoice {
  decision: ExecDecision;
  rule?: ExecRule | undefined;
}

const ARBITRARY_CODE = new Set([
  'bash',
  'bun',
  'bunx',
  'deno',
  'env',
  'node',
  'npx',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'sh',
  'zsh',
]);

export function validRuleArgv(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }

  const star = argv.indexOf('*');

  return star === -1 || star === argv.length - 1;
}

export function parseRule(value: unknown): ExecRule | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const decision = record.decision;
  const argv = record.argv;
  const project = record.project;

  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
    return undefined;
  }

  if (!Array.isArray(argv) || !argv.every((token) => typeof token === 'string')) {
    return undefined;
  }

  if (!validRuleArgv(argv as string[])) {
    return undefined;
  }

  if (project !== undefined && typeof project !== 'string') {
    return undefined;
  }

  return {
    decision,
    argv: argv as string[],
    project: project as string | undefined,
    added: typeof record.added === 'string' ? record.added : '',
  };
}

export function ruleMatches(rule: ExecRule, project: string, argv: string[]): boolean {
  if (rule.project !== undefined && rule.project !== project) {
    return false;
  }

  const star = rule.argv.at(-1) === '*';
  const fixed = star ? rule.argv.slice(0, -1) : rule.argv;

  if (star) {
    if (argv.length < fixed.length) {
      return false;
    }
  } else if (argv.length !== fixed.length) {
    return false;
  }

  return fixed.every((token, index) => argv[index] === token);
}

export function decide(rules: ExecRule[], project: string, argv: string[]): ExecChoice {
  let allowed: ExecRule | undefined;

  for (const rule of rules) {
    if (!ruleMatches(rule, project, argv)) {
      continue;
    }

    if (rule.decision === 'deny') {
      return { decision: 'deny', rule };
    }

    if (rule.decision === 'allow' && allowed === undefined) {
      allowed = rule;
    }
  }

  if (allowed !== undefined) {
    return { decision: 'allow', rule: allowed };
  }

  return { decision: 'ask' };
}

export function ruleText(rule: ExecRule): string {
  return `${rule.decision} ${rule.argv.join(' ')}`;
}

export function ruleWithProject(rule: ExecRule): string {
  if (rule.project === undefined) {
    return ruleText(rule);
  }

  return `${ruleText(rule)} (project ${rule.project})`;
}

export function runsArbitraryCode(rule: ExecRule): boolean {
  const program = rule.argv[0] ?? '';
  const base = program.slice(program.lastIndexOf('/') + 1);

  if (ARBITRARY_CODE.has(base)) {
    return true;
  }

  const second = rule.argv[1];

  return (base === 'pnpm' || base === 'yarn') && second === 'dlx';
}

export function allowPrefix(argv: string[]): string[] {
  return [argv[0] ?? '', '*'];
}

export function newRule(
  decision: ExecDecision,
  argv: string[],
  project: string | undefined,
  added = new Date().toISOString(),
): ExecRule {
  return { decision, argv, project, added };
}

export function addRule(rules: ExecRule[], rule: ExecRule): ExecRule[] {
  const rest = rules.filter(
    (item) =>
      item.decision !== rule.decision ||
      item.project !== rule.project ||
      item.argv.join('\u0000') !== rule.argv.join('\u0000'),
  );

  return [...rest, rule];
}

export function removeRule(
  rules: ExecRule[],
  argv: string[],
  project: string | undefined,
): ExecRule[] {
  return rules.filter(
    (item) => item.project !== project || item.argv.join('\u0000') !== argv.join('\u0000'),
  );
}

export function rulesJson(rules: ExecRule[]): string {
  return `${JSON.stringify(rules, null, 2)}\n`;
}

export function rulesFromJson(text: string): ExecRule[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const rules: ExecRule[] = [];

  for (const entry of parsed) {
    const rule = parseRule(entry);

    if (rule === undefined) {
      return undefined;
    }

    rules.push(rule);
  }

  return rules;
}
