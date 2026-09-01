import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, link, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { INITIAL_CUTOFF, FIRST_DAILY_CUTOFF, DAY_MS, dailyCycleForDate } from '../server/daily-schedule.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { initializeAdminDatabase } from '../server/admin-schema.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { GAME_RELEASE_SCHEMA } from '../server/game-release-schema.mjs';
import { readSnapshot } from '../scripts/export-initial-round.mjs';
import { dailyCheckpoint, exportDailyRound, ensureDailyRun, ensureDailyCorrectionRun, parseDailyArguments } from '../scripts/daily-game-cycle.mjs';
import { backendFixture, TEST_CLOCK_SQL } from './backend-helpers.mjs';

async function fixture(t) {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF });
  await initializeAdminDatabase(f.client);
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-daily-cycle-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('yourgame-daily-cycle-'));
    await rm(target, { recursive: true, force: true });
  });
  const admin = createAdminStore(f.client, { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const output = join(directory, 'snapshot.json');
  const options = { client: f.client, store: admin, date: '2026-09-01', output, privateRoot: directory, databaseClockSql: TEST_CLOCK_SQL };
  return { ...f, admin, output, directory, options,
    export: (overrides = {}) => exportDailyRound({ ...options, ...overrides }),
    ensure: (overrides = {}) => ensureDailyRun({ client: f.client, date: options.date, workerId: 'daily-test-worker', databaseClockSql: TEST_CLOCK_SQL, ...overrides }),
    async proposal({ approved = true, body = 'PRIVATE_SYNTHETIC_ORIGINAL', time = f.now() } = {}) {
      await f.setTime(time);
      const account = await f.login(randomUUID());
      const result = await f.store.createProposal(account.session.user.id, { body, requestId: randomUUID() });
      if (approved) await this.review(result.proposal.id);
      return result.proposal;
    },
    async review(proposalId, { status = 'approved', brief = '검토한 합성 테스트 터치 이동 규칙' } = {}) {
      const anonymous = await f.store.createAnonymousSession();
      const account = await f.store.completeLogin(anonymous.session, {
        googleSub: 'daily-test-admin', email: ADMIN_EMAIL, emailVerified: true, name: '합성 검사 관리자',
      });
      const page = await admin.query(account.session, { section: 'proposals', limit: 100 });
      const row = page.items.find(item => item.id === proposalId);
      assert(row);
      return admin.mutate(account.session, {
        action: 'review_proposal_safety', requestId: randomUUID(), reason: '합성 테스트 입력 확인',
        proposalId, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
        policyVersion: SAFETY_POLICY_VERSION, revision: row.safety.revision,
        status, checklistConfirmed: status === 'approved', developmentBrief: status === 'approved' ? brief : '',
      });
    },
  };
}

test('checkpoint separates collection, 23:00 generation, and midnight without granting release authority', () => {
  assert.equal(dailyCheckpoint(INITIAL_CUTOFF - 1).phase, 'before_daily_start');
  const collecting = dailyCheckpoint(FIRST_DAILY_CUTOFF - 1);
  assert.equal(collecting.phase, 'collecting');
  assert.equal(collecting.currentCycle.cycleId, 'daily-2026-09-01');
  assert.equal(collecting.latestClosedCycle, null);
  const closed = dailyCheckpoint(FIRST_DAILY_CUTOFF);
  assert.equal(closed.phase, 'generation_window');
  assert.equal(closed.currentCycle.cycleId, 'daily-2026-09-02');
  assert.deepEqual(closed.latestClosedCycle, dailyCycleForDate('2026-09-01'));
  assert.equal(dailyCheckpoint(FIRST_DAILY_CUTOFF + 3599999).phase, 'generation_window');
  assert.equal(dailyCheckpoint(FIRST_DAILY_CUTOFF + 3600000).phase, 'release_due');
  assert.equal(dailyCheckpoint(FIRST_DAILY_CUTOFF + 3600000).releaseAllowed, false);
  for (const date of ['2026-12-31', '2028-02-29']) {
    const cycle = dailyCycleForDate(date);
    assert.deepEqual(dailyCheckpoint(Date.parse(cycle.closesAt)).latestClosedCycle, cycle);
  }
});

test('snapshot waits for database cutoff and active development without creating output', async t => {
  const f = await fixture(t);
  await f.proposal();
  await f.setTime(FIRST_DAILY_CUTOFF - 1);
  assert.equal((await f.export()).blockedReason, 'daily_collection_open');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await f.setTime(FIRST_DAILY_CUTOFF);
  await f.client.execute("UPDATE service_control SET mode = 'maintenance' WHERE id = 1");
  assert.equal((await f.export()).blockedReason, 'service_maintenance');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('snapshot binds only approved pending input inside exact immutable creation and edit bounds', async t => {
  const f = await fixture(t);
  const previous = await f.proposal({ time: INITIAL_CUTOFF - 1 });
  const first = await f.proposal({ time: INITIAL_CUTOFF });
  const pending = await f.proposal({ approved: false });
  const updatedAtClose = await f.proposal();
  const last = await f.proposal({ time: FIRST_DAILY_CUTOFF - 1 });
  const next = await f.proposal({ time: FIRST_DAILY_CUTOFF });
  await f.client.execute({ sql: 'UPDATE proposals SET updated_at = ? WHERE id = ?', args: [FIRST_DAILY_CUTOFF, updatedAtClose.id] });
  const report = await f.export();
  assert.equal(report.snapshotReady, true);
  assert.equal(report.proposalCount, 2);
  assert.equal(report.releaseAllowed, false);
  const snapshot = await readSnapshot(f.output);
  assert.deepEqual(snapshot.proposals.map(row => row.id), [first.id, last.id]);
  assert.equal(snapshot.closedAt, '2026-09-01T14:00:00.000Z');
  assert.equal(snapshot.targetReleaseAt, '2026-09-01T15:00:00.000Z');
  assert.equal(snapshot.roundId, 'pending');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal((await readFile(f.output, 'utf8')).includes('PRIVATE_SYNTHETIC_ORIGINAL'), false);
  assert.equal(JSON.stringify(report).includes('Hash'), false);
  assert.equal(JSON.stringify(report).includes('Digest'), false);
  assert.equal(JSON.stringify(report).includes('합성'), false);
  const rows = await f.client.execute('SELECT id,round_id FROM proposals');
  assert.equal(rows.rows.length, 6);
  assert.equal(rows.rows.find(row => row.id === previous.id).round_id, 'initial');
  for (const id of [first.id, last.id, pending.id, updatedAtClose.id, next.id]) assert.equal(rows.rows.find(row => row.id === id).round_id, 'pending');
});

test('empty and unreviewed daily intake is scoped to the date and never freezes empty input', async t => {
  const f = await fixture(t);
  await f.proposal({ time: FIRST_DAILY_CUTOFF, approved: false });
  let report = await f.export();
  assert.equal(report.blockedReason, 'no_proposals');
  assert.equal(report.intake.total, 0);
  const waiting = await f.proposal({ time: INITIAL_CUTOFF, approved: false });
  await f.setTime(FIRST_DAILY_CUTOFF);
  report = await f.export();
  assert.equal(report.blockedReason, 'safety_review_pending');
  assert.deepEqual(report.intake, { total: 1, eligible: 0, pendingSafety: 1, heldSafety: 0, blockedSafety: 0, approvedSafety: 0 });
  await f.review(waiting.id, { status: 'held' });
  assert.equal((await f.export()).blockedReason, 'safety_review_held');
  await f.review(waiting.id, { status: 'blocked' });
  assert.equal((await f.export()).blockedReason, 'safety_review_blocked');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('daily selection respects moderation and member suspension, and rejects incomplete binding reads', async t => {
  const f = await fixture(t);
  const keep = await f.proposal();
  const excluded = await f.proposal();
  const suspended = await f.proposal();
  await f.client.execute({ sql: "INSERT INTO proposal_moderation(proposal_id,moderation,reason,updated_at) VALUES (?,'excluded','synthetic exclusion',?)", args: [excluded.id, f.now()] });
  await f.client.execute({ sql: "UPDATE member_access SET status = 'suspended' WHERE user_id = (SELECT user_id FROM proposals WHERE id = ?)", args: [suspended.id] });
  await f.setTime(FIRST_DAILY_CUTOFF);
  await assert.rejects(f.export({ store: { ...f.admin, listEligibleProposals: async () => [] } }), error => error.workerCode === 'DAILY_INPUT_CHANGED');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  assert.equal((await f.export()).proposalCount, 1);
  assert.deepEqual((await readSnapshot(f.output)).proposals.map(row => row.id), [keep.id]);
});

test('same-cycle snapshot retries reuse exact bytes and new approval cannot change frozen membership', async t => {
  const f = await fixture(t);
  await f.proposal();
  const waiting = await f.proposal({ approved: false });
  await f.setTime(FIRST_DAILY_CUTOFF);
  assert.equal((await f.export()).alreadyExisted, false);
  const frozen = await readFile(f.output, 'utf8');
  await f.setTime(FIRST_DAILY_CUTOFF + 1000);
  assert.equal((await f.export()).alreadyExisted, true);
  assert.equal(await readFile(f.output, 'utf8'), frozen);
  await f.review(waiting.id);
  await assert.rejects(f.export(), error => error.workerCode === 'FROZEN_SNAPSHOT_CONFLICT');
  assert.equal(await readFile(f.output, 'utf8'), frozen);
});

for (const change of ['revocation', 'reapproval', 'different-cycle']) {
  test(`frozen snapshot survives ${change} without acquiring approval or replacement`, async t => {
    const f = await fixture(t);
    const proposal = await f.proposal();
    await f.setTime(FIRST_DAILY_CUTOFF);
    await f.export();
    const frozen = await readFile(f.output, 'utf8');
    if (change === 'revocation') await f.review(proposal.id, { status: 'held' });
    if (change === 'reapproval') await f.review(proposal.id, { brief: '다시 검토한 합성 방어 규칙' });
    if (change === 'different-cycle') await f.setTime(FIRST_DAILY_CUTOFF + DAY_MS);
    await assert.rejects(f.export(change === 'different-cycle' ? { date: '2026-09-02' } : {}), error => error.workerCode === 'FROZEN_SNAPSHOT_CONFLICT');
    assert.equal(await readFile(f.output, 'utf8'), frozen);
  });
}

for (const when of ['before', 'after']) {
  test(`snapshot rechecks service ${when} file creation and never reports approval after a pause`, async t => {
    const f = await fixture(t);
    await f.proposal();
    await f.setTime(FIRST_DAILY_CUTOFF);
    let reads = 0;
    const store = { ...f.admin, async readWorkerState(options) {
      reads += 1;
      if (reads === (when === 'before' ? 2 : 4)) await f.client.execute("UPDATE service_control SET development_enabled = 0 WHERE id = 1");
      return f.admin.readWorkerState(options);
    } };
    const report = await f.export({ store });
    assert.equal(report.snapshotReady, false);
    assert.equal(report.blockedReason, 'development_paused');
    if (when === 'before') await assert.rejects(readFile(f.output), { code: 'ENOENT' });
    else assert.equal((await readSnapshot(f.output)).proposals.length, 1);
  });
}

test('private snapshot paths reject escapes, directory links, and hard-linked output', async t => {
  const f = await fixture(t);
  await f.proposal();
  await f.setTime(FIRST_DAILY_CUTOFF);
  await assert.rejects(f.export({ output: join(f.directory, '..', 'outside.json') }), error => error.workerCode === 'INVALID_PRIVATE_FILE');
  await f.export();
  const hard = join(f.directory, 'hard.json');
  await link(f.output, hard);
  await assert.rejects(f.export({ output: hard }), error => error.workerCode === 'INVALID_PRIVATE_FILE');
  const actual = join(f.directory, 'actual');
  await mkdir(actual);
  await symlink(actual, join(f.directory, 'alias'), 'junction');
  await assert.rejects(f.export({ output: join(f.directory, 'alias', 'snapshot.json') }), error => error.workerCode === 'INVALID_PRIVATE_FILE');
});

test('daily run enqueue requires closed database time and eligible input then creates one audited deterministic run', async t => {
  const f = await fixture(t);
  assert.equal((await f.ensure()).blockedReason, 'daily_collection_open');
  await f.setTime(FIRST_DAILY_CUTOFF);
  assert.equal((await f.ensure()).blockedReason, 'no_proposals');
  const proposal = await f.proposal({ time: INITIAL_CUTOFF, approved: false });
  await f.setTime(FIRST_DAILY_CUTOFF);
  assert.equal((await f.ensure()).blockedReason, 'safety_review_pending');
  await f.review(proposal.id);
  const report = await f.ensure();
  assert.equal(report.created, true);
  assert.equal(report.runReady, true);
  assert.deepEqual(report.run, { id: 'daily-game-2026-09-01', status: 'queued', revision: 1, cancelRequested: false });
  assert.equal(report.releaseAllowed, false);
  assert.equal((await f.ensure()).created, false);
  assert.equal((await f.client.execute("SELECT COUNT(*) AS total FROM admin_audit WHERE action = 'worker_enqueue_daily'")).rows[0].total, 1);
});

test('concurrent duplicate requests enqueue once and a different active cycle blocks a parallel run', async t => {
  const f = await fixture(t);
  await f.proposal();
  await f.setTime(FIRST_DAILY_CUTOFF);
  const reports = await Promise.all([f.ensure(), f.ensure()]);
  assert.equal(reports.filter(report => report.created).length, 1);
  assert(reports.every(report => report.runReady));
  await f.proposal({ time: FIRST_DAILY_CUTOFF });
  await f.setTime(FIRST_DAILY_CUTOFF + DAY_MS);
  const report = await f.ensure({ date: '2026-09-02' });
  assert.equal(report.blockedReason, 'another_run_active');
  assert.equal(report.created, false);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS total FROM development_runs')).rows[0].total, 1);
});

test('a completed daily release can enqueue one correction bound to a newly approved immutable snapshot', async t => {
  const f = await fixture(t);
  for (const statement of GAME_RELEASE_SCHEMA) await f.client.execute(statement);
  await f.proposal();
  const late = await f.proposal({ approved: false });
  await f.setTime(FIRST_DAILY_CUTOFF);
  await f.export();
  const original = await readSnapshot(f.output);
  await f.ensure();
  await f.client.execute("UPDATE development_runs SET status='completed' WHERE id='daily-game-2026-09-01'");
  await f.client.execute("INSERT INTO admin_audit(id,created_at,action,target_id,reason,actor_name) VALUES ('release-audit',1,'test','daily-game-2026-09-01','test','test')");
  const h = '1'.repeat(64);
  await f.client.execute({ sql: `INSERT INTO game_release_reviews(id,request_id,operator_id,authorization_ref,run_id,candidate_id,
    policy_version,snapshot_digest,source_digest,assets_digest,game_version,content_sha256,runtime_digest,evidence_digest,
    worker_id,run_revision,service_revision,round_id,bindings_digest,release_digest,payload_digest,audit_id,created_at)
    VALUES ('release-review','release-request','operator','authorization','daily-game-2026-09-01','candidate',?,?,?,?,?,?,?,?,
      'worker',1,1,'pending',?,?,?,'release-audit',1)`,
    args: [SAFETY_POLICY_VERSION, original.snapshotDigest, h, h, 'v1', h, h, h, h, h, h] });
  await f.review(late.id);
  const correctionFile = join(f.directory, 'correction.json');
  await f.export({ output: correctionFile });
  const correction = await readSnapshot(correctionFile);
  await f.setTime(FIRST_DAILY_CUTOFF + 3600000);
  const report = await ensureDailyCorrectionRun({ client: f.client, date: '2026-09-01', workerId: 'daily-test-worker',
    snapshot: correction, databaseClockSql: TEST_CLOCK_SQL });
  assert.equal(report.created, true);
  assert.equal(report.runReady, true);
  assert.equal(report.run.status, 'queued');
  assert.match(report.run.id, /^daily-correction-20260901-/);
  assert.equal((await f.client.execute("SELECT COUNT(*) AS total FROM admin_audit WHERE action='worker_enqueue_daily_correction'")).rows[0].total, 1);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`daily run ${status} remains terminal across retries`, async t => {
    const f = await fixture(t);
    await f.proposal();
    await f.setTime(FIRST_DAILY_CUTOFF);
    await f.ensure();
    await f.client.execute({ sql: 'UPDATE development_runs SET status = ?, revision = 8 WHERE id = ?', args: [status, 'daily-game-2026-09-01'] });
    const report = await f.ensure();
    assert.equal(report.runReady, false);
    assert.equal(report.blockedReason, 'cycle_terminal');
    assert.equal(report.created, false);
    assert.equal(report.run.status, status);
    assert.equal(report.run.revision, 8);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS total FROM admin_audit WHERE action = 'worker_enqueue_daily'")).rows[0].total, 1);
  });
}

test('transactional service gate and subsequent input revocation prevent run readiness', async t => {
  const f = await fixture(t);
  const proposal = await f.proposal();
  await f.setTime(FIRST_DAILY_CUTOFF);
  const gatedClient = { async batch(...args) {
    await f.client.execute('UPDATE service_control SET development_enabled = 0 WHERE id = 1');
    return f.client.batch(...args);
  } };
  assert.equal((await f.ensure({ client: gatedClient })).blockedReason, 'development_paused');
  assert.equal((await f.client.execute('SELECT COUNT(*) AS total FROM development_runs')).rows[0].total, 0);
  await f.client.execute('UPDATE service_control SET development_enabled = 1 WHERE id = 1');
  await f.ensure();
  await f.review(proposal.id, { status: 'held' });
  assert.equal((await f.ensure()).blockedReason, 'no_eligible_proposals');
  assert.equal((await f.client.execute('SELECT status FROM development_runs')).rows[0].status, 'queued');
});

test('CLI accepts explicit date/status/snapshot/ensure options and rejects implicit writes or duplicate options', () => {
  assert.deepEqual(parseDailyArguments(['date']), { command: 'date' });
  assert.deepEqual(parseDailyArguments(['status', '--date', '2026-09-01']), { command: 'status', date: '2026-09-01' });
  assert.equal(parseDailyArguments(['snapshot', '--date', '2026-09-01', '--output', '.local/daily/snapshot.json']).output, '.local/daily/snapshot.json');
  assert.equal(parseDailyArguments(['ensure', '--date', '2026-09-01', '--worker-id', 'test-worker'])['worker-id'], 'test-worker');
  assert.equal(parseDailyArguments(['ensure-correction', '--date', '2026-09-01', '--worker-id', 'test-worker', '--snapshot', '.local/correction.json']).snapshot, '.local/correction.json');
  for (const argv of [[], ['snapshot'], ['ensure', '--date', '2026-09-01'], ['status', '--output', 'x'], ['status', '--date', '2026-09-01', '--date', '2026-09-02'], ['delete'], ['snapshot', '--date=2026-09-01']]) {
    assert.throws(() => parseDailyArguments(argv), error => error.workerCode === 'INVALID_ARGUMENTS');
  }
});
