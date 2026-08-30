import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { SAFETY_POLICY_VERSION } from './safety-policy.mjs';

export const SAFETY_SCHEMA_VERSION = 1;
export const SAFETY_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS safety_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS proposal_body_revisions (
    proposal_id TEXT NOT NULL REFERENCES proposals(id), body_revision INTEGER NOT NULL,
    body_hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(proposal_id, body_revision)
  )`,
  `CREATE TRIGGER IF NOT EXISTS proposal_body_revisions_no_update BEFORE UPDATE ON proposal_body_revisions
    BEGIN SELECT RAISE(ABORT, 'proposal revision history is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS proposal_body_revisions_no_delete BEFORE DELETE ON proposal_body_revisions
    BEGIN SELECT RAISE(ABORT, 'proposal revision history is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS proposal_safety_reviews (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
    body_revision INTEGER NOT NULL, body_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'held', 'blocked')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    reason TEXT NOT NULL DEFAULT '', development_brief TEXT NOT NULL DEFAULT '',
    development_brief_hash TEXT NOT NULL DEFAULT '', checklist_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(checklist_confirmed IN (0, 1)),
    reviewer_id TEXT REFERENCES users(id), reviewed_at INTEGER, created_at INTEGER NOT NULL,
    UNIQUE(proposal_id, body_revision, policy_version),
    FOREIGN KEY(proposal_id, body_revision) REFERENCES proposal_body_revisions(proposal_id, body_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS proposal_attempt_windows (
    user_id TEXT NOT NULL REFERENCES users(id), window_start INTEGER NOT NULL,
    used INTEGER NOT NULL CHECK(used > 0), expires_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, window_start)
  )`,
  'CREATE INDEX IF NOT EXISTS proposal_attempt_expiry_idx ON proposal_attempt_windows(expires_at)',
  `CREATE TABLE IF NOT EXISTS proposal_edit_cooldowns (
    user_id TEXT PRIMARY KEY REFERENCES users(id), last_edit_at INTEGER NOT NULL
  )`,
  { sql: 'INSERT INTO safety_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: ['schema_version', String(SAFETY_SCHEMA_VERSION)] },
  { sql: 'INSERT INTO safety_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: ['policy_version', SAFETY_POLICY_VERSION] },
];

export async function initializeSafetyDatabase(client) {
  await client.batch(SAFETY_SCHEMA, 'write');
  await checkSafetySchema(client);
  // Preserve the CURRENT legacy revision without inventing historical bodies
  // that the old schema did not retain. Existing records are never approved.
  for (;;) {
    const result = await client.execute(`SELECT p.* FROM proposals p WHERE NOT EXISTS
      (SELECT 1 FROM proposal_body_revisions h WHERE h.proposal_id = p.id AND h.body_revision = p.revision) LIMIT 100`);
    if (!result.rows.length) break;
    const statements = result.rows.flatMap(row => {
      const hash = createHash('sha256').update(row.body).digest('hex');
      return [
        { sql: `INSERT INTO proposal_body_revisions(proposal_id, body_revision, body_hash, body, created_at)
            SELECT id, revision, ?, body, updated_at FROM proposals WHERE id = ? AND revision = ? AND body = ?
            ON CONFLICT(proposal_id, body_revision) DO NOTHING`, args: [hash, row.id, row.revision, row.body] },
        { sql: `INSERT INTO proposal_safety_reviews(id, proposal_id, body_revision, body_hash, policy_version, status, created_at)
            SELECT ?, proposal_id, body_revision, body_hash, ?, 'pending', created_at FROM proposal_body_revisions
            WHERE proposal_id = ? AND body_revision = ? ON CONFLICT(proposal_id, body_revision, policy_version) DO NOTHING`,
          args: [randomUUID(), SAFETY_POLICY_VERSION, row.id, row.revision] },
      ];
    });
    await client.batch(statements, 'write');
  }
}

export async function checkSafetySchema(client) {
  const result = await client.execute(`SELECT
    (SELECT value FROM safety_meta WHERE key = 'schema_version') AS schema_version,
    (SELECT value FROM safety_meta WHERE key = 'policy_version') AS policy_version,
    (SELECT body_hash FROM proposal_body_revisions LIMIT 1) AS history_check,
    (SELECT revision FROM proposal_safety_reviews LIMIT 1) AS review_check,
    (SELECT used FROM proposal_attempt_windows LIMIT 1) AS attempts_check,
    (SELECT last_edit_at FROM proposal_edit_cooldowns LIMIT 1) AS edit_check`);
  if (Number(result.rows[0]?.schema_version) !== SAFETY_SCHEMA_VERSION || result.rows[0]?.policy_version !== SAFETY_POLICY_VERSION) {
    throw new ApiError(503, 'SAFETY_SCHEMA_UNAVAILABLE', '안전 검토 저장소의 준비 상태를 확인해야 합니다.');
  }
}
