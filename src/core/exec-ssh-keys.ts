export interface AuthorizedKeyInput {
  gateCommand: string;
  publicKey: string;
  server: string;
}

export function execComment(server: string): string {
  return `corami-exec:${server}`;
}

function keyBody(publicKey: string): string {
  const [type, body] = publicKey.trim().split(/\s+/);
  return `${type ?? ''} ${body ?? ''}`.trim();
}

function escapeOption(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function authorizedKeyLine(input: AuthorizedKeyInput): string {
  return `command="${escapeOption(input.gateCommand)}" ${keyBody(input.publicKey)} ${execComment(input.server)}`;
}

export function findExecLine(text: string, server: string): string | undefined {
  const marker = execComment(server);

  return text.split('\n').find((line) => line.trim().split(/\s+/).at(-1) === marker);
}

export function withoutExecLine(text: string, server: string): string {
  const lines = text
    .split('\n')
    .filter((line) => line.trim().split(/\s+/).at(-1) !== execComment(server));
  const joined = lines.join('\n').replace(/\n+$/, '');

  return joined === '' ? '' : `${joined}\n`;
}

export function knownHostsLine(host: string, publicKey: string): string {
  return `${host} ${keyBody(publicKey)}`;
}

export function withKnownHost(text: string, host: string, publicKey: string): string {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => line.trim().split(/\s+/)[0] !== host);

  lines.push(knownHostsLine(host, publicKey));

  return `${lines.join('\n')}\n`;
}
