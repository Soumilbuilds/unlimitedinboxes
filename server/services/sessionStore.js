import session from 'express-session';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SQLiteSessionStore extends session.Store {
  constructor(db, { ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.operationsUntilCleanup = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        sid TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at
        ON app_sessions(expires_at);
    `);
    this.readStatement = this.db.prepare(
      'SELECT session_json, expires_at FROM app_sessions WHERE sid = ?'
    );
    this.writeStatement = this.db.prepare(`
      INSERT INTO app_sessions (sid, session_json, expires_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sid) DO UPDATE SET
        session_json = excluded.session_json,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `);
    this.touchStatement = this.db.prepare(`
      UPDATE app_sessions
      SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE sid = ?
    `);
    this.deleteStatement = this.db.prepare('DELETE FROM app_sessions WHERE sid = ?');
    this.cleanupStatement = this.db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?');
  }

  expirationFor(value) {
    const cookieExpiration = value?.cookie?.expires
      ? new Date(value.cookie.expires).getTime()
      : NaN;
    return Number.isFinite(cookieExpiration) ? cookieExpiration : Date.now() + this.ttlMs;
  }

  cleanupOccasionally() {
    this.operationsUntilCleanup += 1;
    if (this.operationsUntilCleanup < 100) return;
    this.operationsUntilCleanup = 0;
    this.cleanupStatement.run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.readStatement.get(sid);
      if (!row) return callback(null, null);
      if (Number(row.expires_at) <= Date.now()) {
        this.deleteStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.session_json));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      this.writeStatement.run(sid, JSON.stringify(value), this.expirationFor(value));
      this.cleanupOccasionally();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      this.touchStatement.run(this.expirationFor(value), sid);
      this.cleanupOccasionally();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

export function createSessionStore(db, options) {
  return new SQLiteSessionStore(db, options);
}
