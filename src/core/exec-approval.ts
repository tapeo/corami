import { allowPrefix, allowSubcommand, newRule, runsArbitraryCode } from '@/core/exec-rules.ts';

export const APPROVAL_WAIT_MS = 60_000;

export type ApprovalChoice = 'once' | 'subcommand' | 'always' | 'deny';

export type DialogTool = 'osascript' | 'zenity';

export interface ApprovalRequest {
  project: string;
  argv: string[];
}

export interface ApprovalOption {
  label: string;
  value: ApprovalChoice;
}

const OSASCRIPT_DIALOG = [
  "ObjC.import('AppKit');",
  'function run(argv) {',
  '  const labels = argv.slice(2);',
  '  const alert = $.NSAlert.alloc.init;',
  "  alert.setMessageText('Corami');",
  '  alert.setInformativeText(argv[0]);',
  "  labels.forEach((label) => alert.addButtonWithTitle(label).setKeyEquivalent(''));",
  '  const field = $.NSTextView.scrollableTextView;',
  '  field.setFrame($.NSMakeRect(0, 0, 360, 64));',
  '  field.documentView.setString(argv[1]);',
  '  field.documentView.setEditable(false);',
  '  alert.setAccessoryView(field);',
  '  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);',
  '  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);',
  '  return labels[alert.runModal - 1000];',
  '}',
];

const GRAPHICAL_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

export function ruleArgv(argv: string[], choice: 'subcommand' | 'always'): string[] {
  if (choice === 'subcommand') {
    return subcommandArgv(argv) ?? argv;
  }

  if (runsArbitraryCode(newRule('allow', argv, undefined))) {
    return argv;
  }

  return allowPrefix(argv);
}

export function approvalOptions(argv: string[]): ApprovalOption[] {
  const options: ApprovalOption[] = [{ label: 'Allow once', value: 'once' }];
  const subcommand = subcommandArgv(argv);

  if (subcommand !== undefined) {
    options.push({ label: `Always allow: ${subcommand.join(' ')}`, value: 'subcommand' });
  }

  options.push({ label: alwaysLabel(argv), value: 'always' }, { label: 'Deny', value: 'deny' });

  return options;
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
  if (tool === 'osascript') {
    return [
      'osascript',
      '-l',
      'JavaScript',
      '-e',
      OSASCRIPT_DIALOG.join('\n'),
      [askLine(request), ...warningLines(request.argv)].join('\n'),
      commandLine(request.argv),
      ...options.map((option) => option.label),
    ];
  }

  const extraButtons = options
    .filter((option) => option.value === 'subcommand' || option.value === 'always')
    .map((option) => `--extra-button=${option.label}`);

  return [
    'zenity',
    '--question',
    '--no-markup',
    '--default-cancel',
    '--title=Corami',
    `--text=${approvalQuestion(request).join('\n')}`,
    `--ok-label=${labelOf(options, 'once')}`,
    `--cancel-label=${labelOf(options, 'deny')}`,
    ...extraButtons,
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

function labelOf(options: ApprovalOption[], value: ApprovalChoice): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function subcommandArgv(argv: string[]): string[] | undefined {
  if (runsArbitraryCode(newRule('allow', argv, undefined))) {
    return undefined;
  }

  return allowSubcommand(argv);
}
