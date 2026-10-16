export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  values: Record<string, FlagValue>;
  positionals: string[];
}

export interface ParseOptions {
  valueFlags?: readonly string[];
}

const SHORT_ALIASES: Record<string, string> = {
  h: 'help',
  v: 'version',
  j: 'json',
  y: 'yes',
  f: 'force',
  p: 'path',
};

function appendValue(values: Record<string, FlagValue>, key: string, value: string): void {
  const current = values[key];

  if (typeof current === 'string') {
    values[key] = [current, value];
    return;
  }

  if (Array.isArray(current)) {
    current.push(value);
    return;
  }

  values[key] = value;
}

function setBoolean(values: Record<string, FlagValue>, key: string, value: boolean): void {
  values[key] = value;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const values: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? '';

    // After `--` every word is an argument, also one that starts with `-`.
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals > 0) {
        appendValue(values, body.slice(0, equals), body.slice(equals + 1));
        index += 1;
        continue;
      }

      if (body.startsWith('no-')) {
        setBoolean(values, body.slice(3), false);
        index += 1;
        continue;
      }

      const next = argv[index + 1];

      if (valueFlags.has(body) && next !== undefined && !next.startsWith('-')) {
        appendValue(values, body, next);
        index += 2;
        continue;
      }

      setBoolean(values, body, true);
      index += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const letters = token.slice(1);
      const last = letters.at(-1) ?? '';
      const next = argv[index + 1];

      for (const letter of letters.slice(0, -1)) {
        setBoolean(values, SHORT_ALIASES[letter] ?? letter, true);
      }

      // Only the last letter of a group can take a value, as in `-yp folder`.
      const name = SHORT_ALIASES[last] ?? last;

      if (valueFlags.has(name) && next !== undefined && !next.startsWith('-')) {
        appendValue(values, name, next);
        index += 2;
        continue;
      }

      setBoolean(values, name, true);
      index += 1;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  return { values, positionals };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];

  if (value === undefined || typeof value === 'boolean') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.at(-1);
  }

  return value;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  const value = args.values[name];

  if (value === true) {
    return true;
  }

  if (typeof value === 'string') {
    return value !== 'false' && value !== '0';
  }

  return false;
}

export function stringListFlag(args: ParsedArgs, name: string): string[] {
  const value = args.values[name];

  if (value === undefined || typeof value === 'boolean') {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return [value];
}

export function negatedFlag(args: ParsedArgs, name: string): boolean {
  return args.values[name] === false;
}
