import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
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

  test('prints help and lists commands', async () => {
    const result = await corami(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('corami');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('serve');
    expect(result.stdout).toContain('git');
  });

  test('prints per command help', async () => {
    const result = await corami(['serve', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('corami serve <port>');
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

  test('lists every command in the help', async () => {
    const result = await corami(['--help']);
    const names = (result.stdout.match(/^ {2}[a-z-]+/gm) ?? []).map((line) => line.trim());

    expect(names).toContain('sync');
    expect(names).toContain('serve');
    expect(names).not.toContain('build');
    expect(names).not.toContain('up');
    expect(names.length).toBeGreaterThanOrEqual(8);
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
