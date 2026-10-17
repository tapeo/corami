import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { classifyPath } from '@/core/local-copy.ts';

export interface LastChange {
  path: string;
  modifiedAt: number;
}

export function lastChange(root: string): LastChange | undefined {
  let newest: LastChange | undefined;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === undefined) {
      break;
    }

    let entries: string[];

    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry);
      let stats: ReturnType<typeof lstatSync>;

      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        const path = sep === '/' ? relative(root, full) : relative(root, full).split(sep).join('/');

        if (classifyPath(path) !== 'regenerable') {
          stack.push(full);
        }

        continue;
      }

      if (newest === undefined || stats.mtimeMs > newest.modifiedAt) {
        newest = { path: relative(root, full), modifiedAt: stats.mtimeMs };
      }
    }
  }

  return newest;
}
