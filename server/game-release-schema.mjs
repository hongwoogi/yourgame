import { ApiError } from './errors.mjs';

export const GAME_RELEASE_SCHEMA_VERSION = 1;
export const GAME_RELEASE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS game_release_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS game_release_reviews (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    operator_id TEXT NOT NULL,
    authorization_ref TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES development_runs(id),
    candidate_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    assets_digest TEXT NOT NULL,
    game_version TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    runtime_digest TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    run_revision INTEGER NOT NULL CHECK(run_revision > 0),
    service_revision INTEGER NOT NULL CHECK(service_revision > 0),
    round_id TEXT NOT NULL CHECK(round_id IN ('initial', 'pending')),
    bindings_digest TEXT NOT NULL,
    release_digest TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    audit_id TEXT NOT NULL UNIQUE REFERENCES admin_audit(id),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS game_release_reviews_no_update BEFORE UPDATE ON game_release_reviews
    BEGIN SELECT RAISE(ABORT, 'game release reviews are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS game_release_reviews_no_delete BEFORE DELETE ON game_release_reviews
    BEGIN SELECT RAISE(ABORT, 'game release reviews are immutable'); END`,
  `INSERT INTO game_release_meta(key,value) VALUES ('schema_version',1) ON CONFLICT(key) DO NOTHING`,
];

export async function checkGameReleaseSchema(client) {
  try {
    const result = await client.execute(`SELECT value,
      (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN
        ('game_release_reviews_no_update','game_release_reviews_no_delete')) AS guards
      FROM game_release_meta WHERE key='schema_version'`);
    if (Number(result.rows[0]?.value) !== GAME_RELEASE_SCHEMA_VERSION || Number(result.rows[0]?.guards) !== 2) throw new Error();
    await client.execute('SELECT id, payload_digest, release_digest, bindings_digest, audit_id FROM game_release_reviews LIMIT 0');
  } catch {
    throw new ApiError(409, 'RELEASE_REVIEW_UNAVAILABLE', '게임 산출물 검토 기록을 확인할 수 없습니다.');
  }
}

// Explicit, additive preparation only. Never initialize or replace user data.
export async function prepareGameReleaseSchema(client, { expectedServiceRevision } = {}) {
  if (!Number.isSafeInteger(expectedServiceRevision) || expectedServiceRevision < 1) {
    throw new ApiError(422, 'INVALID_RELEASE_REVIEW', '운영 revision을 확인해 주세요.');
  }
  const tx = await client.transaction('write');
  try {
    const service = (await tx.execute('SELECT * FROM service_control WHERE id=1')).rows[0];
    if (!service || service.mode !== 'active' || Number(service.development_enabled) !== 1
      || Number(service.revision) !== expectedServiceRevision) {
      throw new ApiError(409, 'WORKER_BLOCKED', '현재 운영 상태에서는 검토 저장소를 준비할 수 없습니다.');
    }
    for (const statement of GAME_RELEASE_SCHEMA) await tx.execute(statement);
    await checkGameReleaseSchema(tx);
    await tx.commit();
    return { prepared: true, schemaVersion: GAME_RELEASE_SCHEMA_VERSION, serviceRevision: expectedServiceRevision, pointsIssued: false };
  } catch (error) {
    try { await tx.rollback(); } catch { /* An uncertain commit must be inspected, not automatically retried. */ }
    throw error;
  } finally { tx.close(); }
}
