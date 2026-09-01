import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dailyCycleAt, dailyCycleForDate, FIRST_DAILY_CUTOFF } from '../server/daily-schedule.mjs';
import { readConfig } from '../server/config.mjs';
import { openDatabase, writeBatch } from '../server/database.mjs';
import { DATABASE_NOW_SQL } from '../server/database-clock.mjs';
import { createAdminStore, eligibleProposalSql } from '../server/admin-store.mjs';
import { checkAdminSchema } from '../server/admin-schema.mjs';
import { SAFETY_JOINS } from '../server/safety-store.mjs';
import { checkSnapshot, createSnapshot, readSnapshot, safeIntakeCounts, snapshotRows } from './export-initial-round.mjs';
import { PRIVATE_ROOT, preparePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { workerCode: code }); };
const blocked = reason => ({ snapshotReady: false, releaseAllowed: false, blockedReason: reason });
const runIdFor = date => 'daily-game-' + date;
const bounds = cycle => [Date.parse(cycle.opensAt), Date.parse(cycle.closesAt)];
const cycleWhere = `p.round_id = 'pending' AND p.created_at >= ? AND p.created_at < ?`;
const eligibleWhere = `${cycleWhere} AND p.updated_at < ? AND ${eligibleProposalSql()}`;

export function dailyCheckpoint(now = Date.now()) {
  const currentCycle = dailyCycleAt(now);
  const close = currentCycle && Date.parse(currentCycle.opensAt);
  const latestClosedCycle = close >= FIRST_DAILY_CUTOFF ? dailyCycleAt(close - 1) : null;
  return { currentCycle, latestClosedCycle, phase: !currentCycle ? 'before_daily_start' : !latestClosedCycle ? 'collecting'
    : now < Date.parse(latestClosedCycle.releaseAt) ? 'generation_window' : 'release_due', releaseAllowed: false };
}

async function databaseNow(client, databaseClockSql) {
  const result = await client.execute(`SELECT ${databaseClockSql} AS now_ms`);
  const now = Number(result.rows[0]?.now_ms);
  if (!Number.isSafeInteger(now)) fail('STATE_UNAVAILABLE');
  return now;
}
async function cycleIntake(client, cycle) {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN p.updated_at < ? AND ${eligibleProposalSql()} THEN 1 ELSE 0 END),0) AS eligible,
      COALESCE(SUM(CASE WHEN COALESCE(sr.status,'pending') = 'pending' THEN 1 ELSE 0 END),0) AS pending_safety,
      COALESCE(SUM(CASE WHEN sr.status = 'held' THEN 1 ELSE 0 END),0) AS held_safety,
      COALESCE(SUM(CASE WHEN sr.status = 'blocked' THEN 1 ELSE 0 END),0) AS blocked_safety,
      COALESCE(SUM(CASE WHEN sr.status = 'approved' THEN 1 ELSE 0 END),0) AS approved_safety
      FROM proposals p ${SAFETY_JOINS} WHERE ${cycleWhere}`,
    args: [Date.parse(cycle.closesAt), ...bounds(cycle)],
  });
  const row = result.rows[0];
  return safeIntakeCounts({ total: Number(row.total), eligible: Number(row.eligible), pendingSafety: Number(row.pending_safety),
    heldSafety: Number(row.held_safety), blockedSafety: Number(row.blocked_safety), approvedSafety: Number(row.approved_safety) });
}
function noInputReason(intake) {
  return !intake.total ? 'no_proposals' : intake.pendingSafety ? 'safety_review_pending' : intake.heldSafety ? 'safety_review_held'
    : intake.blockedSafety ? 'safety_review_blocked' : 'no_eligible_proposals';
}
async function cycleProposals(client, store, cycle) {
  const ids = await client.execute({ sql: `SELECT p.id FROM proposals p WHERE ${eligibleWhere} ORDER BY p.created_at, p.id`,
    args: [...bounds(cycle), Date.parse(cycle.closesAt)] });
  if (!ids.rows.length) return [];
  const proposals = snapshotRows(await store.listEligibleProposals({ roundId: 'pending', proposalIds: ids.rows.map(row => row.id) }));
  const [opensAt, closesAt] = bounds(cycle);
  if (proposals.length !== ids.rows.length || proposals.some((row, index) => row.id !== ids.rows[index].id
    || row.roundId !== 'pending' || Date.parse(row.createdAt) < opensAt
    || Date.parse(row.createdAt) >= closesAt || Date.parse(row.updatedAt) >= closesAt)) fail('DAILY_INPUT_CHANGED');
  return proposals;
}
function matchesCycle(snapshot, cycle) {
  const [opensAt, closesAt] = bounds(cycle);
  return snapshot.roundId === 'pending' && snapshot.closedAt === cycle.closesAt && snapshot.targetReleaseAt === cycle.releaseAt
    && snapshot.proposals.every(row => Date.parse(row.createdAt) >= opensAt && Date.parse(row.createdAt) < closesAt
      && Date.parse(row.updatedAt) < closesAt);
}
async function privateOutput(output, privateRoot) {
  const relativeInput = path.relative(path.resolve(privateRoot), path.resolve(output));
  if (!relativeInput || relativeInput.startsWith('..') || path.isAbsolute(relativeInput) || output.split(/[\\/]/).includes('..')
    || relativeInput.split(path.sep).some(part => /[\x00-\x1f\x7f:]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('INVALID_PRIVATE_FILE');
  const file = await preparePrivateFile(path.resolve(output), { privateRoot });
  const relative = path.relative(path.resolve(privateRoot), file);
  let cursor = path.resolve(privateRoot);
  for (const component of relative.split(path.sep)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || path.relative(cursor, await realpath(cursor)) !== '') fail('INVALID_PRIVATE_FILE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = path.join(cursor, component);
  }
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('INVALID_PRIVATE_FILE');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

export async function exportDailyRound({ client, store, date, output, databaseClockSql = DATABASE_NOW_SQL, privateRoot = PRIVATE_ROOT } = {}) {
  const cycle = dailyCycleForDate(date);
  store ||= createAdminStore(client, { databaseClockSql });
  const gate = await store.readWorkerState();
  if (gate.allowed !== true) return { cycleId: cycle.cycleId, ...blocked(gate.blockedReason || 'state_unavailable') };
  const now = await databaseNow(client, databaseClockSql);
  if (now < Date.parse(cycle.closesAt)) return { cycleId: cycle.cycleId, ...blocked('daily_collection_open') };
  const file = await privateOutput(output || path.join(privateRoot, 'daily-cycles', date, 'snapshot.json'), privateRoot);
  let existing;
  try { existing = await readSnapshot(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const proposals = await cycleProposals(client, store, cycle);
  if (existing && (!matchesCycle(existing, cycle) || existing.proposalDigest !== digest(proposals))) fail('FROZEN_SNAPSHOT_CONFLICT');
  if (!proposals.length) {
    const intake = await cycleIntake(client, cycle);
    return { cycleId: cycle.cycleId, ...blocked(noInputReason(intake)), intake };
  }
  let snapshot = existing || createSnapshot(proposals, { roundId: 'pending', closedAt: cycle.closesAt,
    targetReleaseAt: cycle.releaseAt, exportedAt: new Date(now).toISOString() });
  const before = await checkSnapshot(store, snapshot);
  if (before.allowed !== true) return { cycleId: cycle.cycleId, ...blocked(before.blockedReason || 'state_unavailable') };
  if (!existing) {
    const bytes = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) fail('SNAPSHOT_TOO_LARGE');
    await privateOutput(file, privateRoot);
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      existing = await readSnapshot(file);
      if (!matchesCycle(existing, cycle) || existing.proposalDigest !== snapshot.proposalDigest) fail('FROZEN_SNAPSHOT_CONFLICT');
      snapshot = existing;
    }
  }
  const after = await checkSnapshot(store, snapshot);
  if (after.allowed !== true) return { cycleId: cycle.cycleId, ...blocked(after.blockedReason || 'state_unavailable') };
  if (digest(await cycleProposals(client, store, cycle)) !== snapshot.proposalDigest) fail('FROZEN_SNAPSHOT_CONFLICT');
  const final = await checkSnapshot(store, snapshot);
  if (final.allowed !== true) return { cycleId: cycle.cycleId, ...blocked(final.blockedReason || 'state_unavailable') };
  return { cycleId: cycle.cycleId, snapshotReady: true, releaseAllowed: false, schemaVersion: 2,
    alreadyExisted: Boolean(existing), proposalCount: proposals.length,
    path: '.local/' + path.relative(privateRoot, file).split(path.sep).join('/') };
}

function safeRun(row) {
  return row ? { id: row.id, status: row.status, revision: Number(row.revision), cancelRequested: Number(row.cancel_requested) === 1 } : null;
}
export async function ensureDailyRun({ client, date, workerId, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  const cycle = dailyCycleForDate(date), id = runIdFor(date);
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(workerId)) fail('INVALID_WORKER_ID');
  const results = await writeBatch(client, [
    `SELECT *, ${databaseClockSql} AS now_ms FROM service_control WHERE id = 1`,
    { sql: `INSERT INTO development_runs(id,label,summary,status,created_at,updated_at,created_by)
        SELECT ?, '일일 게임 개발', '마감된 일일 회차의 승인 입력을 고정해 검토합니다. 공개 완료를 뜻하지 않습니다.',
          'queued', ${databaseClockSql}, ${databaseClockSql}, NULL
        WHERE ${databaseClockSql} >= ? AND EXISTS (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND development_enabled = 1)
          AND NOT EXISTS (SELECT 1 FROM development_runs WHERE status IN ('queued','running') AND id != ?)
          AND EXISTS (SELECT 1 FROM proposals p WHERE ${eligibleWhere})
        ON CONFLICT(id) DO NOTHING`, args: [id, Date.parse(cycle.closesAt), id, ...bounds(cycle), Date.parse(cycle.closesAt)] },
    { sql: `INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_name)
        SELECT ?, ${databaseClockSql}, 'worker_enqueue_daily', ?, '마감된 일일 개발 요청을 중복 없이 등록했습니다.', '작업자' WHERE changes() = 1`, args: [randomUUID(), id] },
    { sql: 'SELECT id,status,revision,cancel_requested FROM development_runs WHERE id = ?', args: [id] },
    `SELECT COUNT(*) AS active FROM development_runs WHERE status IN ('queued','running')`,
    { sql: `SELECT COUNT(*) AS eligible FROM proposals p WHERE ${eligibleWhere}`, args: [...bounds(cycle), Date.parse(cycle.closesAt)] },
  ]);
  const service = results[0].rows[0], run = safeRun(results[3].rows[0]);
  const serviceBlock = !service ? 'state_unavailable' : service.mode !== 'active' ? 'service_' + service.mode
    : Number(service.development_enabled) !== 1 ? 'development_paused' : null;
  if (run) {
    const reason = serviceBlock || (run.cancelRequested ? 'cancel_requested' : ['failed', 'completed', 'cancelled'].includes(run.status) ? 'cycle_terminal'
      : Number(service.now_ms) < Date.parse(cycle.closesAt) ? 'daily_collection_open'
        : Number(results[4].rows[0].active) > 1 ? 'another_run_active'
          : Number(results[5].rows[0].eligible) < 1 ? 'no_eligible_proposals' : null);
    return { cycleId: cycle.cycleId, runReady: !reason, created: results[1].rowsAffected === 1, run, releaseAllowed: false,
      ...(reason ? { blockedReason: reason } : {}) };
  }
  const blockedReason = serviceBlock || (Number(service.now_ms) < Date.parse(cycle.closesAt) ? 'daily_collection_open'
    : Number(results[4].rows[0].active) > 0 ? 'another_run_active' : noInputReason(await cycleIntake(client, cycle)));
  return { cycleId: cycle.cycleId, runReady: false, created: false, run: null, releaseAllowed: false, blockedReason };
}

export async function ensureDailyCorrectionRun({ client, date, workerId, snapshot, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  const cycle = dailyCycleForDate(date), parentId = runIdFor(date);
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(workerId)) fail('INVALID_WORKER_ID');
  if (!snapshot || !matchesCycle(snapshot, cycle)) fail('INVALID_SNAPSHOT');
  const store = createAdminStore(client, { databaseClockSql });
  const checked = await checkSnapshot(store, snapshot);
  if (checked.allowed !== true || digest(await cycleProposals(client, store, cycle)) !== snapshot.proposalDigest) fail('DAILY_INPUT_CHANGED');
  const id = `daily-correction-${date.replaceAll('-', '')}-${randomUUID()}`;
  const results = await writeBatch(client, [
    `SELECT *, ${databaseClockSql} AS now_ms FROM service_control WHERE id = 1`,
    { sql: `INSERT INTO development_runs(id,label,summary,status,created_at,updated_at,parent_id,created_by)
        SELECT ?, '일일 게임 교정 개발', '마감 뒤 안전 재심사로 확인된 누락 요구를 새 불변 버전으로 교정합니다. 공개 완료를 뜻하지 않습니다.',
          'queued', ${databaseClockSql}, ${databaseClockSql}, ?, NULL
        WHERE ${databaseClockSql} >= ?
          AND EXISTS (SELECT 1 FROM service_control WHERE id=1 AND mode='active' AND development_enabled=1)
          AND EXISTS (SELECT 1 FROM development_runs WHERE id=? AND status='completed' AND cancel_requested=0)
          AND EXISTS (SELECT 1 FROM game_release_reviews WHERE run_id=? AND snapshot_digest<>?)
          AND NOT EXISTS (SELECT 1 FROM game_release_reviews WHERE snapshot_digest=?)
          AND NOT EXISTS (SELECT 1 FROM development_runs WHERE status IN ('queued','running'))`,
      args: [id, parentId, Date.parse(cycle.releaseAt), parentId, parentId, snapshot.snapshotDigest, snapshot.snapshotDigest] },
    { sql: `INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_name)
        SELECT ?, ${databaseClockSql}, 'worker_enqueue_daily_correction', ?,
          '마감 후 안전 재심사로 확인된 누락 입력의 교정 개발을 등록했습니다.', '작업자' WHERE changes()=1`,
      args: [randomUUID(), id] },
    { sql: 'SELECT id,status,revision,cancel_requested FROM development_runs WHERE id=?', args: [id] },
    { sql: 'SELECT status,cancel_requested FROM development_runs WHERE id=?', args: [parentId] },
    `SELECT COUNT(*) AS active FROM development_runs WHERE status IN ('queued','running')`,
  ]);
  const service = results[0].rows[0], run = safeRun(results[3].rows[0]), parent = results[4].rows[0];
  const blockedReason = !service ? 'state_unavailable' : service.mode !== 'active' ? 'service_' + service.mode
    : Number(service.development_enabled) !== 1 ? 'development_paused'
      : Number(service.now_ms) < Date.parse(cycle.releaseAt) ? 'daily_release_not_due'
        : !parent || parent.status !== 'completed' || Number(parent.cancel_requested) !== 0 ? 'daily_parent_not_completed'
          : Number(results[5].rows[0].active) > (run ? 1 : 0) ? 'another_run_active'
            : run ? null : 'daily_correction_unavailable';
  return { cycleId: cycle.cycleId, runReady: Boolean(run) && !blockedReason, created: results[1].rowsAffected === 1,
    run, releaseAllowed: false, ...(blockedReason ? { blockedReason } : {}) };
}

export function parseDailyArguments(argv) {
  const [command, ...values] = argv;
  const allowed = { status: ['date'], date: ['date'], snapshot: ['date', 'output'], ensure: ['date', 'worker-id'],
    'ensure-correction': ['date', 'worker-id', 'snapshot'] };
  if (!Object.hasOwn(allowed, command) || values.length % 2) fail('INVALID_ARGUMENTS');
  const args = { command };
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index].replace(/^--/, ''), value = values[index + 1];
    if (!values[index].startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(args, key) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    args[key] = value;
  }
  if (args.date) dailyCycleForDate(args.date);
  if (['snapshot', 'ensure', 'ensure-correction'].includes(command) && !args.date) fail('INVALID_ARGUMENTS');
  if (['ensure', 'ensure-correction'].includes(command) && !args['worker-id']) fail('INVALID_ARGUMENTS');
  if (command === 'ensure-correction' && !args.snapshot) fail('INVALID_ARGUMENTS');
  return args;
}
async function main() {
  let client;
  try {
    const args = parseDailyArguments(process.argv.slice(2));
    if (args.command === 'date') {
      console.log(JSON.stringify(args.date ? { cycle: dailyCycleForDate(args.date), releaseAllowed: false } : dailyCheckpoint())); return;
    }
    client = await openDatabase(readConfig(), { initialize: false });
    await checkAdminSchema(client);
    let report;
    if (args.command === 'snapshot') report = await exportDailyRound({ client, date: args.date, output: args.output && path.resolve(root, args.output) });
    else if (args.command === 'ensure') report = await ensureDailyRun({ client, date: args.date, workerId: args['worker-id'] });
    else if (args.command === 'ensure-correction') report = await ensureDailyCorrectionRun({ client, date: args.date,
      workerId: args['worker-id'], snapshot: await readSnapshot(path.resolve(root, args.snapshot)) });
    else {
      const now = await databaseNow(client, DATABASE_NOW_SQL), checkpoint = dailyCheckpoint(now);
      const cycle = args.date ? dailyCycleForDate(args.date) : checkpoint.latestClosedCycle;
      const gate = await createAdminStore(client).readWorkerState();
      report = { ...checkpoint, allowed: gate.allowed === true, blockedReason: gate.blockedReason || null,
        ...(cycle ? { cycle, intake: await cycleIntake(client, cycle) } : {}) };
    }
    console.log(JSON.stringify(report));
    if (report.snapshotReady === false || report.runReady === false) process.exitCode = 2;
  } catch (error) {
    const permitted = ['INVALID_ARGUMENTS', 'INVALID_WORKER_ID', 'FROZEN_SNAPSHOT_CONFLICT', 'INVALID_SNAPSHOT', 'UNREVIEWED_SNAPSHOT',
      'SNAPSHOT_POLICY_CHANGED', 'SNAPSHOT_TOO_LARGE', 'INVALID_PRIVATE_FILE', 'DAILY_INPUT_CHANGED'];
    console.error(JSON.stringify({ ok: false, error: permitted.includes(error.workerCode) ? error.workerCode : 'DAILY_CYCLE_UNAVAILABLE', releaseAllowed: false, existingSnapshotPreserved: true }));
    process.exitCode = 1;
  } finally { client?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
