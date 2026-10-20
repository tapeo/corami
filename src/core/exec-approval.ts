import { allowPrefix, newRule, runsArbitraryCode } from '@/core/exec-rules.ts';

export const APPROVAL_WAIT_MS = 60_000;

export type ApprovalChoice = 'once' | 'always' | 'deny';

export type DialogTool = 'osascript' | 'zenity';

export interface ApprovalRequest {
  project: string;
  argv: string[];
}

export interface ApprovalOption {
  label: string;
  value: ApprovalChoice;
}

const GRAPHICAL_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

export function alwaysArgv(argv: string[]): string[] {
  if (runsArbitraryCode(newRule('allow', argv, undefined))) {
    return argv;
  }

  return allowPrefix(argv);
}

export function approvalOptions(argv: string[]): ApprovalOption[] {
  return [
    { label: 'Allow once', value: 'once' },
    { label: `Always allow: ${alwaysArgv(argv).join(' ')}`, value: 'always' },
    { label: 'Deny', value: 'deny' },
  ];
}

export function approvalQuestion(request: ApprovalRequest): string[] {
  const lines = [`The server asks to run, in ${request.project}:`, `  ${request.argv.join(' ')}`];

  if (runsArbitraryCode(newRule('allow', request.argv, request.project))) {
    lines.push(
      `  ${request.argv[0] ?? ''} runs code of the project or of the network: "Always allow" allows whatever this command runs.`,
    );
  }

  return lines;
}

export function approvalSeconds(): number {
  return APPROVAL_WAIT_MS / 1000;
}

export function dialogCommand(tool: DialogTool, text: string, options: ApprovalOption[]): string[] {
  const [once, always, deny] = labelsOf(options);

  if (tool === 'osascript') {
    return [
      'osascript',
      '-e',
      'on run argv',
      '-e',
      'display dialog (item 1 of argv) with title "Corami" buttons {item 2 of argv, item 3 of argv, item 4 of argv} default button (item 4 of argv)',
      '-e',
      'end run',
      text,
      deny,
      always,
      once,
    ];
  }

  return [
    'zenity',
    '--question',
    '--no-markup',
    '--title=Corami',
    `--text=${text}`,
    `--ok-label=${once}`,
    `--cancel-label=${deny}`,
    `--extra-button=${always}`,
  ];
}

export function dialogChoice(
  tool: DialogTool,
  exitCode: number,
  stdout: string,
  options: ApprovalOption[],
): ApprovalChoice | undefined {
  if (tool === 'osascript') {
    return osascriptChoice(exitCode, stdout, options);
  }

  return zenityChoice(exitCode, stdout, options);
}

export function graphicalEnv(environment: string): Record<string, string> {
  const found: Record<string, string> = {};

  for (const line of environment.split('\n')) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);

    if (separator > 0 && GRAPHICAL_KEYS.includes(key)) {
      found[key] = line.slice(separator + 1);
    }
  }

  return found;
}

export function hasDisplay(environment: Record<string, string | undefined>): boolean {
  return Boolean(environment.DISPLAY) || Boolean(environment.WAYLAND_DISPLAY);
}

function osascriptChoice(
  exitCode: number,
  stdout: string,
  options: ApprovalOption[],
): ApprovalChoice | undefined {
  const prefix = 'button returned:';
  const output = stdout.trim();

  if (exitCode !== 0 || !output.startsWith(prefix)) {
    return undefined;
  }

  const label = output.slice(prefix.length);

  return options.find((option) => option.label === label)?.value;
}

function zenityChoice(
  exitCode: number,
  stdout: string,
  options: ApprovalOption[],
): ApprovalChoice | undefined {
  if (exitCode === 0) {
    return 'once';
  }

  if (exitCode !== 1) {
    return undefined;
  }

  const extra = stdout.trim();

  if (extra === '') {
    return 'deny';
  }

  return options.find((option) => option.label === extra)?.value;
}

function labelsOf(options: ApprovalOption[]): [string, string, string] {
  const label = (value: ApprovalChoice) =>
    options.find((option) => option.value === value)?.label ?? value;

  return [label('once'), label('always'), label('deny')];
}
