import type { CommandContext, CommandResult } from '@/cli/command.ts';
import { listPending, readRules, writeDecision, writeRules } from '@/cli/exec-files.ts';
import { renderTable } from '@/cli/output.ts';
import { stringFlag } from '@/cli/parser.ts';
import { canPrompt, terminalPrompter } from '@/cli/prompt.ts';
import { CoramiError } from '@/core/errors.ts';
import {
  addRule,
  allowPrefix,
  newRule,
  removeRule,
  ruleText,
  ruleWithProject,
  runsArbitraryCode,
  validRuleArgv,
} from '@/core/exec-rules.ts';

export async function rule(context: CommandContext): Promise<CommandResult> {
  const action = context.args.positionals[0] ?? '';
  const argv = context.args.rest;
  const project = stringFlag(context.args, 'project');

  if (action !== 'allow' && action !== 'deny' && action !== 'rm') {
    throw new CoramiError({
      code: 'usage',
      message: `Unknown action for corami exec rule: ${action === '' ? '(missing)' : action}`,
      fix: 'Use corami exec rule allow, deny or rm, with the command after --',
    });
  }

  if (argv.length === 0) {
    throw new CoramiError({
      code: 'usage',
      message: 'Missing the command of the rule',
      fix: "corami exec rule allow -- flutter build '*'",
    });
  }

  if (!validRuleArgv(argv)) {
    throw new CoramiError({
      code: 'usage',
      message: 'The star * is only the last token of a rule',
      fix: "corami exec rule allow -- flutter build '*'",
    });
  }

  const rules = await readRules();

  if (action === 'rm') {
    const next = removeRule(rules, argv, project);

    if (next.length === rules.length) {
      throw new CoramiError({
        code: 'config_invalid',
        message: `No rule matches ${argv.join(' ')}`,
        fix: 'corami exec rules lists the rules of this machine',
      });
    }

    await writeRules(next);

    return context.output.json
      ? { data: { removed: { argv, project: project ?? null } } }
      : { text: `Rule removed: ${argv.join(' ')}` };
  }

  const added = newRule(action, argv, project);

  await writeRules(addRule(rules, added));

  const lines = [`Rule added: ${ruleWithProject(added)}`];

  if (runsArbitraryCode(added)) {
    lines.push(
      `${argv[0] ?? ''} runs code of the project or of the network: this rule allows all of it.`,
    );
  }

  return context.output.json ? { data: { rule: added } } : { text: lines.join('\n') };
}

export async function rules(context: CommandContext): Promise<CommandResult> {
  const list = await readRules();

  if (context.output.json) {
    return { data: { rules: list } };
  }

  if (list.length === 0) {
    return { text: 'No rules: every command asks first.' };
  }

  const rows = list.map((entry) => ({
    rule: ruleText(entry),
    project: entry.project ?? 'any',
    added: entry.added.slice(0, 16).replace('T', ' '),
  }));

  return {
    text: renderTable(rows, [
      { header: 'Rule', value: (row) => row.rule },
      { header: 'Project', value: (row) => row.project },
      { header: 'Added', value: (row) => row.added },
    ]),
  };
}

export async function approve(context: CommandContext): Promise<CommandResult> {
  if (!canPrompt(context.output)) {
    throw new CoramiError({
      code: 'usage',
      message: 'exec approve runs only in a terminal on the client',
      fix: 'Open a terminal on the client and run corami exec approve there',
    });
  }

  const pending = await listPending();

  if (pending.length === 0) {
    return { text: 'No command is waiting.' };
  }

  const prompter = terminalPrompter();
  let handled = 0;

  for (const request of pending) {
    prompter.say();
    prompter.say(`The server asks to run, in ${request.project}:`);
    prompter.say(`  ${request.argv.join(' ')}`);

    if (runsArbitraryCode(newRule('allow', request.argv, request.project))) {
      prompter.say(
        `  ${request.argv[0] ?? ''} runs code of the project or of the network: "Always allow" covers all of it.`,
      );
    }

    prompter.say();

    const prefix = allowPrefix(request.argv);
    const choice = await prompter.choose('What do you allow?', [
      { label: 'Allow once', value: 'once' as const },
      { label: `Always allow: ${prefix.join(' ')}`, value: 'prefix' as const },
      { label: 'Always allow exactly this command', value: 'exact' as const },
      { label: 'Deny', value: 'deny' as const },
    ]);

    if (choice === 'deny') {
      await writeDecision(request.id, { decision: 'deny' });
    } else if (choice === 'once') {
      await writeDecision(request.id, { decision: 'allow' });
    } else {
      const argv = choice === 'prefix' ? prefix : request.argv;
      const rules = await readRules();

      await writeRules(addRule(rules, newRule('allow', argv, request.project)));
      await writeDecision(request.id, { decision: 'allow' });
      prompter.say(`✓ Rule added: allow ${argv.join(' ')}`);
    }

    handled += 1;
    await Bun.sleep(50);
  }

  return context.output.json ? { data: { handled } } : { text: `Handled ${handled}.` };
}
