// The vault index's tables. Each entry is one step, applied once, in order, and counted in
// PRAGMA user_version: add a step at the end, never change one that has shipped.
//
// The database is a cache of what the vault's files say, so a step may also drop everything and
// let the next scan read the vault again.

type Db = { exec(sql: string): unknown };

export const MIGRATIONS: ((db: Db) => void)[] = [
  (db) => db.exec(`
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    -- Every file in the vault. name is the name key links are looked up by (lowercase file name,
    -- notes without ".md").
    CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE INDEX files_name ON files(name);
    -- The notes among them (same id), with the file's size and time when it was read. aliases and
    -- tags are JSON arrays as written; links is the note's links as JSON flat pairs, as in Note.
    CREATE TABLE notes(id INTEGER PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
      aliases TEXT NOT NULL, tags TEXT NOT NULL, links TEXT NOT NULL);
    -- For each note, the name keys its links are looked up by, once each. Links are resolved when a
    -- page asks, as in VaultIndex: this finds the notes with a link that may point at a file.
    -- (No index by note: a note's rows are found from its own links.)
    CREATE TABLE link_names(name TEXT NOT NULL, note INTEGER NOT NULL, PRIMARY KEY(name, note)) WITHOUT ROWID;
    -- Lookup keys per note: 0 alias, 1 tag (with its parent tags), 2 the matcher's keys.
    CREATE TABLE note_keys(kind INTEGER NOT NULL, key TEXT NOT NULL, note INTEGER NOT NULL,
      PRIMARY KEY(kind, key, note)) WITHOUT ROWID;
    CREATE INDEX note_keys_note ON note_keys(note);
    -- Full-text index of each note's title and text. Contentless: the text stays in the vault and
    -- is read from there for the lines shown, so the database holds only the index.
    CREATE VIRTUAL TABLE note_fts USING fts5(title, body, content='', contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2');
    INSERT INTO note_fts(note_fts, rank) VALUES('rank', 'bm25(10.0, 1.0)');
  `),
];

export function migrate(db: Db & { selectValue(sql: string): unknown }) {
  const at = Number(db.selectValue('PRAGMA user_version'));
  for (let v = at; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
