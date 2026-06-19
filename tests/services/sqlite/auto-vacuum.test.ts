import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableIncrementalAutoVacuumIfFresh } from '../../../src/services/sqlite/Database.js';

const AUTO_VACUUM_NONE = 0;
const AUTO_VACUUM_INCREMENTAL = 2;

function autoVacuumMode(db: Database): number {
  return (db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
}

describe('enableIncrementalAutoVacuumIfFresh', () => {
  let tempDir: string;
  let db: Database | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-autovac-'));
  });

  afterEach(() => {
    db?.close();
    db = null;
    try {
      rmSync(tempDir, { force: true, recursive: true });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EBUSY')) {
        throw error;
      }
    }
  });

  function createFileDb(name: string): Database {
    return new Database(join(tempDir, name), { create: true, readwrite: true });
  }

  it('enables INCREMENTAL on a brand-new database and persists it through schema creation', () => {
    db = createFileDb('fresh.sqlite');
    expect(autoVacuumMode(db)).toBe(AUTO_VACUUM_NONE);

    const enabled = enableIncrementalAutoVacuumIfFresh(db);
    expect(enabled).toBe(true);

    // The first WAL-mode write locks in the mode; subsequent table creation
    // must not drop it back to NONE.
    db.run('PRAGMA journal_mode = WAL');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(autoVacuumMode(db)).toBe(AUTO_VACUUM_INCREMENTAL);
  });

  it('leaves an existing NONE database untouched so full-VACUUM reclaim stays correct', () => {
    db = createFileDb('legacy.sqlite');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(autoVacuumMode(db)).toBe(AUTO_VACUUM_NONE);

    const enabled = enableIncrementalAutoVacuumIfFresh(db);
    expect(enabled).toBe(false);
    expect(autoVacuumMode(db)).toBe(AUTO_VACUUM_NONE);
  });

  it('actually returns free pages to the OS via incremental_vacuum once enabled', () => {
    db = createFileDb('reclaim.sqlite');
    enableIncrementalAutoVacuumIfFresh(db);
    db.run('PRAGMA journal_mode = WAL');
    db.run('CREATE TABLE blob_rows (id INTEGER PRIMARY KEY, payload BLOB)');

    const insert = db.prepare('INSERT INTO blob_rows (payload) VALUES (?)');
    for (let i = 0; i < 2000; i++) {
      insert.run(Buffer.alloc(4096, 1));
    }
    db.run('DELETE FROM blob_rows');
    db.run('PRAGMA wal_checkpoint(PASSIVE)');

    const freelistBefore = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
    expect(freelistBefore).toBeGreaterThan(0);

    db.run(`PRAGMA incremental_vacuum(${freelistBefore})`);

    const freelistAfter = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
    expect(freelistAfter).toBe(0);
  });
});
