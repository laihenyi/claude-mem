import { Database } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';
import { assertSchemaReadable, isMalformedSchemaError, repairMalformedDatabase } from './SchemaRepair.js';

const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; 
const SQLITE_CACHE_SIZE_PAGES = 10_000;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

/**
 * Opt a *brand-new* database into incremental auto-vacuum before any table
 * exists. SQLite can only switch auto_vacuum away from NONE on an empty
 * database (otherwise a full VACUUM is required), so we gate on an empty
 * sqlite_master and must run this before `PRAGMA journal_mode = WAL` and schema
 * creation — the first WAL-mode write locks in whatever mode is set here.
 *
 * Existing NONE databases are deliberately left untouched. The bloat
 * maintenance pass (maintenance.ts) reads `PRAGMA auto_vacuum` and takes the
 * cheap incremental_vacuum branch only when it reports 2. Flipping the pragma
 * on a legacy NONE database makes it *report* 2 without materializing the
 * pointer-map pages, which would turn incremental_vacuum into a no-op and
 * strand existing free pages — so leaving them at 0 preserves the correct
 * full-VACUUM reclaim path for those databases.
 *
 * Returns true when incremental mode was enabled (fresh DB), false otherwise.
 */
export function enableIncrementalAutoVacuumIfFresh(db: Database): boolean {
  const { tableCount } = db
    .query("SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table'")
    .get() as { tableCount: number };
  if (tableCount > 0) {
    return false;
  }
  db.run('PRAGMA auto_vacuum = INCREMENTAL');
  return true;
}

export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    this.db = ClaudeMemDatabase.openWithSchemaRepair(dbPath);

    enableIncrementalAutoVacuumIfFresh(this.db);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  /**
   * Opens the database, repairing it first if its on-disk `sqlite_master`
   * schema is malformed (orphaned index, dropped column, missing table).
   * A malformed schema causes the very first statement — even a PRAGMA — to
   * throw, so we probe for readability before any PRAGMA runs and rebuild via
   * SchemaRepair when necessary. Migrations restore the canonical schema after.
   */
  private static openWithSchemaRepair(dbPath: string): Database {
    let db = new Database(dbPath, { create: true, readwrite: true });

    try {
      assertSchemaReadable(db);
      return db;
    } catch (error) {
      // Close before re-throwing: a leaked open handle holds the SQLite write
      // lock and can block subsequent open attempts on the same path.
      if (!isMalformedSchemaError(error)) {
        db.close();
        throw error;
      }
    }

    db.close();
    repairMalformedDatabase(dbPath);

    db = new Database(dbPath, { create: true, readwrite: true });
    try {
      assertSchemaReadable(db);
    } catch (error) {
      // Repair ran but the rebuilt file is still unreadable — don't leak the handle.
      db.close();
      throw error;
    }
    return db;
  }

  close(): void {
    this.db.close();
  }
}

export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    enableIncrementalAutoVacuumIfFresh(this.db);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    this.initializeSchemaVersions();

    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { Database };

export { MigrationRunner } from './migrations/runner.js';

export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';
