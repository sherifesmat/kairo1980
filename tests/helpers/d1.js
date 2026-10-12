/* A D1-shaped database backed by node:sqlite.
   D1 is SQLite, so the store can be tested against the real schema and the
   real statements — including the conditional UPDATE that stops a double
   capture and the UNIQUE index that stops a replayed webhook. A mock would
   have proved only that the mock agrees with itself. */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Every migration, in the order wrangler would apply them, read off disk
   rather than listed here. A migration added to the folder and forgotten in
   this file would give the tests a schema production does not have — which is
   the one difference a test suite can never catch by testing harder. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  #prepared() {
    return this.db.prepare(this.sql);
  }

  async run() {
    const result = this.#prepared().run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first() {
    const row = this.#prepared().get(...this.args);
    return row === undefined ? null : row;
  }

  async all() {
    return { results: this.#prepared().all(...this.args), success: true };
  }
}

export function freshDatabase({ serviceMode = 'delivery' } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const name of MIGRATIONS) db.exec(readFileSync(MIGRATIONS_DIR + name, 'utf8'));
  // Existing delivery regression fixtures explicitly retain that mode. New pickup
  // cases select pickup; a real empty database uses config.js's current mode.
  if (serviceMode) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)')
    .run('service_mode', JSON.stringify(serviceMode));
  return {
    prepare: (sql) => new Statement(db, sql),
    // Not part of D1's surface — the tests use it to look at raw rows.
    _raw: db
  };
}
