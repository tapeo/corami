import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@/core/exec.ts';
import { PROVIDERS, rewriteHttpsRemotes } from '@/integrations/ssh.ts';

describe('setup git remotes', () => {
  test('writes insteadOf without quoting the subsection, replacing the old rule', async () => {
    const home = await mkdtemp(join(tmpdir(), 'corami-ssh-'));
    const provider = PROVIDERS.github;

    if (provider === undefined) {
      throw new Error('the github provider is missing');
    }

    const previousHome = process.env.HOME;
    const previousConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');

    try {
      await run('git', [
        'config',
        '--global',
        'url."git@github.com:".insteadOf',
        'https://github.com/',
      ]);
      await rewriteHttpsRemotes(provider);

      const written = await Bun.file(join(home, '.gitconfig')).text();
      const listed = await run('git', ['config', '--global', '--get-regexp', 'url']);

      expect(written).not.toContain('\\');
      expect(written).toContain('[url "git@github.com:"]');
      expect(listed.stdout.trim()).toBe('url.git@github.com:.insteadof https://github.com/');
    } finally {
      restore('HOME', previousHome);
      restore('GIT_CONFIG_GLOBAL', previousConfig);
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
