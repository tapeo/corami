import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeSide } from '@/cli/commands/git.ts';
import { type GitRepoState, gitStateJson, parseGitState } from '@/core/git-align.ts';
import {
  describeOrigin,
  fetchFailed,
  type GitOriginStatus,
  originChanged,
  originChangeJson,
  originNeedsWatch,
} from '@/core/git-follow.ts';
import { mutagenDaemonSpec } from '@/integrations/mutagen.ts';
import {
  describeLaunchdState,
  gitWatchSpec,
  parseLaunchdPrint,
  renderLaunchAgent,
  renderScheduledTask,
} from '@/integrations/service.ts';
import { renderUnit } from '@/integrations/systemd.ts';

function origin(overrides: Partial<GitOriginStatus> = {}): GitOriginStatus {
  return {
    state: state(),
    upstream: 'origin/main',
    upstreamCommit: 'b'.repeat(40),
    status: 'aligned',
    reason: undefined,
    move: false,
    fetched: true,
    filesHere: true,
    ...overrides,
  };
}

function state(overrides: Partial<GitRepoState> = {}): GitRepoState {
  return {
    commit: 'a'.repeat(40),
    branch: 'main',
    operation: undefined,
    staged: false,
    dirtyChanges: 0,
    ...overrides,
  };
}

describe('side summary', () => {
  test('shows the commit, the operation and the pending changes', () => {
    expect(summarizeSide(state())).toBe(`main ${'a'.repeat(8)}`);
    expect(summarizeSide(state({ operation: 'rebase', staged: true, dirtyChanges: 3 }))).toContain(
      'rebase stage',
    );
    expect(summarizeSide(state({ dirtyChanges: 3 }))).toContain('3 file');
    expect(summarizeSide(state({ branch: '' }))).toContain('HEAD');
    expect(summarizeSide(undefined)).toBe('n/a');
    expect(summarizeSide(state({ commit: '' }))).toBe('n/a');
  });
});

describe('origin summary', () => {
  test('describes each relation with origin', () => {
    expect(describeOrigin(undefined)).toBe('n/a');
    expect(describeOrigin(origin())).toBe('aligned with origin');
    expect(describeOrigin(origin({ status: 'ahead' }))).toContain('push');
    expect(describeOrigin(origin({ status: 'diverged', reason: 'history_diverged' }))).toBe(
      'diverged from origin',
    );
    expect(describeOrigin(origin({ status: 'behind', reason: 'staged' }))).toContain('staged');
    expect(
      describeOrigin(origin({ status: 'behind', reason: 'waiting_for_files', filesHere: false })),
    ).toContain('sync');
    expect(describeOrigin(origin({ status: 'unknown', reason: 'no_upstream' }))).toContain(
      'no_upstream',
    );
  });

  test('ties the alignment to the service only when the update could run', () => {
    const behind = origin({ status: 'behind', move: true });

    expect(describeOrigin(behind)).toBe('behind (to update)');
    expect(describeOrigin(behind, false)).toBe(
      'behind (to update), git alignment service not running',
    );
    expect(originNeedsWatch(behind)).toBe(true);

    const staged = origin({ status: 'behind', reason: 'staged', move: false });

    expect(describeOrigin(staged, false)).toBe('behind (staged)');
    expect(originNeedsWatch(staged)).toBe(false);
    expect(originNeedsWatch(origin())).toBe(false);
  });

  test('writes one json line for each change of state', () => {
    const line = originChangeJson('demo', origin(), 'c'.repeat(40));

    expect(line.project).toBe('demo');
    expect(line.status).toBe('aligned');
    expect(line.reason).toBeNull();
    expect(line.from).toBe('c'.repeat(40));
    expect(line.to).toBe('a'.repeat(40));
    expect(line.upstream_commit).toBe('b'.repeat(40));
    expect(line.fetched).toBe(true);

    const first = originChangeJson(
      'demo',
      origin({ status: 'behind', reason: 'staged' }),
      undefined,
    );
    expect(first.from).toBeNull();
    expect(first.reason).toBe('staged');
  });

  test('tells the fetch failures apart from the quiet rounds', () => {
    const aligned = origin();
    const same = origin();
    const failing = origin({ fetched: false });
    const moved = origin({ state: { ...aligned.state, commit: 'd'.repeat(40) } });

    expect(originChanged(aligned, same, false)).toBe(false);
    expect(originChanged(aligned, moved, false)).toBe(true);
    expect(originChanged(aligned, origin({ status: 'ahead' }), false)).toBe(true);
    expect(originChanged(undefined, aligned, false)).toBe(true);
    expect(originChanged(aligned, failing, false)).toBe(true);
    expect(originChanged(failing, failing, true)).toBe(false);
    expect(originChanged(failing, aligned, true)).toBe(true);

    const missingRepo = origin({ status: 'unknown', upstream: undefined, fetched: false });

    expect(fetchFailed(missingRepo)).toBe(false);
    expect(originChanged(missingRepo, { ...missingRepo }, false)).toBe(false);
  });
});

describe('service files', () => {
  const spec = gitWatchSpec('/usr/local/bin/corami');

  test('the git alignment service is the same on server and clients', () => {
    expect(spec.name).toBe('corami-git-watch');
    expect(gitWatchSpec('/usr/local/bin/corami', 'system').systemdScope).toBe('system');
    expect(gitWatchSpec('/usr/local/bin/corami').systemdScope).toBeUndefined();
  });

  test('the log of the service goes to the home of the account it runs as', () => {
    expect(gitWatchSpec('/usr/local/bin/corami', 'user', '/home/corami').logFile).toBe(
      '/home/corami/.corami/logs/git-watch.log',
    );
  });

  test('the Mutagen daemon runs in the foreground under its service', () => {
    const mutagen = mutagenDaemonSpec('/home/me/.corami/bin/mutagen');

    expect(mutagen.name).toBe('corami-mutagen');
    expect(mutagen.args).toEqual(['daemon', 'run']);
    expect(mutagen.restart).toBe(true);
  });

  test('launch agent keeps the process alive and starts at load', () => {
    const plist = renderLaunchAgent(spec);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('dev.corami.git-watch');
    expect(plist).toContain('<string>/usr/local/bin/corami</string>');
    expect(plist).toContain('<string>git</string>');
    expect(plist).toContain('<string>watch</string>');
  });

  test('launch agent escapes xml', () => {
    expect(renderLaunchAgent({ ...spec, binary: '/opt/<corami>&co/corami' })).toContain(
      '/opt/&lt;corami&gt;&amp;co/corami',
    );
  });

  test('launch agent keeps what the service prints in a log file', () => {
    const plist = renderLaunchAgent(spec);

    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain(`${join(homedir(), '.corami', 'logs', 'git-watch.log')}`);

    expect(renderLaunchAgent({ ...spec, logFile: undefined })).not.toContain('StandardOutPath');
  });

  test('windows task runs at logon with restart on failure', () => {
    const xml = renderScheduledTask(spec);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Command>/usr/local/bin/corami</Command>');
    expect(xml).toContain('<Arguments>git watch</Arguments>');
  });

  test('the systemd unit of the server runs as its user', () => {
    const unit = renderUnit(
      {
        name: spec.name,
        description: spec.description,
        execStart: [spec.binary, ...spec.args].join(' '),
        restart: 'always',
        user: 'corami',
      },
      'system',
    );

    expect(unit).toContain('User=corami');
    expect(unit).toContain('ExecStart=/usr/local/bin/corami git watch');
    expect(unit).toContain('Restart=always');
  });
});

describe('json round trip through the daemon payload', () => {
  test('keeps every field of the state', () => {
    const original = state({ operation: 'merge', staged: true, dirtyChanges: 3 });
    const parsed = parseGitState(JSON.parse(JSON.stringify(gitStateJson(original))) as unknown);

    expect(parsed).toEqual(original);
    expect(gitStateJson(original).commit).toBe(original.commit);
    expect(gitStateJson(original).dirty_changes).toBe(3);
  });
});

describe('service paths', () => {
  test('scheduled task escapes arguments', () => {
    expect(renderScheduledTask(gitWatchSpec('/opt/corami & co/corami'))).toContain(
      '<Command>/opt/corami &amp; co/corami</Command>',
    );
  });
});

describe('launchd state', () => {
  test('an agent that runs has its process', () => {
    const state = parseLaunchdPrint(
      [
        'gui/501/dev.corami.git-watch = {',
        '\tactive count = 1',
        '\tpath = /Users/me/Library/LaunchAgents/dev.corami.git-watch.plist',
        '\ttype = LaunchAgent',
        '\tstate = running',
        '',
        '\tprogram = /Users/me/.corami/bin/corami',
        '\tpid = 4242',
        '',
        '\tjob state = running',
        '}',
      ].join('\n'),
    );

    expect(state).toEqual({ loaded: true, running: true, pid: 4242, exitCode: undefined });
    expect(describeLaunchdState(state)).toBe('running');
  });

  test('an agent that cannot start is loaded and stopped', () => {
    const state = parseLaunchdPrint(
      [
        'gui/501/dev.corami.git-watch = {',
        '\tactive count = 0',
        '\tstate = spawn scheduled',
        '\truns = 1646',
        '\tlast exit code = 78: EX_CONFIG',
        '',
        '\tjob state = spawn failed',
        '}',
      ].join('\n'),
    );

    expect(state.loaded).toBe(true);
    expect(state.running).toBe(false);
    expect(state.exitCode).toBe(78);
    expect(describeLaunchdState(state)).toContain('78');
    expect(describeLaunchdState(state)).toContain('launch constraint');
  });

  test('an agent stopped by a signal says the signal', () => {
    const state = parseLaunchdPrint(
      ['\tstate = spawn scheduled', '\tlast exit code = -15', '\tjob state = not running'].join(
        '\n',
      ),
    );

    expect(state.running).toBe(false);
    expect(state.exitCode).toBe(-15);
    expect(describeLaunchdState(state)).toBe('stopped by signal 15');
  });

  test('an agent that is loaded without an exit code is not running', () => {
    const state = parseLaunchdPrint('\tstate = spawn scheduled\n\tjob state = not running');
    expect(state.running).toBe(false);
    expect(describeLaunchdState(state)).toBe('loaded, not running');
  });

  test('an agent that launchd does not know is absent', () => {
    const state = parseLaunchdPrint(
      'Could not find service "dev.corami.git-watch" in domain for user',
    );

    expect(state.loaded).toBe(false);
    expect(state.running).toBe(false);
    expect(describeLaunchdState(state)).toBe('not loaded');
  });
});
