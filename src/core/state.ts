import { Database } from 'bun:sqlite';

import { paths } from '@/core/config.ts';
import type { PreviewRow } from '@/core/previews.ts';

export interface ProjectRow {
  name: string;
  path: string;
  repo_url: string | null;
  created_at: string;
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
      created_at TEXT NOT NULL
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
}

export function listProjects(): ProjectRow[] {
  return db()
    .query<ProjectRow, []>('SELECT name, path, repo_url, created_at FROM projects ORDER BY name')
    .all();
}

export function getProject(name: string): ProjectRow | undefined {
  return (
    db()
      .query<ProjectRow, [string]>(
        'SELECT name, path, repo_url, created_at FROM projects WHERE name = ?',
      )
      .get(name) ?? undefined
  );
}

export function upsertProject(row: ProjectRow): void {
  db()
    .query(
      'INSERT INTO projects (name, path, repo_url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path, repo_url = excluded.repo_url',
    )
    .run(row.name, row.path, row.repo_url, row.created_at);
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
