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
    { label: alwaysLabel(argv), value: 'always' },
    { label: 'Deny', value: 'deny' },
  ];
}

export function approvalQuestion(request: ApprovalRequest): string[] {
  const warnings = warningLines(request.argv).map((line) => `  ${line}`);

  return [askLine(request), `  ${commandLine(request.argv)}`, ...warnings];
}

export function approvalSeconds(): number {
  return APPROVAL_WAIT_MS / 1000;
}

export function dialogCommand(
  tool: DialogTool,
  request: ApprovalRequest,
  options: ApprovalOption[],
): string[] {
  const [once, always, deny] = labelsOf(options);

  if (tool === 'osascript') {
    return [
      'osascript',
      '-e',
      'on run argv',
      '-e',
      'return button returned of (display dialog (item 1 of argv) default answer (item 2 of argv) with title "Corami" buttons {item 3 of argv, item 4 of argv, item 5 of argv} default button (item 5 of argv))',
      '-e',
      'end run',
      [askLine(request), ...warningLines(request.argv)].join('\n'),
      commandLine(request.argv),
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
    `--text=${approvalQuestion(request).join('\n')}`,
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
  if (exitCode !== 0) {
    return undefined;
  }

  const label = stdout.trim();

  return options.find((option) => option.label === label)?.value;
}

function alwaysLabel(argv: string[]): string {
  if (runsArbitraryCode(newRule('allow', argv, undefined))) {
    return 'Always allow this command';
  }

  return `Always allow: ${allowPrefix(argv).join(' ')}`;
}

function askLine(request: ApprovalRequest): string {
  return `The server asks to run, in ${request.project}:`;
}

function commandLine(argv: string[]): string {
  return argv.join(' ').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function warningLines(argv: string[]): string[] {
  if (!runsArbitraryCode(newRule('allow', argv, undefined))) {
    return [];
  }

  return [
    `${argv[0] ?? ''} runs code of the project or of the network: "Always allow" allows whatever this command runs.`,
  ];
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
