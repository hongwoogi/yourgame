import { ApiError } from './errors.mjs';

export const ADMIN_SCHEMA_VERSION = 1;
export const ADMIN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_access (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at INTEGER NOT NULL
  )`,
  `INSERT INTO member_access(user_id, updated_at)
    SELECT id, updated_at FROM users WHERE true ON CONFLICT(user_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS session_auth (
    token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
    email TEXT,
    email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
    authenticated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    google_sub TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS admin_identity_no_update BEFORE UPDATE ON admin_identity
    BEGIN SELECT RAISE(ABORT, 'administrator identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS admin_identity_no_delete BEFORE DELETE ON admin_identity
    BEGIN SELECT RAISE(ABORT, 'administrator identity is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS service_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('active', 'maintenance', 'ended')),
    proposals_enabled INTEGER NOT NULL CHECK (proposals_enabled IN (0, 1)),
    development_enabled INTEGER NOT NULL CHECK (development_enabled IN (0, 1)),
    message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at INTEGER NOT NULL,
    CHECK (mode != 'ended' OR (proposals_enabled = 0 AND development_enabled = 0))
  )`,
  `INSERT INTO service_control(id, mode, proposals_enabled, development_enabled, updated_at)
    VALUES (1, 'active', 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS proposal_moderation (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
    moderation TEXT NOT NULL DEFAULT 'pending' CHECK (moderation IN ('pending', 'reviewed', 'excluded')),
    reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS development_runs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    parent_id TEXT REFERENCES development_runs(id),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    commit_sha TEXT,
    worker_id TEXT,
    created_by TEXT REFERENCES users(id)
  )`,
  'CREATE INDEX IF NOT EXISTS development_runs_time_idx ON development_runs(created_at DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    actor_user_id TEXT REFERENCES users(id),
    actor_name TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS admin_audit_time_idx ON admin_audit(created_at DESC, id DESC)',
  `CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit
    BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit
    BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END`,
  `CREATE TABLE IF NOT EXISTS admin_requests (
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(actor_user_id, request_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS admin_requests_no_update BEFORE UPDATE ON admin_requests
    BEGIN SELECT RAISE(ABORT, 'request records are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS admin_requests_no_delete BEFORE DELETE ON admin_requests
    BEGIN SELECT RAISE(ABORT, 'request records are immutable'); END`,
  { sql: 'INSERT INTO admin_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: ['schema_version', ADMIN_SCHEMA_VERSION] },
];

export async function initializeAdminDatabase(client) {
  // Additive only: old application instances continue to see base schema v1.
  await client.batch(ADMIN_SCHEMA, 'write');
  await checkAdminSchema(client);
}

export async function checkAdminSchema(client) {
  const result = await client.execute("SELECT value FROM admin_meta WHERE key = 'schema_version'");
  if (Number(result.rows[0]?.value) !== ADMIN_SCHEMA_VERSION) {
    throw new ApiError(503, 'ADMIN_SCHEMA_UNAVAILABLE', '운영 상태 저장소를 확인해야 합니다.');
  }
  const tables = await client.execute(`SELECT
    (SELECT mode FROM service_control WHERE id = 1) AS service_mode,
    (SELECT user_id FROM member_access LIMIT 1) AS member_check,
    (SELECT token_hash FROM session_auth LIMIT 1) AS auth_check,
    (SELECT user_id FROM admin_identity LIMIT 1) AS admin_check,
    (SELECT revision FROM proposal_moderation LIMIT 1) AS moderation_check,
    (SELECT revision FROM development_runs LIMIT 1) AS run_check,
    (SELECT id FROM admin_audit LIMIT 1) AS audit_check,
    (SELECT request_id FROM admin_requests LIMIT 1) AS request_check`);
  if (!['active', 'maintenance', 'ended'].includes(tables.rows[0]?.service_mode)) {
    throw new ApiError(503, 'ADMIN_SCHEMA_UNAVAILABLE', '운영 상태 저장소를 확인해야 합니다.');
  }
}
