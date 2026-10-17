import { Database } from 'bun:sqlite';

import { paths, projectRoot } from '@/core/config.ts';
import type { PreviewRow } from '@/core/previews.ts';
import { serverFolderRemoval } from '@/core/projects.ts';

export interface ProjectRow {
  name: string;
  path: string;
  repo_url: string | null;
  created_at: string;
  /**
   * Whether Corami created the folder of the project: a clone, or the import
   * of a folder. A folder registered where it was is not ours, and a removal
   * leaves it on disk.
   */
  owned: boolean;
}

let database: Database | undefined;

export function db(): Database {
  if (database !== undefined) {
    return database;
  }

  const { state } = paths();
  database = new Database(state, { create: true });
  database.exec('PRAGMA journal_mode = WAL;');
  migrate(database);

  return database;
}

export function migrate(target: Database): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      repo_url TEXT,
      created_at TEXT NOT NULL,
      owned INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS previews (
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      public_port INTEGER NOT NULL,
      target_port INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project, name)
    );
  `);

  // A database written before `owned` existed: the column arrives with the
  // rule of the day, the folder under the projects root was one Corami made.
  const columns = target
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('projects')")
    .all();

  if (columns.some((column) => column.name === 'owned')) {
    return;
  }

  target.exec('ALTER TABLE projects ADD COLUMN owned INTEGER NOT NULL DEFAULT 1');

  const root = projectRoot();

  for (const row of target
    .query<{ name: string; path: string }, []>('SELECT name, path FROM projects')
    .all()) {
    if (serverFolderRemoval(row.path, root) === 'keep') {
      target.query('UPDATE projects SET owned = 0 WHERE name = ?').run(row.name);
    }
  }
}

export function listProjects(): ProjectRow[] {
  return db()
    .query<ProjectRow, []>(
      'SELECT name, path, repo_url, created_at, owned FROM projects ORDER BY name',
    )
    .all()
    .map(withOwnedFlag);
}

export function getProject(name: string): ProjectRow | undefined {
  const row =
    db()
      .query<ProjectRow, [string]>(
        'SELECT name, path, repo_url, created_at, owned FROM projects WHERE name = ?',
      )
      .get(name) ?? undefined;

  return row === undefined ? undefined : withOwnedFlag(row);
}

function withOwnedFlag(row: ProjectRow): ProjectRow {
  return { ...row, owned: Boolean(row.owned) };
}

export function upsertProject(row: ProjectRow): void {
  db()
    .query(
      'INSERT INTO projects (name, path, repo_url, created_at, owned) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path, repo_url = excluded.repo_url, owned = excluded.owned',
    )
    .run(row.name, row.path, row.repo_url, row.created_at, row.owned ? 1 : 0);
}

export function deleteProject(name: string): void {
  db().query('DELETE FROM projects WHERE name = ?').run(name);
  db().query('DELETE FROM previews WHERE project = ?').run(name);
}

export function listPreviews(): PreviewRow[] {
  return db()
    .query<PreviewRow, []>(
      'SELECT project, name, public_port, target_port, created_at FROM previews ORDER BY project, name',
    )
    .all();
}

export function getPreview(project: string, name: string): PreviewRow | undefined {
  return (
    db()
      .query<PreviewRow, [string, string]>(
        'SELECT project, name, public_port, target_port, created_at FROM previews WHERE project = ? AND name = ?',
      )
      .get(project, name) ?? undefined
  );
}

export function upsertPreview(row: PreviewRow): void {
  db()
    .query(
      'INSERT INTO previews (project, name, public_port, target_port, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project, name) DO UPDATE SET target_port = excluded.target_port',
    )
    .run(row.project, row.name, row.public_port, row.target_port, row.created_at);
}

export function deletePreview(project: string, name: string): void {
  db().query('DELETE FROM previews WHERE project = ? AND name = ?').run(project, name);
}
