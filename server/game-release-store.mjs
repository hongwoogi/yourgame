// Trusted local operator infrastructure. Do not expose issueReview through an
// HTTP action or give its database client to a generation role. The issuer must
// first perform semantic review and real tests of the bound bytes; this store
// authenticates that trusted decision, not the truth of caller-written booleans.
import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { SAFETY_POLICY_VERSION } from './safety-policy.mjs';
import { approvedSafetySql, safetyBindingsSql } from './safety-store.mjs';
import { checkGameReleaseSchema } from './game-release-schema.mjs';

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const validId = value => typeof value === 'string' && ID.test(value);
const validHash = value => typeof value === 'string' && HASH.test(value);
const invalid = () => new ApiError(422, 'INVALID_RELEASE_REVIEW', '검토 기록 입력을 확인해 주세요.');
const unavailable = () => new ApiError(409, 'RELEASE_REVIEW_UNAVAILABLE', '정확한 게임 산출물 검토 기록이 필요합니다.');
export const RELEASE_BINDING_KEYS = ['candidateId', 'policyVersion', 'snapshotDigest', 'sourceDigest', 'assetsDigest',
  'gameVersion', 'contentSha256', 'runtimeDigest', 'evidenceDigest'];
const BINDING_KEYS = ['id', 'revision', 'bodyHash', 'policyVersion', 'safetyReviewId', 'safetyRevision', 'developmentBriefHash'];
const REVIEW_KEYS = ['id', 'requestId', 'operatorId', 'authorizationRef', 'runId', ...RELEASE_BINDING_KEYS,
  'workerId', 'runRevision', 'serviceRevision', 'roundId', 'bindings'];
const COLUMN_KEYS = ['candidate_id', 'policy_version', 'snapshot_digest', 'source_digest', 'assets_digest',
  'game_version', 'content_sha256', 'runtime_digest', 'evidence_digest'];

export function releaseBindingDigest(binding) {
  if (!exact(binding, RELEASE_BINDING_KEYS) || !validId(binding.candidateId)
    || typeof binding.gameVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(binding.gameVersion)
    || binding.policyVersion !== SAFETY_POLICY_VERSION
    || RELEASE_BINDING_KEYS.filter(key => !['candidateId', 'policyVersion', 'gameVersion'].includes(key)).some(key => !validHash(binding[key]))) {
    throw unavailable();
  }
  return digest(binding);
}

export function releaseInputDigest(bindings) {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100000) throw unavailable();
  const seen = new Set();
  for (const binding of bindings) {
    if (!exact(binding, BINDING_KEYS) || !validId(binding.id) || !validId(binding.safetyReviewId)
      || seen.has(binding.id) || !positive(binding.revision) || !positive(binding.safetyRevision)
      || binding.policyVersion !== SAFETY_POLICY_VERSION
      || !['bodyHash', 'developmentBriefHash'].every(key => validHash(binding[key]))) throw unavailable();
    seen.add(binding.id);
  }
  return digest(bindings);
}

const rowBinding = row => Object.fromEntries(RELEASE_BINDING_KEYS.map((key, i) => [key, row[COLUMN_KEYS[i]]]));
const receiptView = row => ({ reviewId: row.id, runId: row.run_id, releaseBinding: rowBinding(row),
  workerId: row.worker_id, runRevision: Number(row.run_revision), serviceRevision: Number(row.service_revision),
  roundId: row.round_id, bindingsDigest: row.bindings_digest, gamePublished: false, pointsIssued: false });

// Includes the immutable operator audit; possession of a local receipt JSON or
// a caller's approved:true field cannot satisfy this query.
export const RELEASE_RECEIPT_SQL = `SELECT r.* FROM game_release_reviews r JOIN admin_audit a ON a.id=r.audit_id
  WHERE a.action='operator_review_game_release' AND a.target_id=r.run_id AND a.actor_user_id IS NULL
    AND a.actor_name=('codex-delegated:' || r.operator_id) AND a.reason=r.payload_digest`;

export async function verifyReleaseReview(client, expected) {
  const required = ['reviewId', 'runId', 'snapshotDigest', 'sourceDigest', 'assetsDigest'];
  if (!expected || typeof expected !== 'object' || !required.every(key => Object.hasOwn(expected, key))
    || Object.keys(expected).some(key => ![...required, ...RELEASE_BINDING_KEYS].includes(key))
    || !validId(expected.reviewId) || !validId(expected.runId)
    || !['snapshotDigest', 'sourceDigest', 'assetsDigest'].every(key => validHash(expected[key]))) throw unavailable();
  await checkGameReleaseSchema(client);
  const row = (await client.execute({ sql: `${RELEASE_RECEIPT_SQL} AND r.id=? AND r.run_id=?`,
    args: [expected.reviewId, expected.runId] })).rows[0];
  if (!row || row.policy_version !== SAFETY_POLICY_VERSION) throw unavailable();
  const binding = rowBinding(row);
  if (releaseBindingDigest(binding) !== row.release_digest
    || RELEASE_BINDING_KEYS.some(key => Object.hasOwn(expected, key) && expected[key] !== binding[key])) throw unavailable();
  return receiptView(row);
}

export function createGameReleaseStore(client, { databaseClockSql = DATABASE_NOW_SQL } = {}) {
  async function issueReview(review) {
    if (!exact(review, REVIEW_KEYS) || !['id', 'requestId', 'operatorId', 'runId', 'workerId'].every(key => validId(review[key]))
      || typeof review.authorizationRef !== 'string' || !/^[A-Za-z0-9_:-]{8,100}$/.test(review.authorizationRef)
      || !['runRevision', 'serviceRevision'].every(key => positive(review[key]))
      || !['initial', 'pending'].includes(review.roundId)) throw invalid();
    const releaseBinding = Object.fromEntries(RELEASE_BINDING_KEYS.map(key => [key, review[key]]));
    const releaseDigest = releaseBindingDigest(releaseBinding);
    const bindingsDigest = releaseInputDigest(review.bindings);
    const payloadDigest = digest(review);
    const tx = await client.transaction('write');
    try {
      await checkGameReleaseSchema(tx);
      // Exact replay reports the already-issued historical receipt, even if the
      // run later ended. Replays do not authorize release; current gates still apply.
      const existing = (await tx.execute({ sql: 'SELECT * FROM game_release_reviews WHERE id=? OR request_id=?',
        args: [review.id, review.requestId] })).rows;
      if (existing.length) {
        if (existing.length !== 1 || existing[0].id !== review.id || existing[0].request_id !== review.requestId
          || existing[0].payload_digest !== payloadDigest) throw new ApiError(409, 'RELEASE_REVIEW_CONFLICT', '검토 재시도 내용이 기존 기록과 다릅니다.');
        const receipt = await verifyReleaseReview(tx, { reviewId: review.id, runId: review.runId, ...releaseBinding });
        await tx.commit();
        return { ...receipt, replayed: true };
      }
      const current = (await tx.execute({ sql: `SELECT s.mode,s.development_enabled,s.revision AS service_revision,
        r.status,r.cancel_requested,r.worker_id,r.revision AS run_revision FROM service_control s
        JOIN development_runs r ON r.id=? WHERE s.id=1`, args: [review.runId] })).rows[0];
      if (!current || current.mode !== 'active' || Number(current.development_enabled) !== 1
        || Number(current.service_revision) !== review.serviceRevision || current.status !== 'running'
        || Number(current.cancel_requested) !== 0 || current.worker_id !== review.workerId
        || Number(current.run_revision) !== review.runRevision) throw new ApiError(409, 'WORKER_BLOCKED', '운영 상태 또는 작업 소유권이 변경되었습니다.');
      const eligible = (await tx.execute({ sql: `SELECT COUNT(*) AS matching FROM proposals p
        JOIN json_each(?) binding ON p.id=json_extract(binding.value,'$.id') WHERE p.round_id=?
        AND NOT EXISTS (SELECT 1 FROM proposal_moderation m WHERE m.proposal_id=p.id AND m.moderation='excluded')
        AND NOT EXISTS (SELECT 1 FROM member_access m WHERE m.user_id=p.user_id AND m.status='suspended')
        AND ${approvedSafetySql()} AND ${safetyBindingsSql()}`, args: [JSON.stringify(review.bindings), review.roundId] })).rows[0];
      if (Number(eligible.matching) !== review.bindings.length) throw new ApiError(409, 'WORKER_BLOCKED', '현재 승인된 입력 연결이 변경되었습니다.');
      const auditId = `game-release-${review.id}`;
      await tx.execute({ sql: `INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_user_id,actor_name)
        VALUES (?,${databaseClockSql},'operator_review_game_release',?,?,NULL,?)`,
        args: [auditId, review.runId, payloadDigest, `codex-delegated:${review.operatorId}`] });
      const columns = ['id', 'request_id', 'operator_id', 'authorization_ref', 'run_id', ...COLUMN_KEYS,
        'worker_id', 'run_revision', 'service_revision', 'round_id', 'bindings_digest', 'release_digest', 'payload_digest', 'audit_id'];
      const values = [review.id, review.requestId, review.operatorId, review.authorizationRef, review.runId,
        ...RELEASE_BINDING_KEYS.map(key => review[key]), review.workerId, review.runRevision, review.serviceRevision,
        review.roundId, bindingsDigest, releaseDigest, payloadDigest, auditId];
      await tx.execute({ sql: `INSERT INTO game_release_reviews(${columns.join(',')},created_at)
        VALUES (${columns.map(() => '?').join(',')},${databaseClockSql})`, args: values });
      const receipt = await verifyReleaseReview(tx, { reviewId: review.id, runId: review.runId, ...releaseBinding });
      await tx.commit();
      return { ...receipt, replayed: false };
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve uncertainty, never retry a commit automatically. */ }
      throw error;
    } finally { tx.close(); }
  }
  return { issueReview, verifyReview: expected => verifyReleaseReview(client, expected) };
}
