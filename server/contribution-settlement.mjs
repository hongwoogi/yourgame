// Trusted local operator only. This module is never an HTTP action. The
// operator reviews fulfillment evidence; client/game JSON cannot issue points.
import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { checkContributionSchema } from './contribution-schema.mjs';
import { MAX_CONTRIBUTION_READ_ROWS } from './contribution-store.mjs';
import { contributionAwardKey, formatHalfPoints, previewRequirementContributions,
  publicContributionPolicy } from './contribution-policy.mjs';
import { createGamePublicationStore } from './game-publication-store.mjs';
import { releaseBindingDigest, releaseInputDigest, verifyReleaseReview } from './game-release-store.mjs';
import { approvedSafetySql, safetyBindingsSql } from './safety-store.mjs';
import { MAX_CONTRIBUTION_INPUTS, readContributionVotes } from './contribution-votes.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const FORMULAS = new Set(['weighted', 'exponent']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const validId = value => typeof value === 'string' && ID.test(value);
const validHash = value => typeof value === 'string' && HASH.test(value);
const fail = (code, status = 409) => { throw new ApiError(status, code, '기여도 정산 근거와 현재 상태를 확인해 주세요.'); };
const policyVersion = formula => `contribution-${formula}-v1`;

function configuredPolicy() {
  const policy = publicContributionPolicy();
  if (policy.status !== 'active' || !policy.policyVersion) return null;
  const formula = policy.proposer.upvote.operation === 'multiply' ? 'weighted'
    : policy.proposer.upvote.operation === 'power' ? 'exponent' : null;
  return formula ? { formula, policyVersion: policy.policyVersion } : null;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS contribution_settlement_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS contribution_settlements (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
    operator_id TEXT NOT NULL, authorization_ref TEXT NOT NULL,
    review_id TEXT NOT NULL REFERENCES game_release_reviews(id),
    run_id TEXT NOT NULL REFERENCES development_runs(id), game_version TEXT NOT NULL,
    publication_revision INTEGER NOT NULL CHECK(publication_revision > 0),
    scoring_policy_version TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
    awards_digest TEXT NOT NULL CHECK(length(awards_digest)=64),
    review_evidence_digest TEXT NOT NULL CHECK(length(review_evidence_digest)=64),
    awards_json TEXT NOT NULL CHECK(json_valid(awards_json) AND json_type(awards_json)='array'),
    award_count INTEGER NOT NULL CHECK(award_count > 0),
    audit_id TEXT NOT NULL UNIQUE REFERENCES admin_audit(id),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS contribution_settlements_no_update BEFORE UPDATE ON contribution_settlements
    BEGIN SELECT RAISE(ABORT,'contribution settlements are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS contribution_settlements_no_delete BEFORE DELETE ON contribution_settlements
    BEGIN SELECT RAISE(ABORT,'contribution settlements are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS contribution_settlements_no_replace BEFORE INSERT ON contribution_settlements
    WHEN EXISTS(SELECT 1 FROM contribution_settlements WHERE request_id=NEW.request_id OR audit_id=NEW.audit_id)
    BEGIN SELECT RAISE(ABORT,'contribution settlements cannot be replaced'); END`,
  // A fulfillment identifies one actual change even when related proposals are
  // later regrouped. Renaming the requirement group cannot earn it twice.
  'CREATE UNIQUE INDEX IF NOT EXISTS contribution_ledger_fulfillment_user ON contribution_ledger(fulfillment_id,user_id)',
  "INSERT INTO contribution_settlement_meta(key,value) VALUES('schema_version',1) ON CONFLICT(key) DO NOTHING",
];
const normalizeSql = sql => sql.toLowerCase().replace(/\s+/g, '').replaceAll('ifnotexists', '').replace(/;$/, '');
const GUARDS = new Map(['contribution_settlements_no_update', 'contribution_settlements_no_delete',
  'contribution_settlements_no_replace', 'contribution_ledger_fulfillment_user']
  .map(name => [name, normalizeSql(SCHEMA.find(sql => sql.includes(` ${name} `)))]));

async function schemaReady(client) {
  const exists = (await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='contribution_settlement_meta'")).rows[0];
  if (Number(exists.n) === 0) return false;
  const row = (await client.execute("SELECT value FROM contribution_settlement_meta WHERE key='schema_version'")).rows[0];
  const guards = (await client.execute({ sql: 'SELECT name,sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))',
    args: [JSON.stringify([...GUARDS.keys()])] })).rows;
  return Number(row?.value) === 1 && guards.length === GUARDS.size
    && guards.every(guard => typeof guard.sql === 'string' && normalizeSql(guard.sql) === GUARDS.get(guard.name));
}

async function requireService(client, expectedRevision) {
  const row = (await client.execute('SELECT mode,development_enabled,revision FROM service_control WHERE id=1')).rows[0];
  if (!row || row.mode !== 'active' || Number(row.development_enabled) !== 1
    || Number(row.revision) !== expectedRevision) fail('WORKER_BLOCKED');
}

export async function prepareContributionSettlementSchema(client, { expectedServiceRevision } = {}) {
  if (!positive(expectedServiceRevision)) fail('INVALID_CONTRIBUTION_SETTLEMENT', 422);
  const tx = await client.transaction('write');
  try {
    await requireService(tx, expectedServiceRevision);
    await checkContributionSchema(tx);
    for (const statement of SCHEMA) await tx.execute(statement);
    if (!await schemaReady(tx)) fail('CONTRIBUTION_SETTLEMENT_SCHEMA_UNAVAILABLE', 503);
    await tx.commit();
    return { prepared: true, schemaVersion: 1, serviceRevision: expectedServiceRevision, pointsIssued: false };
  } catch (error) {
    try { await tx.rollback(); } catch { /* Do not retry an uncertain commit. */ }
    throw error;
  } finally { tx.close(); }
}

function validatePlan(plan) {
  if (!exact(plan, ['schemaVersion','requestId','operatorId','authorizationRef','serviceRevision','publicationRevision',
    'reviewId','runId','runRevision','releaseBinding','bindings','formula','reviewEvidenceDigest','groups'])
    || plan.schemaVersion !== 1 || !['requestId','operatorId','reviewId','runId'].every(key => validId(plan[key]))
    || typeof plan.authorizationRef !== 'string' || !/^[A-Za-z0-9_:-]{8,100}$/.test(plan.authorizationRef)
    || !['serviceRevision','publicationRevision','runRevision'].every(key => positive(plan[key]))
    || !FORMULAS.has(plan.formula) || !validHash(plan.reviewEvidenceDigest)
    || !Array.isArray(plan.groups) || !plan.groups.length || plan.groups.length > 200
    || !Array.isArray(plan.bindings) || plan.bindings.length > MAX_CONTRIBUTION_INPUTS) fail('INVALID_CONTRIBUTION_SETTLEMENT', 422);
  releaseBindingDigest(plan.releaseBinding);
  releaseInputDigest(plan.bindings);
  const inputs = new Set(plan.bindings.map(binding => binding.id));
  const seenGroups = new Set();
  const seenFulfillments = new Set();
  for (const group of plan.groups) {
    if (!exact(group, ['requirementGroupId','fulfillmentId','proposalIds','fulfillment','evidenceDigest'])
      || !validId(group.requirementGroupId) || !validId(group.fulfillmentId) || seenGroups.has(group.requirementGroupId)
      || seenFulfillments.has(group.fulfillmentId)
      || !['full','partial'].includes(group.fulfillment) || !validHash(group.evidenceDigest)
      || !Array.isArray(group.proposalIds) || !group.proposalIds.length || group.proposalIds.length > inputs.size
      || new Set(group.proposalIds).size !== group.proposalIds.length
      || group.proposalIds.some(id => !inputs.has(id))) fail('INVALID_CONTRIBUTION_SETTLEMENT', 422);
    seenGroups.add(group.requirementGroupId);
    seenFulfillments.add(group.fulfillmentId);
  }
}

const LEDGER_KEYS = ['id','award_key','user_id','requirement_group_id','fulfillment_id','release_id','round_id',
  'contribution_kind','adopted','points_units','upvotes','downvotes','scoring_policy_version','safety_policy_version',
  'source_digest','assets_digest','release_evidence_digest','fulfillment_evidence_digest','vote_snapshot_digest',
  'input_bindings_digest','vote_snapshot_at','published_at','created_at'];
const numericLedgerKeys = new Set(['adopted','vote_snapshot_at','published_at','created_at']);
const ledgerView = row => Object.fromEntries(LEDGER_KEYS.map(key => [key, numericLedgerKeys.has(key) ? Number(row[key]) : row[key]]));
const summary = (records, replayed) => ({ ok: true, issuedCount: replayed ? 0 : records.length, awardCount: records.length, replayed,
  pointsIssued: !replayed, totalPoints: formatHalfPoints(records.reduce((sum, row) => sum + BigInt(row.points_units), 0n)) });

// Clock and scoring policy are internal trusted configuration, not client
// approval certificates. Neither can replace real DB publication/input proof.
export function createContributionSettlementStore(client, { databaseClockSql = DATABASE_NOW_SQL,
  scoringPolicy = configuredPolicy() } = {}) {
  if (scoringPolicy !== null && (!exact(scoringPolicy, ['formula','policyVersion'])
    || !FORMULAS.has(scoringPolicy.formula) || scoringPolicy.policyVersion !== policyVersion(scoringPolicy.formula))) {
    fail('CONTRIBUTION_POLICY_MISMATCH');
  }

  async function draft(tx, plan) {
    await checkContributionSchema(tx);
    await requireService(tx, plan.serviceRevision);
    const selection = await createGamePublicationStore(tx).getSelection();
    if (!selection.verified || selection.revision !== plan.publicationRevision || selection.activeReviewId !== plan.reviewId) {
      fail('CONTRIBUTION_PUBLICATION_UNVERIFIED');
    }
    const receipt = await verifyReleaseReview(tx, { reviewId: plan.reviewId, runId: plan.runId, ...plan.releaseBinding });
    if (receipt.bindingsDigest !== releaseInputDigest(plan.bindings)) fail('CONTRIBUTION_INPUT_BINDING_MISMATCH');
    const run = (await tx.execute({ sql: 'SELECT status,revision,worker_id,cancel_requested FROM development_runs WHERE id=?', args: [plan.runId] })).rows[0];
    if (!run || run.status !== 'completed' || Number(run.revision) !== plan.runRevision
      || Number(run.cancel_requested) !== 0 || run.worker_id !== receipt.workerId) fail('CONTRIBUTION_RUN_UNAVAILABLE');
    const confirmed = (await tx.execute({ sql: `SELECT operation_id,observation_digest,created_at FROM game_publication_events
      WHERE revision=? AND active_review_id=? AND kind='verified' AND active_verified=1`,
      args: [plan.publicationRevision, plan.reviewId] })).rows[0];
    if (!confirmed || !validHash(confirmed.observation_digest)) fail('CONTRIBUTION_PUBLICATION_UNVERIFIED');
    const matching = (await tx.execute({ sql: `SELECT COUNT(*) AS n FROM proposals p JOIN json_each(?) binding
      ON p.id=json_extract(binding.value,'$.id') WHERE p.round_id=? AND ${approvedSafetySql()} AND ${safetyBindingsSql()}
      AND NOT EXISTS(SELECT 1 FROM proposal_moderation m WHERE m.proposal_id=p.id AND m.moderation='excluded')
      AND NOT EXISTS(SELECT 1 FROM member_access m WHERE m.user_id=p.user_id AND m.status='suspended')`,
      args: [JSON.stringify(plan.bindings), receipt.roundId] })).rows[0];
    if (Number(matching.n) !== plan.bindings.length) fail('CONTRIBUTION_INPUT_BINDING_MISMATCH');
    const votes = await readContributionVotes(tx, { roundId: receipt.roundId, bindings: plan.bindings, databaseClockSql });
    const now = Number((await tx.execute(`SELECT ${databaseClockSql} AS now_ms`)).rows[0].now_ms);
    const publishedAt = Number(confirmed.created_at);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(publishedAt) || publishedAt < votes.cutoff || now < publishedAt) {
      fail('CONTRIBUTION_PUBLICATION_UNVERIFIED');
    }
    const byProposal = new Map(votes.proposals.map(item => [item.proposalId, item]));
    const awards = [];
    for (const group of plan.groups) {
      const proposals = group.proposalIds.map(id => byProposal.get(id));
      if (proposals.some(item => !item)) fail('CONTRIBUTION_INPUT_BINDING_MISMATCH');
      const authors = [...new Set(proposals.map(item => item.authorId))].sort();
      const upvoters = [...new Set(proposals.flatMap(item => item.upvoterIds))].sort();
      const downvoters = [...new Set(proposals.flatMap(item => item.downvoterIds))].sort();
      if (upvoters.some(id => downvoters.includes(id))) fail('CONTRIBUTION_VOTE_CONFLICT');
      const calculated = previewRequirementContributions({ requirementGroupId: group.requirementGroupId,
        proposerIds: authors, upvoterIds: upvoters, formula: plan.formula, upvotes: upvoters.length, downvotes: downvoters.length });
      for (const item of calculated.items) awards.push({ ...item, requirementGroupId: group.requirementGroupId,
        fulfillmentId: group.fulfillmentId, upvotes: String(upvoters.length), downvotes: String(downvoters.length),
        fulfillmentEvidenceDigest: digest({ review: plan.reviewEvidenceDigest, group }) });
    }
    awards.sort((a, b) => a.requirementGroupId.localeCompare(b.requirementGroupId, 'en') || a.userId.localeCompare(b.userId, 'en'));
    if (!awards.length || awards.length > MAX_CONTRIBUTION_READ_ROWS) fail('CONTRIBUTION_CAPACITY_EXCEEDED', 503);
    const counts = (await tx.execute('SELECT (SELECT COUNT(*) FROM contribution_ledger) AS ledger_n,(SELECT COUNT(*) FROM community_profiles) AS profiles_n')).rows[0];
    // Until the read model is replaced, never publish awards that would make
    // its exact bounded ranking unavailable. This is not a points/earnings cap.
    if (Number(counts.ledger_n) + Number(counts.profiles_n) + awards.length > MAX_CONTRIBUTION_READ_ROWS) {
      fail('CONTRIBUTION_CAPACITY_EXCEEDED', 503);
    }
    const releaseEvidenceDigest = digest({ reviewId: receipt.reviewId, binding: receipt.releaseBinding,
      publicationRevision: plan.publicationRevision, confirmation: confirmed.operation_id, observation: confirmed.observation_digest });
    const records = awards.map(item => {
      const awardKey = contributionAwardKey({ requirementGroupId: item.requirementGroupId, fulfillmentId: item.fulfillmentId, userId: item.userId });
      return {
        id: `contribution-${awardKey}`, award_key: awardKey, user_id: item.userId,
        requirement_group_id: item.requirementGroupId, fulfillment_id: item.fulfillmentId,
        release_id: plan.releaseBinding.gameVersion, round_id: receipt.roundId, contribution_kind: item.role,
        adopted: Number(item.adopted), points_units: item.halfPointUnits, upvotes: item.upvotes, downvotes: item.downvotes,
        scoring_policy_version: policyVersion(plan.formula), safety_policy_version: plan.releaseBinding.policyVersion,
        source_digest: plan.releaseBinding.sourceDigest, assets_digest: plan.releaseBinding.assetsDigest,
        release_evidence_digest: releaseEvidenceDigest, fulfillment_evidence_digest: item.fulfillmentEvidenceDigest,
        vote_snapshot_digest: votes.snapshotDigest, input_bindings_digest: receipt.bindingsDigest,
        vote_snapshot_at: votes.cutoff, published_at: publishedAt, created_at: now,
      };
    });
    return { kind: 'contribution_settlement_preview', awardable: false, formula: plan.formula,
      policyVersion: policyVersion(plan.formula), payloadDigest: digest(plan), groupCount: plan.groups.length,
      awardCount: awards.length, awards, totalPoints: formatHalfPoints(awards.reduce((sum, item) => sum + BigInt(item.halfPointUnits), 0n)),
      records, voteSnapshotDigest: votes.snapshotDigest, voteSnapshotAt: votes.cutoff, publishedAt };
  }

  async function preview(plan) {
    validatePlan(plan);
    const tx = await client.transaction('read');
    try { const result = await draft(tx, plan); await tx.commit(); return result; }
    finally { tx.close(); }
  }

  async function settle(plan) {
    validatePlan(plan);
    const payloadDigest = digest(plan);
    const tx = await client.transaction('write');
    try {
      await checkContributionSchema(tx);
      if (!await schemaReady(tx)) fail('CONTRIBUTION_SETTLEMENT_SCHEMA_UNAVAILABLE', 503);
      const old = (await tx.execute({ sql: 'SELECT * FROM contribution_settlements WHERE request_id=?', args: [plan.requestId] })).rows[0];
      if (old) {
        if (old.payload_digest !== payloadDigest || old.operator_id !== plan.operatorId) fail('CONTRIBUTION_SETTLEMENT_CONFLICT');
        const audit = (await tx.execute({ sql: `SELECT COUNT(*) AS n FROM admin_audit WHERE id=? AND action='operator_settle_contributions'
          AND target_id=? AND actor_user_id IS NULL AND actor_name=? AND reason=?`,
          args: [old.audit_id, old.game_version, `codex-delegated:${plan.operatorId}`, payloadDigest] })).rows[0];
        let expected;
        try { expected = JSON.parse(old.awards_json); } catch { fail('CONTRIBUTION_REVIEW_UNAVAILABLE'); }
        if (Number(audit.n) !== 1 || !Array.isArray(expected) || expected.length !== Number(old.award_count)
          || !expected.length || expected.length > MAX_CONTRIBUTION_READ_ROWS || digest(expected) !== old.awards_digest) fail('CONTRIBUTION_REVIEW_UNAVAILABLE');
        const actual = (await tx.execute({ sql: 'SELECT * FROM contribution_ledger WHERE award_key IN (SELECT value FROM json_each(?))',
          args: [JSON.stringify(expected.map(row => row.award_key))] })).rows.map(ledgerView);
        const order = rows => rows.sort((a, b) => a.award_key.localeCompare(b.award_key, 'en'));
        if (digest(order(actual)) !== digest(order(expected))) fail('CONTRIBUTION_REVIEW_UNAVAILABLE');
        await tx.commit();
        return summary(actual, true);
      }
      if (!scoringPolicy) fail('CONTRIBUTION_POLICY_UNCONFIRMED');
      if (scoringPolicy.formula !== plan.formula) fail('CONTRIBUTION_POLICY_MISMATCH');
      const result = await draft(tx, plan);
      for (const row of result.records) {
        const existing = (await tx.execute({ sql: `SELECT COUNT(*) AS n FROM contribution_ledger WHERE award_key=?
          OR (user_id=? AND (fulfillment_id=? OR (requirement_group_id=? AND release_id=?)))`,
          args: [row.award_key,row.user_id,row.fulfillment_id,row.requirement_group_id,row.release_id] })).rows[0];
        if (Number(existing.n)) fail('CONTRIBUTION_ALREADY_ISSUED');
      }
      for (const row of result.records) await tx.execute({ sql: `INSERT INTO contribution_ledger(${LEDGER_KEYS.join(',')})
        VALUES(${LEDGER_KEYS.map(() => '?').join(',')})`, args: LEDGER_KEYS.map(key => row[key]) });
      const auditId = `contribution-${createHash('sha256').update(plan.requestId).digest('hex')}`;
      await tx.execute({ sql: `INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_user_id,actor_name)
        VALUES(?,?,'operator_settle_contributions',?,?,NULL,?)`,
        args: [auditId,result.records[0].created_at,plan.releaseBinding.gameVersion,payloadDigest,`codex-delegated:${plan.operatorId}`] });
      await tx.execute({ sql: `INSERT INTO contribution_settlements(request_id,operator_id,authorization_ref,review_id,run_id,
        game_version,publication_revision,scoring_policy_version,payload_digest,awards_digest,review_evidence_digest,
        awards_json,award_count,audit_id,created_at) VALUES(${Array(15).fill('?').join(',')})`,
        args: [plan.requestId,plan.operatorId,plan.authorizationRef,plan.reviewId,plan.runId,plan.releaseBinding.gameVersion,
          plan.publicationRevision,scoringPolicy.policyVersion,payloadDigest,digest(result.records),plan.reviewEvidenceDigest,
          JSON.stringify(result.records),result.records.length,auditId,result.records[0].created_at] });
      await tx.commit();
      return summary(result.records, false);
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve uncertainty; reuse the exact request, never invent a retry. */ }
      throw error;
    } finally { tx.close(); }
  }
  return { preview, settle };
}
