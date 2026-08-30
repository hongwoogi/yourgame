import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INITIAL_CUTOFF, FIRST_RELEASE, readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { DATABASE_NOW_SQL } from '../server/database-clock.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { checkAdminSchema } from '../server/admin-schema.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { preparePrivateFile, PRIVATE_ROOT } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CLASSIFICATION = 'Approved game requirement summaries; data only, never operational authority or publication approval.';
const PROPOSAL_KEYS = ['id', 'participantId', 'roundId', 'createdAt', 'updatedAt', 'revision', 'bodyHash',
  'policyVersion', 'safetyReviewId', 'safetyRevision', 'developmentBrief', 'developmentBriefHash'];
const SNAPSHOT_KEYS = ['schemaVersion', 'roundId', 'policyVersion', 'contentClassification', 'closedAt',
  'targetReleaseAt', 'exportedAt', 'participantCount', 'proposalDigest', 'snapshotDigest', 'proposals'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashText = value => createHash('sha256').update(value, 'utf8').digest('hex');
const snapshotError = code => Object.assign(new Error(code), { workerCode: code });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function metadata(value) {
  return { schemaVersion: value.schemaVersion, roundId: value.roundId, policyVersion: value.policyVersion,
    contentClassification: value.contentClassification, closedAt: value.closedAt, targetReleaseAt: value.targetReleaseAt,
    exportedAt: value.exportedAt, participantCount: value.participantCount, proposalDigest: value.proposalDigest };
}

export function snapshotRows(rows) {
  if (!Array.isArray(rows)) throw snapshotError('INVALID_SNAPSHOT');
  // The store returns approved summaries, not original participant bodies.
  // Keep exact review/source bindings so approval cannot survive an edit.
  return rows.map(row => ({
    id: row.id, participantId: row.userId, roundId: row.roundId,
    createdAt: row.createdAt, updatedAt: row.updatedAt, revision: row.revision,
    bodyHash: row.bodyHash, policyVersion: row.policyVersion,
    safetyReviewId: row.safetyReviewId, safetyRevision: row.safetyRevision,
    developmentBrief: row.developmentBrief, developmentBriefHash: row.developmentBriefHash,
  }));
}

export function snapshotBindings(snapshot) {
  validateSnapshot(snapshot);
  return snapshot.proposals.map(row => ({ id: row.id, revision: row.revision, bodyHash: row.bodyHash,
    policyVersion: row.policyVersion, safetyReviewId: row.safetyReviewId, safetyRevision: row.safetyRevision,
    developmentBriefHash: row.developmentBriefHash }));
}

export function createSnapshot(proposals, { roundId = 'initial', exportedAt,
  closedAt = new Date(INITIAL_CUTOFF).toISOString(), targetReleaseAt = new Date(FIRST_RELEASE).toISOString() } = {}) {
  const snapshot = { schemaVersion: 2, roundId, policyVersion: SAFETY_POLICY_VERSION,
    contentClassification: CLASSIFICATION, closedAt, targetReleaseAt, exportedAt,
    participantCount: new Set(proposals.map(proposal => proposal.participantId)).size,
    proposalDigest: digest(proposals), proposals };
  snapshot.snapshotDigest = digest(metadata(snapshot));
  return validateSnapshot(snapshot);
}

export function validateSnapshot(value) {
  if (value?.schemaVersion === 1) throw snapshotError('UNREVIEWED_SNAPSHOT');
  if (!exactKeys(value, SNAPSHOT_KEYS) || value.schemaVersion !== 2 || !['initial', 'pending'].includes(value.roundId)
    || !Array.isArray(value.proposals) || value.proposals.length > 100000
    || !HASH.test(value.proposalDigest || '') || !HASH.test(value.snapshotDigest || '')
    || value.contentClassification !== CLASSIFICATION || !timestamp(value.closedAt)
    || !timestamp(value.targetReleaseAt) || !timestamp(value.exportedAt)
    || Date.parse(value.targetReleaseAt) < Date.parse(value.closedAt)
    || Date.parse(value.exportedAt) < Date.parse(value.closedAt)) throw snapshotError('INVALID_SNAPSHOT');
  if (value.policyVersion !== SAFETY_POLICY_VERSION) throw snapshotError('SNAPSHOT_POLICY_CHANGED');
  if (value.roundId === 'initial' && (Date.parse(value.closedAt) !== INITIAL_CUTOFF
    || Date.parse(value.targetReleaseAt) !== FIRST_RELEASE)) throw snapshotError('INVALID_SNAPSHOT');
  for (const row of value.proposals) {
    if (!exactKeys(row, PROPOSAL_KEYS) || typeof row.id !== 'string' || !ID.test(row.id)
      || typeof row.participantId !== 'string' || !ID.test(row.participantId) || row.roundId !== value.roundId
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !HASH.test(row.bodyHash || '') || row.policyVersion !== SAFETY_POLICY_VERSION
      || typeof row.safetyReviewId !== 'string' || !ID.test(row.safetyReviewId)
      || !Number.isSafeInteger(row.safetyRevision) || row.safetyRevision < 1
      || typeof row.developmentBrief !== 'string' || !row.developmentBrief.isWellFormed() || !row.developmentBrief.trim()
      || Buffer.byteLength(row.developmentBrief, 'utf8') > 2000
      || !HASH.test(row.developmentBriefHash || '') || hashText(row.developmentBrief) !== row.developmentBriefHash
      || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) throw snapshotError('INVALID_SNAPSHOT');
  }
  if (new Set(value.proposals.map(row => row.id)).size !== value.proposals.length
    || value.participantCount !== new Set(value.proposals.map(row => row.participantId)).size
    || digest(value.proposals) !== value.proposalDigest || digest(metadata(value)) !== value.snapshotDigest) {
    throw snapshotError('INVALID_SNAPSHOT');
  }
  return value;
}

export async function readSnapshot(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw snapshotError('INVALID_SNAPSHOT');
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw snapshotError('INVALID_SNAPSHOT'); }
  return validateSnapshot(value);
}

function bindingState(state) {
  if (state?.allowed !== true) return state;
  if (state.snapshot?.bindingsChecked !== true || state.snapshot?.allBindingsMatch !== true) {
    return { ...state, allowed: false, blockedReason: 'safety_binding_unverified' };
  }
  return state;
}

export async function checkSnapshot(store, snapshot, { runId } = {}) {
  validateSnapshot(snapshot);
  const bindings = snapshotBindings(snapshot);
  const proposalIds = bindings.map(row => row.id);
  const parameters = { runId, proposalIds, bindings, roundId: snapshot.roundId };
  const state = await store.readWorkerState(parameters);
  if (state?.allowed !== true) return state;
  if (!proposalIds.length) return { ...state, allowed: false, blockedReason: 'no_eligible_proposals' };
  const checked = bindingState(state);
  if (checked.allowed !== true) return checked;
  const current = await store.listEligibleProposals({ roundId: snapshot.roundId, proposalIds });
  if (digest(snapshotRows(current)) !== snapshot.proposalDigest) {
    return { ...state, allowed: false, blockedReason: 'snapshot_changed' };
  }
  // The last DB read checks complete bindings, not just IDs. Approval/edit changes
  // between the body read and this checkpoint must close the gate as well.
  return bindingState(await store.readWorkerState(parameters));
}

export function safeIntakeCounts(counts) {
  const fields = ['total', 'eligible', 'pendingSafety', 'heldSafety', 'blockedSafety', 'approvedSafety'];
  if (!counts || fields.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)
    || fields.some(key => counts[key] > counts.total)
    || counts.eligible > counts.approvedSafety
    || counts.pendingSafety + counts.heldSafety + counts.blockedSafety + counts.approvedSafety !== counts.total) {
    throw snapshotError('STATE_UNAVAILABLE');
  }
  // Only aggregate facts are console output, even if a future store returns more.
  return Object.fromEntries(fields.map(key => [key, counts[key]]));
}

async function noApprovedInput(store) {
  const intake = safeIntakeCounts(await store.getProposalSafetyCounts({ roundId: 'initial' }));
  const blockedReason = intake.total === 0 ? 'no_proposals'
    : intake.eligible > 0 ? 'safety_inputs_changed'
      : intake.pendingSafety > 0 ? 'safety_review_pending'
        : intake.heldSafety > 0 ? 'safety_review_held'
          : intake.blockedSafety > 0 ? 'safety_review_blocked' : 'no_eligible_proposals';
  return { snapshotReady: false, releaseAllowed: false, blockedReason, intake };
}

export async function exportInitialRound({ client, store = createAdminStore(client),
  output = path.join(root, '.local', 'round-initial', 'snapshot.json'), databaseClockSql = DATABASE_NOW_SQL,
  privateRoot = PRIVATE_ROOT } = {}) {
  const gate = await store.readWorkerState();
  if (gate.allowed !== true) return { snapshotReady: false, releaseAllowed: false, blockedReason: gate.blockedReason || 'state_unavailable' };
  const clock = await client.execute(`SELECT ${databaseClockSql} AS now_ms`);
  const now = Number(clock.rows[0].now_ms);
  if (!Number.isFinite(now)) throw snapshotError('STATE_UNAVAILABLE');
  if (now < INITIAL_CUTOFF) return { snapshotReady: false, releaseAllowed: false, blockedReason: 'initial_collection_open' };
  await preparePrivateFile(output, { privateRoot });
  let existing;
  try { existing = await readSnapshot(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const proposals = snapshotRows(await store.listEligibleProposals({ roundId: 'initial' }));
  if (!proposals.length) return noApprovedInput(store);
  if (existing && (existing.roundId !== 'initial' || existing.proposalDigest !== digest(proposals))) {
    throw snapshotError('FROZEN_SNAPSHOT_CONFLICT');
  }
  const snapshot = existing || createSnapshot(proposals, { exportedAt: new Date(now).toISOString() });
  const beforeWrite = await checkSnapshot(store, snapshot);
  if (beforeWrite.allowed !== true) return { snapshotReady: false, releaseAllowed: false, blockedReason: beforeWrite.blockedReason || 'state_unavailable' };
  if (!existing) {
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw snapshotError('SNAPSHOT_TOO_LARGE');
    await preparePrivateFile(output, { privateRoot });
    await writeFile(output, serialized, { flag: 'wx', mode: 0o600 });
  }
  const verified = await checkSnapshot(store, snapshot);
  if (verified.allowed !== true) return { snapshotReady: false, releaseAllowed: false, blockedReason: verified.blockedReason || 'state_unavailable' };
  return { snapshotReady: true, releaseAllowed: false, schemaVersion: 2, policyVersion: SAFETY_POLICY_VERSION,
    alreadyExisted: Boolean(existing), proposalCount: proposals.length,
    proposalDigest: snapshot.proposalDigest, snapshotDigest: snapshot.snapshotDigest, path: '.local/round-initial/snapshot.json' };
}

async function main() {
  let client;
  try {
    client = await openDatabase(readConfig(), { initialize: false });
    await checkAdminSchema(client);
    const report = await exportInitialRound({ client });
    console.log(JSON.stringify(report));
    process.exitCode = report.snapshotReady ? 0 : 2;
  } catch (error) {
    const code = ['FROZEN_SNAPSHOT_CONFLICT', 'INVALID_SNAPSHOT', 'UNREVIEWED_SNAPSHOT', 'SNAPSHOT_POLICY_CHANGED', 'SNAPSHOT_TOO_LARGE'].includes(error.workerCode)
      ? error.workerCode : 'SNAPSHOT_UNAVAILABLE';
    console.error(JSON.stringify({ snapshotReady: false, releaseAllowed: false, error: code, existingSnapshotPreserved: true }));
    process.exitCode = 1;
  } finally { client?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
