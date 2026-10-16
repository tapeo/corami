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
    return ['corami sync add <project> to get the code of a project on this machine'];
  }

  if (projects.length === 0) {
    return [
      `Move a project of this machine to the server: ${IMPORT}`,
      `Or clone one on the server: ${ADD}, then corami sync add <name>`,
    ];
  }

  return projects.map((name) => `corami sync add ${name}`);
}

export interface ProjectAddFacts {
  role: Role | undefined;
  /** The local copy just created, when there is one. */
  local?: string | undefined;
  /** The folder of the project on the server, when it is not `~/projects/<name>`. */
  serverPath?: string | undefined;
}

/**
 * On a client, the copy of this machine was either created, and then it leads
 * to `afterSync`, or the output already says why it was not; on a server,
 * every client takes its copy.
 */
export function afterProjectAdd(name: string, facts: ProjectAddFacts): string[] {
  if (facts.role === 'client') {
    return facts.local === undefined ? [] : afterSync(name, facts.local, facts.serverPath);
  }

  return [`On each client: corami sync add ${name}`, previewStep(name, facts.serverPath)];
}

export function afterSync(name: string, local: string, serverPath?: string): string[] {
  return [
    `Open ${local}: every save reaches the server within seconds`,
    previewStep(name, serverPath),
  ];
}

export function afterImport(name: string, serverPath?: string): string[] {
  return [previewStep(name, serverPath)];
}

/** The preview of a project, from the folder the server keeps it in. */
function previewStep(name: string, serverPath?: string): string {
  const folder = serverPath ?? serverProjectPath('~', name);
  return `On the server: corami serve <port> from ${folder} to give a preview an address`;
}

/** The way in for `corami` without a command, from the role of this machine. */
export function firstSteps(role: Role | undefined): string[] {
  if (role === 'server') {
    return [`${ADD}, or ${IMPORT} from a client`, 'corami serve <port> from a project folder'];
  }

  if (role === 'client') {
    return [
      'corami sync add <project> to get the code of a project',
      `${IMPORT} to move a project of this machine to the server`,
    ];
  }

  return ['corami setup to make this machine the server or a client'];
}
