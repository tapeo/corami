import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function corami(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: ['bun', MAIN, ...args],
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

describe('cli', () => {
  test('prints the version as JSON when stdout is not a tty', async () => {
    const result = await corami(['--version'], { CORAMI_VERSION: '' });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.name).toBe('corami');
    expect(parsed.data.version).toBe('dev');
  });

  test('reads the version from CORAMI_VERSION when it is set', async () => {
    const result = await corami(['--version'], { CORAMI_VERSION: '1.2.3' });
    expect(JSON.parse(result.stdout).data.version).toBe('1.2.3');
  });

  test('does not mistake the version of update for the global flag', async () => {
    const result = await corami(['update', '--version', 'v9.9.9', '--check']);
    const parsed = JSON.parse(result.stdout);

    // The global flag answers with the name and version envelope; the update
    // command answers with its own data or its own error.
    expect(parsed.data?.name).toBeUndefined();
  });

  test('refuses to replace bun when update runs from the source tree', async () => {
    const result = await corami(['update']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('generic');
    expect(parsed.error.message).toContain('source tree');
  });

  test('prints the help as JSON when stdout is not a tty', async () => {
    const result = await corami(['--help']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.data.name).toBe('corami');
    expect(parsed.data.global_flags.map((flag: { name: string }) => flag.name)).toEqual([
      'json',
      'help',
      'version',
    ]);
  });

  test('refuses an unknown flag with a usage error', async () => {
    const result = await corami(['doctor', '--areaa', 'net']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toContain('--areaa');
  });

  test('prints per command help', async () => {
    const result = await corami(['serve', '--help']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.usage).toContain('corami serve <port>');
  });

  test('answers corami help like --help', async () => {
    const asked = await corami(['help', 'sync', 'prune']);
    const flagged = await corami(['sync', 'prune', '--help']);

    expect(asked.exitCode).toBe(0);
    expect(asked.stdout).toBe(flagged.stdout);
    expect(JSON.parse(asked.stdout).data.command).toBe('sync prune');
  });

  test('refuses an unknown flag of doctor', async () => {
    const result = await corami(['doctor', '--area', 'net']);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toBe('Unknown flag for corami doctor: --area');
  });

  test('refuses an area of doctor as an argument', async () => {
    const result = await corami(['doctor', 'net']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toBe('Too many arguments for corami doctor: net');
  });

  test('fails with a usage error on an unknown command', async () => {
    const result = await corami(['nonsense']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.fix).toContain('--help');
  });

  test('asks for an action when a command group is called alone', async () => {
    const result = await corami(['project']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.fix).toContain('corami project');
  });

  test('asks for the action of sync, and drops the name without one', async () => {
    const alone = await corami(['sync']);
    const named = await corami(['sync', 'myapp']);
    const parsed = JSON.parse(alone.stdout);
    const namedParsed = JSON.parse(named.stdout);

    expect(alone.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toBe('Missing action for corami sync');
    expect(parsed.error.fix).toContain('corami sync status');
    expect(named.exitCode).toBe(2);
    expect(namedParsed.error.code).toBe('usage');
    expect(namedParsed.error.message).toBe('Unknown action for corami sync: myapp');
    expect(namedParsed.error.fix).toContain('corami sync status');
  });

  test('gives project add its folder, and sync stop no flags', async () => {
    const add = JSON.parse((await corami(['project', 'add', '--help'])).stdout).data;
    const stop = JSON.parse((await corami(['sync', 'stop', '--help'])).stdout).data;
    const names = (spec: { flags: Array<{ name: string }> }) => spec.flags.map((flag) => flag.name);

    expect(add.usage).toStartWith('corami project add <folder>');
    expect(names(add)).toContain('from-git');
    expect(names(add)).toContain('from-server');
    expect(names(add)).toContain('server-path');
    expect(stop.usage).toBe('corami sync stop [<project>]');
    expect(stop.flags).toEqual([]);
  });

  test('takes the folder as the argument, and no second form for it', async () => {
    const add = JSON.parse((await corami(['project', 'add', '--help'])).stdout).data;
    const rm = JSON.parse((await corami(['project', 'rm', '--help'])).stdout).data;
    const names = (spec: { flags: Array<{ name: string }> }) => spec.flags.map((flag) => flag.name);

    expect(names(add)).toContain('server-path');
    expect(names(add)).not.toContain('path');
    expect(names(add)).not.toContain('local-path');
    // A folder of this machine is the source without a flag: a second name for
    // it would be one form too many.
    expect(names(add)).not.toContain('from-local');
    expect(names(rm)).not.toContain('local-path');

    const removal = await corami(['project', 'rm', 'myapp', '--local-path', '/tmp/myapp']);

    expect(removal.exitCode).toBe(2);
    expect(JSON.parse(removal.stdout).error.message).toBe(
      'Unknown flag for corami project rm: --local-path',
    );

    const unknown = await corami(['project', 'add', '--from-local', '/tmp/myapp']);

    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout).error.message).toBe(
      'Unknown flag for corami project add: --from-local',
    );

    const old = await corami(['project', 'add', '--local-path', '/tmp/myapp']);

    expect(old.exitCode).toBe(2);
    expect(JSON.parse(old.stdout).error.message).toBe(
      'Unknown flag for corami project add: --local-path',
    );

    const missing = await corami(['project', 'add', '--from-git', 'git@example.com:me/app.git']);

    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error.message).toBe('Missing folder');
  });

  test('refuses the arguments a command does not read', async () => {
    const extra = await corami(['project', 'add', 'myapp', 'flutter-agent-kit']);
    const status = await corami(['sync', 'status', 'myapp', 'extra']);

    expect(extra.exitCode).toBe(2);
    expect(JSON.parse(extra.stdout).error.message).toBe(
      'Too many arguments for corami project add: flutter-agent-kit',
    );
    expect(JSON.parse(extra.stdout).error.fix).toContain('Usage: corami project add <folder>');
    expect(status.exitCode).toBe(2);
    expect(JSON.parse(status.stdout).error.message).toBe(
      'Too many arguments for corami sync status: extra',
    );
  });

  test('never takes the copy to remove from the current folder', async () => {
    const result = await corami(['project', 'rm']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.message).toContain('Missing project');
  });

  test('needs the folder of this machine, always and without asking', async () => {
    const source = await corami(['project', 'add']);
    const parsedSource = JSON.parse(source.stdout);

    expect(source.exitCode).toBe(2);
    expect(parsedSource.error.message).toBe('Missing folder');
    expect(parsedSource.error.fix).toContain('corami project add <folder>');
    expect(parsedSource.error.fix).toContain('--from-git <url>');
    expect(parsedSource.error.fix).toContain('--from-server');
  });

  test('refuses two sources of a project at once', async () => {
    const result = await corami([
      'project',
      'add',
      '/tmp/app',
      '--from-git',
      'git@example.com:me/app.git',
      '--from-server',
      '--server-path',
      '~/projects/app',
    ]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.message).toBe('Give only one of --from-git or --from-server');
  });

  test('refuses a name the sync engine cannot take, even before the server', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'corami-import-'));
    const result = await corami(['project', 'add', folder, '--name', 'my_app']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toBe('Invalid project name: my_app');
    expect(parsed.error.fix).toContain('dashes');
  });

  test('says when the sync engine does not answer, instead of "no sessions"', async () => {
    const home = await mkdtemp(join(tmpdir(), 'corami-home-'));
    mkdirSync(join(home, '.corami'), { recursive: true });
    writeFileSync(
      join(home, '.corami', 'config.json'),
      JSON.stringify({ role: 'client', server_host: 'corami.example.ts.net' }),
    );
    // An engine that is there and does not answer: the session list is not
    // an empty list, it is an answer that never came.
    const bin = await mkdtemp(join(tmpdir(), 'corami-bin-'));
    const fake = join(bin, 'mutagen');
    writeFileSync(fake, '#!/bin/sh\necho "connection refused" >&2\nexit 1\n');
    chmodSync(fake, 0o755);

    const result = await corami(['sync', 'status'], {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(3);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('capability_missing');
    expect(parsed.error.message).toContain('Mutagen');
  });

  test('asks for the confirmation of the copy too, unless it is a dry run', async () => {
    const unconfirmed = await corami(['project', 'rm', 'myapp', '--on', 'client']);
    const parsed = JSON.parse(unconfirmed.stdout);

    expect(unconfirmed.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toBe('Confirmation required to remove the copy of myapp');
    expect(parsed.error.fix).toContain('--on client --yes');
  });

  test('reads a bare --version as the value update is missing', async () => {
    const result = await corami(['update', '--version']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toBe('Missing value for --version');
  });

  test('refuses --no-git for the import before a dry run says what it would do', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'corami-import-'));
    const result = await corami(['project', 'add', folder, '--no-git', '--dry-run']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.message).toBe('--no-git does not apply to the import');
  });

  test('asks project rm where the project leaves from', async () => {
    const missing = await corami(['project', 'rm', 'myapp', '--yes']);
    const wrong = await corami(['project', 'rm', 'myapp', '--on', 'both', '--yes']);
    const unconfirmed = await corami(['project', 'rm', 'myapp', '--on', 'server']);
    const forced = await corami(['project', 'rm', 'myapp', '--on', 'server', '--force', '--yes']);

    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout).error.message).toContain('Missing --on');
    expect(JSON.parse(wrong.stdout).error.message).toBe('Unknown --on both');
    expect(JSON.parse(unconfirmed.stdout).error.fix).toContain('--on server --yes');
    expect(JSON.parse(forced.stdout).error.message).toBe(
      '--force applies to the copy of this machine',
    );
  });

  test('asks for the role when setup is called alone', async () => {
    const result = await corami(['setup']);
    const parsed = JSON.parse(result.stdout);

    // A bare `corami setup` used to mean the server: on a Mac it would have
    // started the server setup.
    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.fix).toContain('corami setup server');
    expect(parsed.error.fix).toContain('corami setup client <server>');
  });

  test('asks for the server when setup client is called without it', async () => {
    const result = await corami(['setup', 'client']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe('usage');
    expect(parsed.error.message).toContain('server');
  });

  test('lists the client steps on an unknown one', async () => {
    const result = await corami(['setup', 'client', 'corami.example.ts.net', '--step', 'nope']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.fix).toContain('mutagen-daemon');
    expect(parsed.error.fix).toContain('git-watch');
  });

  test('reports a configuration that cannot be read instead of a server that is away', async () => {
    const home = await mkdtemp(join(tmpdir(), 'corami-home-'));
    mkdirSync(join(home, '.corami'), { recursive: true });
    writeFileSync(join(home, '.corami', 'config.json'), '{ broken');

    const result = await corami(['project', 'ls'], { HOME: home });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('config_invalid');
    expect(parsed.error.message).toContain('Invalid JSON');
  });

  test('fails the setup when a step fails', async () => {
    // Nothing listens for TLS on the loopback preview of this machine, and no
    // Corami server answers: the step daemon fails.
    const home = await mkdtemp(join(tmpdir(), 'corami-home-'));
    const result = await corami(
      ['setup', 'client', '127.0.0.1', '--user', 'root', '--step', 'daemon', '--dry-run'],
      { HOME: home },
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('generic');
    expect(parsed.error.message).toContain('Setup stopped at daemon');
    expect(parsed.error.details.steps.map((step: { step: string }) => step.step)).toContain(
      'daemon',
    );
  });

  test('refuses the flag of another action', async () => {
    for (const [argv, flag, path] of [
      [['project', 'ls', '--include', 'x'], '--include', 'project ls'],
      [['serve', 'rm', 'web', '--name', 'x'], '--name', 'serve rm'],
      [['serve', 'ls', '--project', 'x'], '--project', 'serve ls'],
      [
        ['setup', 'client', 'corami.example.ts.net', '--hostname', 'x'],
        '--hostname',
        'setup client',
      ],
      [['setup', '--owner', 'me@example.com'], '--owner', 'setup'],
    ] as const) {
      const result = await corami([...argv]);
      const parsed = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(2);
      expect(parsed.error.message).toBe(`Unknown flag for corami ${path}: ${flag}`);
      expect(parsed.error.fix).toBe(`Run corami ${path} --help to see its flags`);
    }
  });

  test('prints the help of an action with its flags only', async () => {
    const result = await corami(['sync', 'prune', '--help']);
    const help = JSON.parse(result.stdout).data;
    const flags = help.flags.map((flag: { name: string }) => flag.name);

    expect(result.exitCode).toBe(0);
    expect(help.usage).toStartWith('corami sync prune');
    expect(flags).toContain('unused');
    expect(flags).not.toContain('path');
  });

  test('lists the actions in the help of a command', async () => {
    const help = JSON.parse((await corami(['sync', '--help'])).stdout).data;

    expect(help.actions.map((action: { name: string }) => action.name)).toContain('prune');
    expect(help.flags.map((flag: { name: string }) => flag.name)).not.toContain('unused');
  });

  test('asks for the action of git', async () => {
    const result = await corami(['git']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.message).toBe('Missing action for corami git');
    expect(parsed.error.fix).toBe('Use corami git watch');
  });

  test('lists every command in the help but the daemon', async () => {
    const result = await corami(['--help']);
    const names = JSON.parse(result.stdout).data.commands.map(
      (command: { name: string }) => command.name,
    );

    expect(names).toEqual(['doctor', 'git', 'project', 'serve', 'setup', 'sync', 'update']);
    expect((await corami(['daemon', '--help'])).exitCode).toBe(0);
  });

  test('reports the daemon as unreachable when there is none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'corami-test-'));

    // An address where nobody listens on any machine: on the test one
    // 127.0.0.1:7420 is the real daemon, and 127.0.0.2 on macOS does not
    // refuse the connection, it lets it expire. ::1 refuses right away, on
    // both macOS and Linux, and nobody uses it.
    mkdirSync(join(home, '.corami'), { recursive: true });
    writeFileSync(
      join(home, '.corami', 'config.json'),
      `${JSON.stringify({ role: 'client', server_host: '[::1]' })}\n`,
    );

    const result = await corami(['project', 'ls'], { HOME: home });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(5);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('server_unreachable');
  });
});
