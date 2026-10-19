import { existsSync, renameSync, rmdirSync } from 'node:fs';

import { CoramiError } from '@/core/errors.ts';
import { isImportStagingFor } from '@/core/project-add.ts';
import { isFolderEmpty } from '@/core/projects.ts';

export function moveStagingIntoPlace(staging: string, target: string, register: () => void): void {
  if (!isImportStagingFor(target, staging)) {
    throw new CoramiError({
      code: 'usage',
      message: `The folder ${staging} is not the staging of an import into ${target}`,
      fix: 'The staging folder is next to the project and starts with .corami-import-',
    });
  }

  if (!existsSync(staging)) {
    throw new CoramiError({
      code: 'config_invalid',
      message: `The folder of the import is not on the server: ${staging}`,
      fix: 'Run the import again: it writes the folder before it registers the project',
    });
  }

  if (existsSync(target)) {
    if (!isFolderEmpty(target)) {
      throw new CoramiError({
        code: 'usage',
        message: `The folder ${target} is already on the server and is not empty`,
        fix: 'Name a free folder of the server: corami project add <folder> --server-path <folder>',
      });
    }

    rmdirSync(target);
  }

  renameSync(staging, target);

  try {
    register();
  } catch (error) {
    renameSync(target, staging);
    throw error;
  }
}
