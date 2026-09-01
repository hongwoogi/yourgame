// Trusted local operator only. Never import this module from an HTTP route or
// give its database credentials to a game-generation agent. The owner explicitly
// delegated content review and DB recording on 2026-08-31; this is NOT login.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { DATABASE_NOW_SQL } from '../server/database-clock.mjs';
import { bodyDigest, SAFETY_COLUMNS, SAFETY_JOINS } from '../server/safety-store.mjs';
import { SAFETY_POLICY_VERSION, assertScreenedBody, validateDevelopmentBrief } from '../server/safety-policy.mjs';
import { preparePrivateFile, resolvePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { operatorCode: code }); };
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const validId = value => typeof value === 'string' && ID.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function checkService(row, expectedRevision) {
  if (!row || row.mode !== 'active' || Number(row.development_enabled) !== 1
    || Number(row.revision) !== expectedRevision) fail('OPERATOR_SERVICE_BLOCKED');
}

export async function exportReviewIntake(client, roundId) {
  if (!['initial', 'pending'].includes(roundId)) fail('OPERATOR_INVALID_INPUT');
  const tx = await client.transaction('read');
  try {
    const service = (await tx.execute('SELECT * FROM service_control WHERE id = 1')).rows[0];
    checkService(service, Number(service?.revision));
    const rows = (await tx.execute({ sql: `SELECT p.id, p.body, p.revision, p.round_id, ${SAFETY_COLUMNS},
      COALESCE(m.moderation, 'pending') AS moderation, COALESCE(a.status, 'active') AS member_status
      FROM proposals p ${SAFETY_JOINS}
      LEFT JOIN proposal_moderation m ON m.proposal_id = p.id
      LEFT JOIN member_access a ON a.user_id = p.user_id WHERE p.round_id = ?
      ORDER BY p.created_at, p.id`, args: [roundId] })).rows;
    await tx.commit();
    return { schemaVersion: 1, roundId, serviceRevision: Number(service.revision), policyVersion: SAFETY_POLICY_VERSION,
      items: rows.map(row => ({ proposalId: row.id, proposalRevision: Number(row.revision), bodyHash: bodyDigest(row.body),
        safetyReviewId: row.safe_id, safetyRevision: Number(row.safe_revision), safetyStatus: row.safe_status,
        body: row.body, excluded: row.moderation === 'excluded' || row.member_status === 'suspended' })) };
  } finally { tx.close(); }
}

function validateDecision(plan) {
  if (!exact(plan, ['schemaVersion', 'requestId', 'operatorId', 'authorizationRef', 'serviceRevision', 'roundId', 'policyVersion', 'items'])
    || plan.schemaVersion !== 1 || !validId(plan.requestId) || !validId(plan.operatorId)
    || typeof plan.authorizationRef !== 'string' || !/^[A-Za-z0-9_:-]{8,100}$/.test(plan.authorizationRef)
    || !Number.isSafeInteger(plan.serviceRevision) || plan.serviceRevision < 1
    || !['initial', 'pending'].includes(plan.roundId) || plan.policyVersion !== SAFETY_POLICY_VERSION
    || !Array.isArray(plan.items) || !plan.items.length || plan.items.length > 50) fail('OPERATOR_INVALID_INPUT');
  const seen = new Set();
  for (const item of plan.items) {
    if (!exact(item, ['proposalId', 'proposalRevision', 'bodyHash', 'safetyReviewId', 'safetyRevision', 'status', 'reason', 'developmentBrief', 'checks'])
      || !validId(item.proposalId) || !validId(item.safetyReviewId) || typeof item.bodyHash !== 'string' || !HASH.test(item.bodyHash)
      || !Number.isSafeInteger(item.proposalRevision) || item.proposalRevision < 1
      || !Number.isSafeInteger(item.safetyRevision) || item.safetyRevision < 1
      || !['approved', 'held', 'blocked'].includes(item.status)
      || typeof item.reason !== 'string' || !item.reason.isWellFormed() || !item.reason.trim() || item.reason.length > 160 || item.reason.includes('\0')
      || !exact(item.checks, ['content', 'privacy', 'injection', 'brief'])
      || Object.values(item.checks).some(value => typeof value !== 'boolean')
      || seen.has(item.proposalId)) fail('OPERATOR_INVALID_INPUT');
    seen.add(item.proposalId);
    if (item.status === 'approved') {
      if (!Object.values(item.checks).every(Boolean)) fail('OPERATOR_CHECKLIST_REQUIRED');
      validateDevelopmentBrief(item.developmentBrief);
    } else if (item.developmentBrief !== '') fail('OPERATOR_INVALID_INPUT');
  }
}

// No schema changes, fabricated user/session, public endpoint, or release gate
// changes. Each immutable audit row is also an exact-payload retry receipt.
async function applyBoundOperatorReview(client, plan, { databaseClockSql = DATABASE_NOW_SQL, expectedStatus }) {
  validateDecision(plan);
  if (!['pending', 'held'].includes(expectedStatus)) fail('OPERATOR_INVALID_INPUT');
  const tx = await client.transaction('write');
  try {
    checkService((await tx.execute('SELECT * FROM service_control WHERE id = 1')).rows[0], plan.serviceRevision);
    const policy = (await tx.execute("SELECT value FROM safety_meta WHERE key = 'policy_version'")).rows[0]?.value;
    if (policy !== plan.policyVersion) fail('OPERATOR_POLICY_CHANGED');
    let applied = 0, replayed = 0;
    for (const item of plan.items) {
      const auditId = `operator-safety-${plan.requestId}-${item.proposalId}`;
      const payloadDigest = digest({ ...plan, items: [item] });
      const receipt = (await tx.execute({ sql: 'SELECT action, target_id, reason, actor_user_id, actor_name FROM admin_audit WHERE id = ?', args: [auditId] })).rows[0];
      if (receipt) {
        const expected = JSON.stringify({ reason: item.reason, authorization: plan.authorizationRef, payloadDigest });
        if (receipt.action !== 'operator_review_proposal_safety' || receipt.target_id !== item.proposalId
          || receipt.actor_user_id !== null || receipt.actor_name !== `codex-delegated:${plan.operatorId}` || receipt.reason !== expected) fail('OPERATOR_RETRY_CONFLICT');
        replayed++;
        continue;
      }
      const row = (await tx.execute({ sql: `SELECT p.body, p.revision, p.round_id, ${SAFETY_COLUMNS},
        COALESCE(m.moderation, 'pending') AS moderation, COALESCE(a.status, 'active') AS member_status
        FROM proposals p ${SAFETY_JOINS}
        LEFT JOIN proposal_moderation m ON m.proposal_id = p.id
        LEFT JOIN member_access a ON a.user_id = p.user_id WHERE p.id = ?`, args: [item.proposalId] })).rows[0];
      if (!row || Number(row.revision) !== item.proposalRevision || row.round_id !== plan.roundId
        || bodyDigest(row.body) !== item.bodyHash || row.safe_body_hash !== item.bodyHash
        || row.safe_id !== item.safetyReviewId || Number(row.safe_revision) !== item.safetyRevision
        || row.safe_status !== expectedStatus) fail('OPERATOR_REVIEW_CONFLICT');
      if (item.status === 'approved' && (row.moderation === 'excluded' || row.member_status === 'suspended')) fail('OPERATOR_PROPOSAL_EXCLUDED');
      const brief = item.status === 'approved' ? validateDevelopmentBrief(item.developmentBrief) : '';
      if (item.status === 'approved') assertScreenedBody(row.body);
      const changed = await tx.execute({ sql: `UPDATE proposal_safety_reviews SET status = ?, revision = revision + 1,
        reason = ?, development_brief = ?, development_brief_hash = ?, checklist_confirmed = ?, reviewer_id = NULL,
        reviewed_at = ${databaseClockSql} WHERE id = ? AND revision = ? AND status = ?`,
        args: [item.status, item.reason, brief, brief ? bodyDigest(brief) : '', Number(item.status === 'approved'),
          item.safetyReviewId, item.safetyRevision, expectedStatus] });
      if (changed.rowsAffected !== 1) fail('OPERATOR_REVIEW_CONFLICT');
      await tx.execute({ sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_user_id, actor_name)
        VALUES (?, ${databaseClockSql}, 'operator_review_proposal_safety', ?, ?, NULL, ?)`,
        args: [auditId, item.proposalId, JSON.stringify({ reason: item.reason, authorization: plan.authorizationRef, payloadDigest }), `codex-delegated:${plan.operatorId}`] });
      applied++;
    }
    await tx.commit();
    return { ok: true, applied, replayed, inputReviewOnly: true, gamePublished: false };
  } catch (error) {
    try { await tx.rollback(); } catch { /* retain the original failure, never retry an uncertain commit */ }
    throw error;
  } finally { tx.close(); }
}

export function applyOperatorReview(client, plan, options = {}) {
  return applyBoundOperatorReview(client, plan, { ...options, expectedStatus: 'pending' });
}

// A held decision is not immutable: the delegated operator may resolve genuine
// ambiguity after a second semantic review. This path remains bound to the same
// body, policy and safety revision and cannot override a blocked decision.
export function applyOperatorHeldReReview(client, plan, options = {}) {
  return applyBoundOperatorReview(client, plan, { ...options, expectedStatus: 'held' });
}

async function main() {
  let client;
  try {
    const [command, file, roundId, ...extra] = process.argv.slice(2);
    if (extra.length || !['export', 'apply', 'reapply-held'].includes(command) || !file
      || (['apply', 'reapply-held'].includes(command) && roundId)) fail('OPERATOR_INVALID_INPUT');
    client = await openDatabase(readConfig(), { initialize: false });
    const absolute = path.resolve(root, file);
    if (command === 'export') {
      const intake = await exportReviewIntake(client, roundId);
      await preparePrivateFile(absolute);
      await writeFile(absolute, JSON.stringify(intake, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ ok: true, exported: intake.items.length, privateRecord: path.relative(root, absolute) }));
    } else {
      const decision = JSON.parse(await readFile(await resolvePrivateFile(absolute), 'utf8'));
      console.log(JSON.stringify(await (command === 'apply'
        ? applyOperatorReview(client, decision) : applyOperatorHeldReReview(client, decision))));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.operatorCode || (['PROPOSAL_SAFETY_REJECTED', 'INVALID_SAFETY_BRIEF'].includes(error.code) ? error.code : 'OPERATOR_REVIEW_UNAVAILABLE') }));
    process.exitCode = 1;
  } finally { client?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
