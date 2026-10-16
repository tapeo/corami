import { type Role, serverProjectPath } from '@/core/config.ts';

// What to run next, shown in a terminal at the end of a command so that a
// first run leads from one step to the following one. The JSON output does
// not carry them.

const IMPORT = 'corami project import <folder>';
const ADD = 'corami project add <git-url>';

export interface ServerSetupFacts {
  fqdn: string;
  /** The account that owns the projects. */
  user: string;
  /** The setup ran as root, not as the account. */
  root: boolean;
}

export function afterServerSetup(facts: ServerSetupFacts): string[] {
  const steps = [
    `On your laptop, install Corami and answer client, or run there: corami setup client ${facts.fqdn}`,
    `Add a project: ${IMPORT} from the laptop, or ${ADD}`,
  ];

  return facts.root && facts.user !== 'root'
    ? [`Work as ${facts.user} from now on: ssh ${facts.user}@${facts.fqdn}`, ...steps]
    : steps;
}

/**
 * `projects` are the names on the server, undefined when the daemon did not
 * answer.
 */
export function afterClientSetup(projects: string[] | undefined): string[] {
  if (projects === undefined) {
    return ['corami sync <project> to get the code of a project on this machine'];
  }

  if (projects.length === 0) {
    return [
      `Move a project of this machine to the server: ${IMPORT}`,
      `Or clone one on the server: ${ADD}, then corami sync <name>`,
    ];
  }

  return projects.map((name) => `corami sync ${name}`);
}

export function afterProjectAdd(name: string, role: Role | undefined): string[] {
  const preview = `On the server: corami serve <port> from ${serverProjectPath('~', name)} to give a preview an address`;

  return role === 'client'
    ? [`corami sync ${name} to get the code on this machine`, preview]
    : [`On each client: corami sync ${name}`, preview];
}

export function afterSync(name: string, local: string): string[] {
  return [
    `Open ${local}: every save reaches the server within seconds`,
    `On the server: corami serve <port> from ${serverProjectPath('~', name)} to give a preview an address`,
  ];
}

export function afterImport(name: string): string[] {
  return [
    `On the server: corami serve <port> from ${serverProjectPath('~', name)} to give a preview an address`,
  ];
}

/** The way in for `corami` without a command, from the role of this machine. */
export function firstSteps(role: Role | undefined): string[] {
  if (role === 'server') {
    return [`${ADD}, or ${IMPORT} from a client`, 'corami serve <port> from a project folder'];
  }

  if (role === 'client') {
    return [
      'corami sync <project> to get the code of a project',
      `${IMPORT} to move a project of this machine to the server`,
    ];
  }

  return ['corami setup to make this machine the server or a client'];
}
