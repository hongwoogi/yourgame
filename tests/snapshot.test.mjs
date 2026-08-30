import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { initializeAdminDatabase } from '../server/admin-schema.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { checkSnapshot, createSnapshot, exportInitialRound, readSnapshot, snapshotBindings, snapshotRows, validateSnapshot } from '../scripts/export-initial-round.mjs';
import { preparePrivateFile } from '../scripts/private-records.mjs';
import { backendFixture, TEST_CLOCK_SQL } from './backend-helpers.mjs';

async function fixture(t) {
  const f = await backendFixture(t);
  await initializeAdminDatabase(f.client);
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-snapshot-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('yourgame-snapshot-'));
    await rm(target, { recursive: true, force: true });
  });
  const store = createAdminStore(f.client, { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const output = join(directory, 'snapshot.json');
  return { ...f, admin: store, output, directory,
    async review(proposalId, { status = 'approved', brief = '세로 화면에서 터치로 이동하는 로그라이크 조작' } = {}) {
      // Synthetic verified identity, in-memory DB only. No real Google account.
      const anonymous = await f.store.createAnonymousSession();
      const admin = await f.store.completeLogin(anonymous.session, {
        googleSub: 'snapshot-test-admin', email: ADMIN_EMAIL, emailVerified: true, name: '검사 관리자',
      });
      const page = await store.query(admin.session, { section: 'proposals', limit: 100 });
      const row = page.items.find(item => item.id === proposalId);
      assert(row, 'synthetic proposal must exist');
      return store.mutate(admin.session, {
        action: 'review_proposal_safety', requestId: randomUUID(), reason: '현재 본문을 확인한 합성 테스트 심사',
        proposalId, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
        policyVersion: SAFETY_POLICY_VERSION, revision: row.safety.revision,
        status, checklistConfirmed: status === 'approved', developmentBrief: status === 'approved' ? brief : '',
      });
    },
    export: () => exportInitialRound({ client: f.client, store, output, privateRoot: directory, databaseClockSql: TEST_CLOCK_SQL }) };
}

test('initial export refuses an open collection and intentional service closure without creating a file', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.export(), { snapshotReady: false, releaseAllowed: false, blockedReason: 'initial_collection_open' });
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await f.setTime(INITIAL_CUTOFF);
  await f.client.execute("UPDATE service_control SET mode = 'ended', proposals_enabled = 0, development_enabled = 0 WHERE id = 1");
  assert.deepEqual(await f.export(), { snapshotReady: false, releaseAllowed: false, blockedReason: 'service_ended' });
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('export excludes moderated and suspended input, preserves originals, and never overwrites a stale frozen snapshot', async t => {
  const f = await fixture(t);
  const one = await f.login('12345678901');
  const two = await f.login('12345678902');
  const keep = await f.store.createProposal(one.session.user.id, { body: '세로 화면 터치 조작', requestId: 'snapshot-keep' });
  const excluded = await f.store.createProposal(one.session.user.id, { body: 'excluded original', requestId: 'snapshot-exclude' });
  const suspended = await f.store.createProposal(two.session.user.id, { body: 'suspended original', requestId: 'snapshot-suspend' });
  for (const proposal of [keep, excluded, suspended]) await f.review(proposal.proposal.id);
  await f.client.execute({
    sql: "INSERT INTO proposal_moderation(proposal_id, moderation, reason, updated_at) VALUES (?, 'excluded', 'test exclusion', ?)",
    args: [excluded.proposal.id, f.now()],
  });
  await f.client.execute({ sql: "UPDATE member_access SET status = 'suspended' WHERE user_id = ?", args: [two.session.user.id] });
  await f.setTime(INITIAL_CUTOFF);
  const exported = await f.export();
  assert.equal(exported.snapshotReady, true);
  assert.equal(exported.releaseAllowed, false);
  assert.equal(exported.proposalCount, 1);
  const frozen = await readFile(f.output, 'utf8');
  const snapshot = await readSnapshot(f.output);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.policyVersion, SAFETY_POLICY_VERSION);
  assert.equal(snapshot.proposals[0].id, keep.proposal.id);
  assert.equal(snapshot.proposals[0].developmentBrief, '세로 화면에서 터치로 이동하는 로그라이크 조작');
  assert.equal(Object.hasOwn(snapshot.proposals[0], 'body'), false);
  assert.equal(frozen.includes('세로 화면 터치 조작'), false);
  assert.equal(frozen.includes('excluded original'), false);
  assert.equal(frozen.includes('suspended original'), false);
  assert.equal(snapshotBindings(snapshot)[0].bodyHash,
    createHash('sha256').update('세로 화면 터치 조작').digest('hex'));
  assert.equal((await f.export()).alreadyExisted, true);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS count FROM proposals')).rows[0].count, 3);
  await f.client.execute({
    sql: "INSERT INTO proposal_moderation(proposal_id, moderation, reason, updated_at) VALUES (?, 'excluded', 'later exclusion', ?)",
    args: [keep.proposal.id, f.now()],
  });
  const gate = await checkSnapshot(f.admin, snapshot);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'snapshot_ineligible');
  assert.equal((await f.export()).snapshotReady, false);
  assert.equal(await readFile(f.output, 'utf8'), frozen);
});

test('changed proposal bodies and corrupt digests cannot pass a later worker gate', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const accepted = await f.store.createProposal(account.session.user.id, { body: 'original input', requestId: 'snapshot-original' });
  await f.review(accepted.proposal.id);
  await f.setTime(INITIAL_CUTOFF);
  await f.export();
  const snapshot = await readSnapshot(f.output);
  assert.throws(() => validateSnapshot({ ...snapshot, proposalDigest: '0'.repeat(64) }), error => error.workerCode === 'INVALID_SNAPSHOT');
  // Simulate a storage-level body change: ID presence alone must not validate input.
  await f.client.execute({ sql: 'UPDATE proposals SET body = ?, revision = revision + 1 WHERE id = ?', args: ['changed input', accepted.proposal.id] });
  const gate = await checkSnapshot(f.admin, snapshot);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'snapshot_ineligible');
});

test('database/control read failure does not produce a ready snapshot', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  await assert.rejects(exportInitialRound({ client: f.client, output: f.output,
    store: { readWorkerState: async () => { throw new Error('private database diagnostic'); } } }));
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('zero proposals is distinguished from pending safety reviews without freezing an empty snapshot', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  const report = await f.export();
  assert.equal(report.snapshotReady, false);
  assert.equal(report.blockedReason, 'no_proposals');
  assert.equal(report.intake.total, 0);
  assert.equal(report.releaseAllowed, false);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('waiting safety reviews are reported separately and only reviewed briefs become development input', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const proposal = await f.store.createProposal(account.session.user.id, {
    body: 'PRIVATE_ORIGINAL: 작은 방을 이동하며 도구를 찾는 게임', requestId: 'snapshot-pending',
  });
  await f.setTime(INITIAL_CUTOFF);
  const waiting = await f.export();
  assert.equal(waiting.snapshotReady, false);
  assert.equal(waiting.releaseAllowed, false);
  assert.equal(waiting.blockedReason, 'safety_review_pending');
  assert.deepEqual(waiting.intake, { total: 1, eligible: 0, pendingSafety: 1, heldSafety: 0, blockedSafety: 0, approvedSafety: 0 });
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await f.review(proposal.proposal.id, { brief: '작은 방을 이동하며 도구를 찾아 사용하는 게임 규칙' });
  const approved = await f.export();
  assert.equal(approved.snapshotReady, true);
  assert.equal(approved.releaseAllowed, false);
  assert.equal((await readSnapshot(f.output)).proposals[0].developmentBrief, '작은 방을 이동하며 도구를 찾아 사용하는 게임 규칙');
  assert.equal((await readFile(f.output, 'utf8')).includes('PRIVATE_ORIGINAL'), false);
  assert.equal(JSON.stringify(approved).includes('작은 방'), false);
});

for (const status of ['held', 'blocked']) {
  test(`${status} safety input is never exported or mistaken for no proposals`, async t => {
    const f = await fixture(t);
    const account = await f.login();
    const proposal = await f.store.createProposal(account.session.user.id, { body: '내용 확인이 필요한 제안', requestId: `snapshot-${status}` });
    await f.review(proposal.proposal.id, { status });
    await f.setTime(INITIAL_CUTOFF);
    const report = await f.export();
    assert.equal(report.snapshotReady, false);
    assert.equal(report.blockedReason, `safety_review_${status}`);
    assert.equal(report.intake.total, 1);
    assert.equal(report.intake.eligible, 0);
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  });
}

test('reapproval of the same body changes its exact review binding and cannot overwrite the frozen snapshot', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const proposal = await f.store.createProposal(account.session.user.id, { body: '같은 원문 유지', requestId: 'snapshot-reapprove' });
  await f.review(proposal.proposal.id, { brief: '첫 번째로 검토한 터치 이동 규칙' });
  await f.setTime(INITIAL_CUTOFF);
  await f.export();
  const frozen = await readFile(f.output, 'utf8');
  const snapshot = await readSnapshot(f.output);
  await f.review(proposal.proposal.id, { brief: '다시 검토한 터치 이동 규칙' });
  const state = await checkSnapshot(f.admin, snapshot);
  assert.equal(state.snapshot.allEligible, true);
  assert.equal(state.snapshot.bindingsChecked, true);
  assert.equal(state.snapshot.allBindingsMatch, false);
  assert.equal(state.allowed, false);
  assert.equal(state.blockedReason, 'safety_binding_changed');
  await assert.rejects(f.export(), error => error.workerCode === 'FROZEN_SNAPSHOT_CONFLICT');
  assert.equal(await readFile(f.output, 'utf8'), frozen);
});

test('approval revocation and database policy changes invalidate previously approved snapshots', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const proposal = await f.store.createProposal(account.session.user.id, { body: '원문은 보존할 제안', requestId: 'snapshot-revoke' });
  await f.review(proposal.proposal.id);
  await f.setTime(INITIAL_CUTOFF);
  await f.export();
  const frozen = await readFile(f.output, 'utf8');
  const snapshot = await readSnapshot(f.output);
  await f.review(proposal.proposal.id, { status: 'held' });
  assert.equal((await checkSnapshot(f.admin, snapshot)).allowed, false);
  assert.equal((await f.export()).blockedReason, 'safety_review_held');
  await f.review(proposal.proposal.id);
  await f.client.execute("UPDATE safety_meta SET value = 'teen-future-test' WHERE key = 'policy_version'");
  assert.equal((await checkSnapshot(f.admin, snapshot)).allowed, false);
  assert.equal(await readFile(f.output, 'utf8'), frozen);
  assert.equal((await f.client.execute({ sql: 'SELECT body FROM proposals WHERE id = ?', args: [proposal.proposal.id] })).rows[0].body, '원문은 보존할 제안');
});

test('legacy snapshots never acquire implicit approval and are preserved even when the new intake is empty', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  const legacy = `${JSON.stringify({ schemaVersion: 1, proposals: [{ body: 'PRIVATE_LEGACY_ORIGINAL' }] })}\n`;
  await writeFile(f.output, legacy);
  await assert.rejects(f.export(), error => error.workerCode === 'UNREVIEWED_SNAPSHOT');
  assert.equal(await readFile(f.output, 'utf8'), legacy);
});

test('a normal participant edit invalidates its earlier approval before a round can be frozen', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const proposal = await f.store.createProposal(account.session.user.id, { body: '변경 전 이동 규칙', requestId: 'snapshot-edit' });
  await f.review(proposal.proposal.id);
  const old = createSnapshot(snapshotRows(await f.admin.listEligibleProposals({ roundId: 'initial' })),
    { exportedAt: new Date(INITIAL_CUTOFF).toISOString() });
  await f.setTime(f.now() + 4000);
  await f.store.editProposal(account.session.user.id, { id: proposal.proposal.id, revision: proposal.proposal.revision, body: '변경 후 이동 규칙' });
  await f.setTime(INITIAL_CUTOFF);
  assert.equal((await checkSnapshot(f.admin, old)).allowed, false);
  const report = await f.export();
  assert.equal(report.blockedReason, 'safety_review_pending');
  assert.equal(report.intake.pendingSafety, 1);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('uncertain intake counts fail closed and future private fields never enter aggregate reports', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  const counts = { total: 1, eligible: 0, pendingSafety: 1, heldSafety: 0, blockedSafety: 0, approvedSafety: 0 };
  const exportWithCounts = values => exportInitialRound({ client: f.client, output: f.output,
    privateRoot: f.directory, databaseClockSql: TEST_CLOCK_SQL,
    store: { readWorkerState: async () => ({ allowed: true }), listEligibleProposals: async () => [],
      getProposalSafetyCounts: async () => values } });
  await assert.rejects(exportWithCounts({ ...counts, pendingSafety: undefined }), error => error.workerCode === 'STATE_UNAVAILABLE');
  await assert.rejects(exportWithCounts({ ...counts, blockedSafety: 1 }), error => error.workerCode === 'STATE_UNAVAILABLE');
  const report = await exportWithCounts({ ...counts, body: 'PRIVATE_BODY_SHOULD_NOT_PRINT' });
  assert.deepEqual(report.intake, counts);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('snapshot validation binds metadata and each approved summary and rejects body fields or self-declared approval', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const rows = snapshotRows([{ id: 'proposal-test', userId: 'participant-test', roundId: 'initial',
    createdAt: '2026-08-31T14:00:00.000Z', updatedAt: '2026-08-31T14:00:00.000Z', revision: 1,
    bodyHash: hash('PRIVATE_ORIGINAL'), policyVersion: SAFETY_POLICY_VERSION, safetyReviewId: 'safety-review-test', safetyRevision: 2,
    developmentBrief: '검토한 이동 규칙', developmentBriefHash: hash('검토한 이동 규칙') }]);
  const snapshot = createSnapshot(rows, { exportedAt: new Date(INITIAL_CUTOFF).toISOString() });
  const invalid = value => assert.throws(() => validateSnapshot(value), error => error.workerCode === 'INVALID_SNAPSHOT');
  invalid({ ...snapshot, approved: true });
  invalid({ ...snapshot, participantCount: 8 });
  invalid({ ...snapshot, exportedAt: '2026-09-03T00:00:00.000Z' });
  invalid({ ...snapshot, proposals: [{ ...rows[0], body: 'unreviewed source' }] });
  invalid({ ...snapshot, proposals: [{ ...rows[0], developmentBrief: '다른 요구사항' }] });
  invalid({ ...snapshot, proposals: [{ ...rows[0], safetyRevision: 3 }] });
  assert.throws(() => validateSnapshot({ ...snapshot, policyVersion: 'teen-old' }), error => error.workerCode === 'SNAPSHOT_POLICY_CHANGED');
  assert.throws(() => createSnapshot([{ ...rows[0], developmentBrief: '가'.repeat(667), developmentBriefHash: hash('가'.repeat(667)) }],
    { exportedAt: new Date(INITIAL_CUTOFF).toISOString() }), error => error.workerCode === 'INVALID_SNAPSHOT');
});

test('private-record parent junctions cannot redirect writes into public or external directories', async t => {
  const f = await fixture(t);
  const privateRoot = join(f.directory, 'private');
  const publicRoot = join(f.directory, 'public');
  await mkdir(privateRoot); await mkdir(publicRoot);
  await symlink(publicRoot, join(privateRoot, 'redirected'), 'junction');
  await assert.rejects(preparePrivateFile(join(privateRoot, 'redirected', 'snapshot.json'), { privateRoot }),
    error => error.workerCode === 'INVALID_PRIVATE_FILE');
  await assert.rejects(readFile(join(publicRoot, 'snapshot.json')), { code: 'ENOENT' });
});
