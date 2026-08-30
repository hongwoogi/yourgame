import { createClient } from '@libsql/client';
import { ApiError } from './errors.mjs';
import { boundedFetch } from './network.mjs';

export const SCHEMA_VERSION = 1;
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    google_nonce TEXT NOT NULL,
    nonce_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS session_rate_windows (
    bucket_key TEXT PRIMARY KEY,
    used INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS session_rate_expiry_idx ON session_rate_windows(expires_at)',
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    request_body_hash TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    round_id TEXT NOT NULL CHECK (round_id IN ('initial', 'pending')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    UNIQUE(user_id, request_id)
  )`,
  'CREATE INDEX IF NOT EXISTS proposals_user_time_idx ON proposals(user_id, created_at)',
  `CREATE TRIGGER IF NOT EXISTS proposals_immutable_fields
    BEFORE UPDATE OF id, user_id, request_id, request_body_hash, created_at, round_id ON proposals
    BEGIN SELECT RAISE(ABORT, 'proposal identity and submission time are immutable'); END`,
  { sql: 'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: ['schema_version', SCHEMA_VERSION] },
];

export async function initializeDatabase(client) {
  await client.batch(SCHEMA, 'write');
  await checkSchema(client);
}

export async function checkSchema(client) {
  const result = await client.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  if (Number(result.rows[0]?.value) !== SCHEMA_VERSION) {
    throw new ApiError(503, 'SCHEMA_UNAVAILABLE', '데이터베이스 준비 상태를 확인해야 합니다.');
  }
  // Checking the actual tables catches a partial or missing migration as well.
  await client.execute(`SELECT (SELECT id FROM users LIMIT 1) AS user_check,
    (SELECT token_hash FROM sessions LIMIT 1) AS session_check,
    (SELECT bucket_key FROM session_rate_windows LIMIT 1) AS rate_check,
    (SELECT revision FROM proposals LIMIT 1) AS proposal_check`);
}

export async function openDatabase(config, { initialize = config.autoInitialize } = {}) {
  if (!config.databaseUrl) {
    throw new ApiError(503, 'DATABASE_UNCONFIGURED', '제안 저장소가 아직 연결되지 않았습니다.');
  }
  const client = createClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
    timeout: 1000, // local SQLite busy timeout only; remote clients ignore it
    fetch: boundedFetch,
  });
  try {
    if (config.databaseUrl.startsWith('file:')) await client.execute('PRAGMA foreign_keys = ON');
    const foreignKeys = await client.execute('PRAGMA foreign_keys');
    if (Number(foreignKeys.rows[0]?.foreign_keys) !== 1) {
      throw new ApiError(503, 'DATABASE_CONFIGURATION_ERROR', '데이터베이스 무결성 설정을 확인해야 합니다.');
    }
    if (initialize) await initializeDatabase(client);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function writeBatch(client, statements) {
  // A libSQL write batch is one database transaction, including in serverless
  // instances. Retry only a lock failure, never an uncertain network commit.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.batch(statements, 'write');
    } catch (error) {
      const busy = /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(String(error.code || ''));
      if (!busy || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 * (2 ** attempt) + Math.floor(Math.random() * 15)));
    }
  }
}
