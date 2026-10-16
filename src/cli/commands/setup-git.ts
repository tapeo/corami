import type { CommandContext } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanFlag, stringFlag } from '@/cli/parser.ts';
import { CoramiError } from '@/core/errors.ts';
import { run as exec } from '@/core/exec.ts';
import {
  addSshConfig,
  generateKey,
  keyExists,
  PROVIDERS,
  publicKeyPath,
  readPublicKey,
  rewriteHttpsRemotes,
  testProvider,
} from '@/integrations/ssh.ts';

interface GitStepResult {
  step: string;
  status: 'done' | 'skipped' | 'failed' | 'waiting';
  summary: string;
  detail?: string | undefined;
}

export async function runGitSetup(
  context: CommandContext,
): Promise<{ data?: unknown; text?: string }> {
  const providerId = stringFlag(context.args, 'provider') ?? 'github';
  const provider = PROVIDERS[providerId];

  if (provider === undefined) {
    throw new CoramiError({
      code: 'usage',
      message: `Unknown provider: ${providerId}`,
      fix: `Available providers: ${Object.keys(PROVIDERS).join(', ')}`,
    });
  }

  const dryRun = booleanFlag(context.args, 'dry-run');
  const results: GitStepResult[] = [];

  if (dryRun) {
    results.push({ step: 'key', status: 'skipped', summary: `Would create ${publicKeyPath()}` });
    results.push({
      step: 'config',
      status: 'skipped',
      summary: `Would configure ssh for ${provider.host}`,
    });
    results.push({ step: 'verify', status: 'skipped', summary: 'Would test the connection' });
    return output(context, results, undefined);
  }

  const existed = await keyExists();
  await generateKey('corami');
  results.push({
    step: 'key',
    status: 'done',
    summary: existed ? 'Key already present' : 'Key created',
    detail: publicKeyPath(),
  });

  const configured = await addSshConfig(provider);
  results.push({
    step: 'config',
    status: 'done',
    summary: configured
      ? `Added ${provider.host} to ~/.ssh/config`
      : `${provider.host} already configured`,
  });

  const publicKey = await readPublicKey();
  const test = await testProvider(provider);

  if (!test.ok) {
    results.push({
      step: 'verify',
      status: 'waiting',
      summary: `Add the public key to ${provider.host}`,
      detail: provider.newKeyUrl,
    });

    return output(context, results, publicKey, provider.newKeyUrl);
  }

  results.push({
    step: 'verify',
    status: 'done',
    summary: `Access to ${provider.host} works`,
    detail: test.detail,
  });

  const identityName = stringFlag(context.args, 'identity-name') ?? 'Corami';
  const identityEmail = stringFlag(context.args, 'identity-email');

  if (identityEmail !== undefined) {
    await exec('git', ['config', '--global', 'user.name', identityName]);
    await exec('git', ['config', '--global', 'user.email', identityEmail]);
    results.push({
      step: 'identity',
      status: 'done',
      summary: `git identity set to ${identityName} <${identityEmail}>`,
    });
  }

  await rewriteHttpsRemotes(provider);
  results.push({
    step: 'remotes',
    status: 'done',
    summary: `HTTPS URLs for ${provider.host} now use SSH`,
  });

  return output(context, results, publicKey);
}

function output(
  context: CommandContext,
  results: GitStepResult[],
  publicKey: string | undefined,
  newKeyUrl?: string,
): { data?: unknown; text?: string } {
  if (context.output.json) {
    return { data: { steps: results, public_key: publicKey, add_key_url: newKeyUrl } };
  }

  const lines = [
    renderTable(results, [
      { header: 'Step', value: (row) => row.step },
      { header: 'Result', value: (row) => row.status },
      { header: 'Detail', value: (row) => row.summary },
    ]),
  ];

  if (publicKey !== undefined) {
    lines.push('', 'Public key:', publicKey);
  }

  if (results.some((result) => result.status === 'waiting')) {
    lines.push(
      '',
      `Add the key on ${newKeyUrl ?? 'the provider'}, then run again: corami setup git`,
    );
  }

  return { text: lines.join('\n') };
}
