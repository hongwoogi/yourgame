// Trusted operator selection/observation only. HTTP routes may call getPublicGame,
// never activate/confirm/rollback. No operation changes user or game-save data.
import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { dailyCycleForDate } from './daily-schedule.mjs';
import { approvedSafetySql, safetyBindingsSql } from './safety-store.mjs';
import { checkGameReleaseSchema } from './game-release-schema.mjs';
import { RELEASE_RECEIPT_SQL, releaseBindingDigest, releaseInputDigest, verifyReleaseReview } from './game-release-store.mjs';

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const integer = (value, min = 1) => Number.isSafeInteger(value) && value >= min;
const validId = value => typeof value === 'string' && ID.test(value);
const validHash = value => typeof value === 'string' && HASH.test(value);
const fail = (code = 'INVALID_PUBLICATION_INPUT') => { throw new ApiError(code === 'INVALID_PUBLICATION_INPUT' ? 422 : 409, code, '게임 공개 선택 상태를 확인해 주세요.'); };

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS game_publication_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS game_publication_selection (
    id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),
    active_review_id TEXT REFERENCES game_release_reviews(id),previous_verified_review_id TEXT REFERENCES game_release_reviews(id),
    active_verified INTEGER NOT NULL CHECK(active_verified IN (0,1)),activation_operation_id TEXT,
    CHECK(active_review_id IS NOT NULL OR (active_verified=0 AND activation_operation_id IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS game_publication_events (
    operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('selected','verified','rollback')),
    revision INTEGER NOT NULL UNIQUE CHECK(revision>0),active_review_id TEXT REFERENCES game_release_reviews(id),
    previous_verified_review_id TEXT REFERENCES game_release_reviews(id),active_verified INTEGER NOT NULL CHECK(active_verified IN (0,1)),
    activation_operation_id TEXT,context_json TEXT,observation_digest TEXT,reason TEXT,
    payload_digest TEXT NOT NULL,operator_id TEXT NOT NULL,audit_id TEXT NOT NULL UNIQUE REFERENCES admin_audit(id),created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS game_publication_events_no_update BEFORE UPDATE ON game_publication_events
    BEGIN SELECT RAISE(ABORT,'publication events are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS game_publication_events_no_delete BEFORE DELETE ON game_publication_events
    BEGIN SELECT RAISE(ABORT,'publication events are immutable'); END`,
  `INSERT INTO game_publication_selection(id,revision,active_verified) VALUES(1,0,0) ON CONFLICT(id) DO NOTHING`,
  `INSERT INTO game_publication_meta(key,value) VALUES('schema_version',1) ON CONFLICT(key) DO NOTHING`,
];

async function schemaReady(client) {
  const exists = (await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='game_publication_meta'")).rows[0];
  if (Number(exists.n) === 0) return false;
  const row = (await client.execute(`SELECT value,(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'
    AND name IN ('game_publication_events_no_update','game_publication_events_no_delete')) AS guards
    FROM game_publication_meta WHERE key='schema_version'`)).rows[0];
  return Number(row?.value) === 1 && Number(row?.guards) === 2;
}

async function requireService(client, revision) {
  const service = (await client.execute('SELECT mode,development_enabled,revision FROM service_control WHERE id=1')).rows[0];
  if (!service || service.mode !== 'active' || Number(service.development_enabled) !== 1
    || Number(service.revision) !== revision) fail('WORKER_BLOCKED');
}

export async function preparePublicationSchema(client, { expectedServiceRevision } = {}) {
  if (!integer(expectedServiceRevision)) fail();
  const tx = await client.transaction('write');
  try {
    await requireService(tx, expectedServiceRevision);
    await checkGameReleaseSchema(tx);
    for (const statement of SCHEMA) await tx.execute(statement);
    if (!await schemaReady(tx)) fail('PUBLICATION_UNAVAILABLE');
    await tx.commit();
    return { prepared: true, schemaVersion: 1, serviceRevision: expectedServiceRevision, pointsIssued: false };
  } catch (error) {
    try { await tx.rollback(); } catch { /* Never infer the outcome of an uncertain commit. */ }
    throw error;
  } finally { tx.close(); }
}

const stateView = row => ({ revision: Number(row.revision), activeReviewId: row.active_review_id ?? null,
  previousVerifiedReviewId: row.previous_verified_review_id ?? null, verified: Number(row.active_verified) === 1 });
const EVENT_SQL = `SELECT e.* FROM game_publication_events e JOIN admin_audit a ON a.id=e.audit_id
  WHERE a.action=('operator_game_' || e.kind) AND a.target_id='game-publication'
  AND a.actor_user_id IS NULL AND a.actor_name=('codex-delegated:' || e.operator_id) AND a.reason=e.payload_digest`;

async function selectionIsRecorded(client, state) {
  if (Number(state.revision) === 0) return state.active_review_id === null && state.previous_verified_review_id === null
    && Number(state.active_verified) === 0 && state.activation_operation_id === null;
  const event = (await client.execute({ sql: `${EVENT_SQL} AND e.revision=?`, args: [state.revision] })).rows[0];
  return Boolean(event) && ['active_review_id','previous_verified_review_id','active_verified','activation_operation_id']
    .every(key => event[key] === state[key]);
}

async function receipt(client, reviewId) {
  const row = (await client.execute({ sql: `${RELEASE_RECEIPT_SQL} AND r.id=?`, args: [reviewId] })).rows[0];
  if (!row) fail('RELEASE_REVIEW_UNAVAILABLE');
  const verified = await verifyReleaseReview(client, { reviewId, runId: row.run_id,
    snapshotDigest: row.snapshot_digest, sourceDigest: row.source_digest, assetsDigest: row.assets_digest });
  return { ...verified, operatorId: row.operator_id };
}

async function currentInput(client, input) {
  const review = await verifyReleaseReview(client, { reviewId: input.reviewId, runId: input.runId, ...input.releaseBinding });
  if (review.bindingsDigest !== releaseInputDigest(input.bindings) || review.workerId !== input.workerId
    || review.runRevision !== input.runRevision || review.serviceRevision !== input.serviceRevision
    || review.roundId !== input.roundId) fail('RELEASE_REVIEW_UNAVAILABLE');
  await requireService(client, input.serviceRevision);
  const run = (await client.execute({ sql: 'SELECT status,cancel_requested,worker_id,revision FROM development_runs WHERE id=?', args: [input.runId] })).rows[0];
  if (!run || run.status !== 'running' || Number(run.cancel_requested) !== 0
    || run.worker_id !== input.workerId || Number(run.revision) !== input.runRevision) fail('WORKER_BLOCKED');
  const eligible = (await client.execute({ sql: `SELECT COUNT(*) AS n FROM proposals p JOIN json_each(?) binding
    ON p.id=json_extract(binding.value,'$.id') WHERE p.round_id=? AND ${approvedSafetySql()} AND ${safetyBindingsSql()}
    AND NOT EXISTS(SELECT 1 FROM proposal_moderation m WHERE m.proposal_id=p.id AND m.moderation='excluded')
    AND NOT EXISTS(SELECT 1 FROM member_access m WHERE m.user_id=p.user_id AND m.status='suspended')`,
    args: [JSON.stringify(input.bindings), input.roundId] })).rows[0];
  if (Number(eligible.n) !== input.bindings.length) fail('WORKER_BLOCKED');
  return receipt(client, input.reviewId);
}

// Resolves trusted scheduling data only; this is not input or release authority.
export async function resolveDailyRunCycle(client, runId) {
  // Retry timestamps and caller input cannot change the trusted root's cycle.
  // Bound corrupt/legacy ancestry and reject ambiguity instead of treating it
  // as an unrestricted first release. Ancestors are never modified here.
  const seen = new Set();
  let ancestorId = runId;
  for (let depth = 0; depth < 64; depth += 1) {
    if (!validId(ancestorId) || seen.has(ancestorId)) fail('WORKER_BLOCKED');
    seen.add(ancestorId);
    const ancestor = (await client.execute({ sql: 'SELECT id,parent_id FROM development_runs WHERE id=?',
      args: [ancestorId] })).rows[0];
    if (!ancestor || ancestor.id !== ancestorId) fail('WORKER_BLOCKED');
    if (ancestor.parent_id !== null) {
      if (ancestorId.startsWith('daily-game-')) fail('WORKER_BLOCKED');
      ancestorId = ancestor.parent_id;
      continue;
    }
    if (!ancestorId.startsWith('daily-game-')) return null;
    const match = /^daily-game-(\d{4}-\d{2}-\d{2})$/.exec(ancestorId);
    if (!match) fail('WORKER_BLOCKED');
    try { return dailyCycleForDate(match[1]); }
    catch { fail('WORKER_BLOCKED'); }
  }
  fail('WORKER_BLOCKED');
}

async function requireDailyReleaseDue(client, input, databaseClockSql) {
  const cycle = await resolveDailyRunCycle(client, input.runId);
  if (!cycle) {
    if (input.roundId === 'pending') fail('WORKER_BLOCKED');
    return;
  }
  if (input.roundId !== 'pending') fail('WORKER_BLOCKED');
  // currentInput already checked the exact safety/revision bindings. Bind every
  // proposal to this root's immutable creation window and frozen update time too;
  // an older daily root must not unlock a later cycle's otherwise valid input.
  const closedAt = Date.parse(cycle.closesAt);
  const eligible = (await client.execute({ sql: `SELECT COUNT(*) AS n FROM proposals p JOIN json_each(?) binding
    ON p.id=json_extract(binding.value,'$.id') WHERE p.round_id='pending'
    AND p.created_at>=? AND p.created_at<? AND p.updated_at<?`,
    args: [JSON.stringify(input.bindings), Date.parse(cycle.opensAt), closedAt, closedAt] })).rows[0];
  if (Number(eligible.n) !== input.bindings.length) fail('WORKER_BLOCKED');
  const releaseAt = Date.parse(cycle.releaseAt);
  const clock = (await client.execute(`SELECT ${databaseClockSql} AS now_ms`)).rows[0];
  const now = Number(clock?.now_ms);
  if (clock?.now_ms == null || !Number.isSafeInteger(now) || !Number.isSafeInteger(releaseAt)) fail('WORKER_BLOCKED');
  if (now < releaseAt) fail('DAILY_RELEASE_NOT_DUE');
}

export function createGamePublicationStore(client, { databaseClockSql = DATABASE_NOW_SQL } = {}) {
  async function getSelection() {
    if (!await schemaReady(client)) return { revision: 0, activeReviewId: null, previousVerifiedReviewId: null, verified: false };
    const row = (await client.execute('SELECT * FROM game_publication_selection WHERE id=1')).rows[0];
    if (!row || !await selectionIsRecorded(client,row)) fail('PUBLICATION_UNAVAILABLE');
    return stateView(row);
  }

  async function mutate(kind, input, change) {
    const payloadDigest = digest({ kind, input });
    const tx = await client.transaction('write');
    try {
      if (!await schemaReady(tx)) fail('PUBLICATION_UNAVAILABLE');
      const old = (await tx.execute({ sql: `${EVENT_SQL} AND e.operation_id=?`, args: [input.operationId] })).rows[0];
      if (old) {
        if (old.kind !== kind || old.payload_digest !== payloadDigest) fail('PUBLICATION_CONFLICT');
        await tx.commit();
        return { ...stateView(old), updated: true, replayed: true, pointsIssued: false };
      }
      const state = (await tx.execute('SELECT * FROM game_publication_selection WHERE id=1')).rows[0];
      if (!state || Number(state.revision) !== input.expectedRevision) fail('REVISION_CONFLICT');
      if (!await selectionIsRecorded(tx,state)) fail('PUBLICATION_UNAVAILABLE');
      const result = await change(tx, state);
      const revision = Number(state.revision) + 1;
      const auditId = `game-publication-${input.operationId}`;
      await tx.execute({ sql: `INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_user_id,actor_name)
        VALUES(?,${databaseClockSql},?,'game-publication',?,NULL,?)`,
        args: [auditId, `operator_game_${kind}`, payloadDigest, `codex-delegated:${result.operatorId}`] });
      const values = [input.operationId, kind, revision, result.activeReviewId, result.previousVerifiedReviewId,
        Number(result.verified), result.activationOperationId, result.context ? JSON.stringify(result.context) : null,
        input.observationDigest ?? null, input.reason ?? null, payloadDigest, result.operatorId, auditId];
      await tx.execute({ sql: `INSERT INTO game_publication_events(operation_id,kind,revision,active_review_id,
        previous_verified_review_id,active_verified,activation_operation_id,context_json,observation_digest,reason,
        payload_digest,operator_id,audit_id,created_at) VALUES(${values.map(() => '?').join(',')},${databaseClockSql})`, args: values });
      const updated = await tx.execute({ sql: `UPDATE game_publication_selection SET revision=?,active_review_id=?,
        previous_verified_review_id=?,active_verified=?,activation_operation_id=? WHERE id=1 AND revision=?`,
        args: [revision, result.activeReviewId, result.previousVerifiedReviewId, Number(result.verified), result.activationOperationId, state.revision] });
      if (updated.rowsAffected !== 1) fail('REVISION_CONFLICT');
      await tx.commit();
      return { revision, activeReviewId: result.activeReviewId, previousVerifiedReviewId: result.previousVerifiedReviewId,
        verified: result.verified, updated: true, replayed: false, pointsIssued: false };
    } catch (error) {
      try { await tx.rollback(); } catch { /* No automatic retry after an uncertain result. */ }
      throw error;
    } finally { tx.close(); }
  }

  async function activationContext(tx, state) {
    const event = (await tx.execute({ sql: `${EVENT_SQL} AND e.operation_id=? AND e.kind='selected'`,
      args: [state.activation_operation_id] })).rows[0];
    if (!event || event.active_review_id !== state.active_review_id || !event.context_json) fail('PUBLICATION_UNAVAILABLE');
    try { return JSON.parse(event.context_json); } catch { fail('PUBLICATION_UNAVAILABLE'); }
  }

  async function activate(input) {
    const keys = ['operationId','reviewId','runId','workerId','runRevision','serviceRevision','bindings','roundId',
      'releaseBinding','commitSha','deploymentId','expectedRevision'];
    if (!exact(input, keys) || !['operationId','reviewId','runId','workerId','deploymentId'].every(key => validId(input[key]))
      || !integer(input.expectedRevision, 0) || !integer(input.runRevision) || !integer(input.serviceRevision)
      || !['initial','pending'].includes(input.roundId) || typeof input.commitSha !== 'string'
      || !/^[a-f0-9]{40,64}$/.test(input.commitSha)) fail();
    releaseBindingDigest(input.releaseBinding);
    releaseInputDigest(input.bindings);
    return mutate('selected', input, async (tx, state) => {
      if (state.active_review_id && !Number(state.active_verified)) fail('PUBLICATION_PENDING_VERIFICATION');
      const reviewed = await currentInput(tx, input);
      await requireDailyReleaseDue(tx, input, databaseClockSql);
      // An immutable version must never identify changed content or executable runtime.
      const collision = (await tx.execute({ sql: `SELECT COUNT(*) AS n FROM game_publication_events e
        JOIN game_release_reviews r ON r.id=e.active_review_id WHERE e.kind='selected' AND r.game_version=?
        AND (r.content_sha256<>? OR r.runtime_digest<>?)`, args: [input.releaseBinding.gameVersion,
        input.releaseBinding.contentSha256,input.releaseBinding.runtimeDigest] })).rows[0];
      if (Number(collision.n)) fail('GAME_VERSION_CONFLICT');
      return { activeReviewId: input.reviewId, previousVerifiedReviewId: state.active_review_id ?? null,
        verified: false, activationOperationId: input.operationId, context: input, operatorId: reviewed.operatorId };
    });
  }

  async function confirm(input) {
    if (!exact(input,['operationId','expectedRevision','observationDigest']) || !validId(input.operationId)
      || !integer(input.expectedRevision) || !validHash(input.observationDigest)) fail();
    return mutate('verified',input,async (tx,state) => {
      if (!state.active_review_id || Number(state.active_verified)) fail('PUBLICATION_CONFLICT');
      const context = await activationContext(tx,state);
      const reviewed = await currentInput(tx,context);
      await requireDailyReleaseDue(tx, context, databaseClockSql);
      return { activeReviewId: state.active_review_id, previousVerifiedReviewId: state.previous_verified_review_id,
        verified: true, activationOperationId: state.activation_operation_id, operatorId: reviewed.operatorId };
    });
  }

  async function rollback(input) {
    if (!exact(input,['operationId','expectedRevision','reason']) || !validId(input.operationId)
      || !integer(input.expectedRevision) || typeof input.reason !== 'string' || !input.reason.isWellFormed()
      || !input.reason.trim() || input.reason.length>160 || /[\x00-\x1f]/.test(input.reason)) fail();
    return mutate('rollback',input,async (tx,state) => {
      if (!state.active_review_id) fail('PUBLICATION_CONFLICT');
      const context = await activationContext(tx,state);
      // Recovery does not require still-approved failed candidate inputs, but
      // cannot silently resume an ended/paused or changed operational service.
      await requireService(tx,context.serviceRevision);
      const active = await receipt(tx,state.active_review_id);
      if (!state.previous_verified_review_id) return { activeReviewId:null,previousVerifiedReviewId:null,
        verified:false,activationOperationId:null,operatorId:active.operatorId };
      const previous = (await tx.execute({ sql: `${EVENT_SQL} AND e.kind='verified' AND e.active_review_id=?
        ORDER BY e.revision DESC LIMIT 1`, args:[state.previous_verified_review_id] })).rows[0];
      if (!previous) fail('PUBLICATION_UNAVAILABLE');
      await receipt(tx,previous.active_review_id);
      return { activeReviewId:previous.active_review_id,previousVerifiedReviewId:previous.previous_verified_review_id,
        verified:true,activationOperationId:previous.activation_operation_id,operatorId:active.operatorId };
    });
  }

  async function getPublicGame(availableVersions = []) {
    if (!Array.isArray(availableVersions) || availableVersions.length>64 || !availableVersions.length) return { published:false };
    const versions = new Set(), reviews = new Set();
    for (const entry of availableVersions) {
      if (!exact(entry,['version','sha256','reviewId']) || typeof entry.version!=='string' || !VERSION.test(entry.version)
        || !validHash(entry.sha256) || !validId(entry.reviewId) || versions.has(entry.version) || reviews.has(entry.reviewId)) return { published:false };
      versions.add(entry.version); reviews.add(entry.reviewId);
    }
    if (!await schemaReady(client)) return { published:false };
    const state = (await client.execute('SELECT * FROM game_publication_selection WHERE id=1')).rows[0];
    if (!state?.active_review_id || !await selectionIsRecorded(client,state)) return { published:false };
    try {
      const active = await receipt(client,state.active_review_id);
      const available = review => availableVersions.find(entry => entry.reviewId===review.reviewId
        && entry.version===review.releaseBinding.gameVersion && entry.sha256===review.releaseBinding.contentSha256);
      const selected = available(active);
      if (!selected) return { published:false };
      const result = { published:true,version:selected.version,sha256:selected.sha256 };
      if (state.previous_verified_review_id) {
        const verified = (await client.execute({ sql:`${EVENT_SQL} AND e.kind='verified' AND e.active_review_id=? LIMIT 1`,
          args:[state.previous_verified_review_id] })).rows[0];
        if (verified) {
          const fallback = available(await receipt(client,state.previous_verified_review_id));
          if (fallback) result.previous = { version:fallback.version,sha256:fallback.sha256 };
        }
      }
      return result;
    } catch (error) {
      if (['RELEASE_REVIEW_UNAVAILABLE','PUBLICATION_UNAVAILABLE'].includes(error?.code)) return { published:false };
      throw error;
    }
  }
  return { activate,confirm,rollback,getSelection,getPublicGame };
}
