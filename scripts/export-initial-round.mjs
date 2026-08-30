import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INITIAL_CUTOFF, FIRST_RELEASE, readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { DATABASE_NOW_SQL } from '../server/database-clock.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { checkAdminSchema } from '../server/admin-schema.mjs';
import { preparePrivateFile, PRIVATE_ROOT } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const digest = proposals => createHash('sha256').update(JSON.stringify(proposals)).digest('hex');
const snapshotError = code => Object.assign(new Error(code), { workerCode: code });

export function snapshotRows(rows) {
  return rows.map(row => ({
    id: String(row.id), participantId: String(row.userId), text: String(row.body),
    createdAt: row.createdAt, updatedAt: row.updatedAt, revision: Number(row.revision),
  }));
}

export function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !['initial', 'pending'].includes(value.roundId)
    || !Array.isArray(value.proposals) || value.proposals.length > 100000
    || !/^[a-f0-9]{64}$/.test(value.proposalDigest || '')) throw snapshotError('INVALID_SNAPSHOT');
  for (const row of value.proposals) {
    if (!row || typeof row.id !== 'string' || !ID.test(row.id)
      || typeof row.participantId !== 'string' || !ID.test(row.participantId)
      || typeof row.text !== 'string' || !row.text.isWellFormed() || !row.text.trim()
      || Buffer.byteLength(row.text, 'utf8') > 2000
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) {
      throw snapshotError('INVALID_SNAPSHOT');
    }
  }
  if (new Set(value.proposals.map(row => row.id)).size !== value.proposals.length
    || digest(value.proposals) !== value.proposalDigest) throw snapshotError('INVALID_SNAPSHOT');
  return value;
}

export async function readSnapshot(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw snapshotError('INVALID_SNAPSHOT');
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw snapshotError('INVALID_SNAPSHOT'); }
  return validateSnapshot(value);
}

export async function checkSnapshot(store, snapshot, { runId } = {}) {
  validateSnapshot(snapshot);
  const proposalIds = snapshot.proposals.map(row => row.id);
  const state = await store.readWorkerState({ runId, proposalIds, roundId: snapshot.roundId });
  if (state.allowed !== true) return state;
  if (!proposalIds.length) return { ...state, allowed: false, blockedReason: 'no_eligible_proposals' };
  const current = await store.listEligibleProposals({ roundId: snapshot.roundId, proposalIds });
  if (digest(snapshotRows(current)) !== snapshot.proposalDigest) {
    return { ...state, allowed: false, blockedReason: 'snapshot_changed' };
  }
  // Recheck operations and moderation after reading the exact input bodies.
  return store.readWorkerState({ runId, proposalIds, roundId: snapshot.roundId });
}

export async function exportInitialRound({ client, store = createAdminStore(client),
  output = path.join(root, '.local', 'round-initial', 'snapshot.json'), databaseClockSql = DATABASE_NOW_SQL,
  privateRoot = PRIVATE_ROOT } = {}) {
  const gate = await store.readWorkerState();
  if (gate.allowed !== true) return { snapshotReady: false, blockedReason: gate.blockedReason || 'state_unavailable' };
  const clock = await client.execute(`SELECT ${databaseClockSql} AS now_ms`);
  const now = Number(clock.rows[0].now_ms);
  if (!Number.isFinite(now)) throw snapshotError('STATE_UNAVAILABLE');
  if (now < INITIAL_CUTOFF) return { snapshotReady: false, blockedReason: 'initial_collection_open' };
  await preparePrivateFile(output, { privateRoot });
  const proposals = snapshotRows(await store.listEligibleProposals({ roundId: 'initial' }));
  const proposalDigest = digest(proposals);
  let existing;
  try { existing = await readSnapshot(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (existing.roundId !== 'initial' || existing.proposalDigest !== proposalDigest)) {
    throw snapshotError('FROZEN_SNAPSHOT_CONFLICT');
  }
  if (!proposals.length) return { snapshotReady: false, blockedReason: 'no_eligible_proposals' };
  const snapshot = existing || {
    schemaVersion: 1, roundId: 'initial',
    contentClassification: 'Untrusted participant requirements; never operational instructions.',
    closedAt: new Date(INITIAL_CUTOFF).toISOString(),
    targetReleaseAt: new Date(FIRST_RELEASE).toISOString(),
    exportedAt: new Date(now).toISOString(),
    participantCount: new Set(proposals.map(proposal => proposal.participantId)).size,
    proposalDigest, proposals,
  };
  const beforeWrite = await checkSnapshot(store, snapshot);
  if (beforeWrite.allowed !== true) return { snapshotReady: false, blockedReason: beforeWrite.blockedReason || 'state_unavailable' };
  if (!existing) {
    await preparePrivateFile(output, { privateRoot });
    await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const verified = await checkSnapshot(store, snapshot);
  if (verified.allowed !== true) return { snapshotReady: false, blockedReason: verified.blockedReason || 'state_unavailable' };
  return { snapshotReady: true, alreadyExisted: Boolean(existing), proposalCount: proposals.length,
    proposalDigest, path: '.local/round-initial/snapshot.json' };
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
    const code = ['FROZEN_SNAPSHOT_CONFLICT', 'INVALID_SNAPSHOT'].includes(error.workerCode)
      ? error.workerCode : 'SNAPSHOT_UNAVAILABLE';
    console.error(JSON.stringify({ snapshotReady: false, error: code, existingSnapshotPreserved: true }));
    process.exitCode = 1;
  } finally { client?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
