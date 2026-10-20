export interface SshdDirective {
  name: string;
  value: string;
}

export function sshdDirectives(config: string): SshdDirective[] {
  const directives: SshdDirective[] = [];

  for (const raw of config.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();

    if (line === '') {
      continue;
    }

    const [name = '', value = ''] = line.split(/\s+/, 2);

    if (name === '' || value === '') {
      continue;
    }

    directives.push({ name: name.toLowerCase(), value: value.toLowerCase() });
  }

  return directives;
}

export function sshdValue(config: string, name: string): string | undefined {
  const wanted = name.toLowerCase();

  for (const directive of sshdDirectives(config)) {
    if (directive.name === wanted) {
      return directive.value;
    }
  }

  return undefined;
}

export function sshdAcceptsPasswords(config: string): boolean {
  const password = sshdValue(config, 'PasswordAuthentication');
  const keyboard = sshdValue(config, 'KbdInteractiveAuthentication');
  const challenge = sshdValue(config, 'ChallengeResponseAuthentication');

  return password !== 'no' || (keyboard ?? challenge) !== 'no';
}

export function sshdKeysOnlyText(): string {
  return ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', ''].join('\n');
}
