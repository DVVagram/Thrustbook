import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';

/**
 * The product was previously shipped as “Rocket Lab”. Its user data lived in
 * %APPDATA%/Rocket Lab. Copy that profile once into the new application data
 * folder, preserving projects, datasets and documents, and rewrite the absolute
 * paths stored inside the database so imported recordings keep working.
 *
 * The legacy folder is left untouched as a safety copy.
 */
const LEGACY_FOLDER = 'Rocket Lab';

const PATH_COLUMNS: [string, string][] = [
  ['datasets', 'stored_dir'],
  ['datasets', 'original_file'],
  ['documents', 'stored_path'],
  ['reports', 'html_path'],
  ['reports', 'pdf_path'],
  ['config_snapshots', 'file_path'],
];

function rewriteStoredPaths(dbPath: string, fromRoot: string, toRoot: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const [table, column] of PATH_COLUMNS) {
      try {
        db.prepare(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?)`).run(fromRoot, toRoot);
      } catch {
        /* table or column may not exist in an older schema */
      }
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }
}

export function migrateLegacyUserData(): void {
  try {
    const legacy = path.join(app.getPath('appData'), LEGACY_FOLDER);
    const current = app.getPath('userData');
    if (path.resolve(legacy) === path.resolve(current)) return;
    if (!fs.existsSync(legacy)) return;

    // Chromium creates the profile folder (cache, cookies) before the app is ready,
    // so only a database or storage pointer counts as an existing user profile.
    const alreadyMigrated =
      fs.existsSync(path.join(current, 'storage.json')) || fs.existsSync(path.join(current, 'data', 'rocketlab.db'));
    if (alreadyMigrated) return;

    fs.mkdirSync(current, { recursive: true });
    let copiedData = false;
    for (const name of ['data', 'storage.json', 'window-state.json']) {
      const source = path.join(legacy, name);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(current, name), { recursive: true, force: false, errorOnExist: false });
      if (name === 'data') copiedData = true;
    }

    // A custom storage pointer is copied as-is; its data stays where it already is.
    const customStorage = fs.existsSync(path.join(current, 'storage.json'));
    if (copiedData && !customStorage) {
      const dbPath = path.join(current, 'data', 'rocketlab.db');
      if (fs.existsSync(dbPath)) rewriteStoredPaths(dbPath, legacy, current);
    }

    console.log(`Migrated user data from ${legacy} to ${current}`);
  } catch (err) {
    console.error('Legacy user data migration failed; starting with a fresh profile', err);
  }
}
