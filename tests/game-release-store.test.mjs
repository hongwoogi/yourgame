import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { initializeDatabase } from '../server/database.mjs';
import { createStore } from '../server/store.mjs';
import { activateCommunityPublicDefaults } from '../server/community-schema.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { prepareGameReleaseSchema } from '../server/game-release-schema.mjs';
import { createGameReleaseStore, RELEASE_BINDING_KEYS, verifyReleaseReview } from '../server/game-release-store.mjs';
import { errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const operation = (action, input) => ({ action, requestId: randomUUID(), reason: 'Synthetic release contract test', ...input });
const hash = digit => digit.repeat(64);
const bindingOf = row => Object.fromEntries(['id', 'revision', 'bodyHash', 'policyVersion', 'safetyReviewId',
  'safetyRevision', 'developmentBriefHash'].map(key => [key, row[key]]));

async function fixture(t, { prepare = true } = {}) {
  // Interactive libSQL transactions transfer their connection: use an actual
  // temporary file, not a bare :memory: DB which disappears on the next call.
  const directory = await mkdtemp(path.join(tmpdir(), 'yourgame-release-store-'));
  const client = createClient({ url: `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}` });
  t.after(async () => {
    client.close();
    for (const name of await readdir(directory)) {
      const target = path.resolve(directory, name);
      assert.equal(path.dirname(target), path.resolve(directory));
      try { await unlink(target); }
      catch (error) {
        // libSQL's transferred native transaction connections can retain the
        // Windows handle until process exit. Preserve this synthetic temp DB;
        // never hide any other cleanup failure or touch an external directory.
        if (process.platform === 'win32' && ['EBUSY', 'EPERM'].includes(error.code)) return;
        throw error;
      }
    }
    await rmdir(directory);
  });
  await client.execute('PRAGMA foreign_keys=ON');
  await initializeDatabase(client);
  const time = INITIAL_CUTOFF - 3600000;
  await client.execute('CREATE TABLE test_clock(id INTEGER PRIMARY KEY,now_ms INTEGER NOT NULL)');
  await client.execute({ sql: 'INSERT INTO test_clock VALUES (1,?)', args: [time] });
  await activateCommunityPublicDefaults(client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  const f = { client, store: createStore(client, { now: () => time, databaseClockSql: TEST_CLOCK_SQL }) };
  const anonymous = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anonymous.session, {
    googleSub: 'release-test-admin', name: 'Review fixture', email: ADMIN_EMAIL, emailVerified: true,
  });
  const member = await f.store.completeLogin((await f.store.createAnonymousSession()).session, {
    googleSub: 'release-fixture-member', name: 'Participant fixture',
  });
  const proposal = (await f.store.createProposal(member.session.user.id, {
    body: '터치로 움직이는 세로 판타지 탐험 게임', requestId: randomUUID(),
  })).proposal;
  const management = f.store.admin;
  const row = (await management.query(admin.session, { section: 'proposals' })).items.find(item => item.id === proposal.id);
  await management.mutate(admin.session, operation('review_proposal_safety', {
    proposalId: proposal.id, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
    policyVersion: row.safety.policyVersion, revision: row.safety.revision, status: 'approved',
    checklistConfirmed: true, developmentBrief: '터치와 키보드로 탐험하는 세로 판타지 게임',
  }));
  const bindings = (await management.listEligibleProposals({ roundId: row.roundId, proposalIds: [proposal.id] })).map(bindingOf);
  const run = await management.mutate(admin.session, operation('create_version', { label: 'Fixture run', summary: 'Synthetic output review' }));
  const workerId = 'release-fixture-worker';
  const running = await management.claimRun({ id: run.targetId, revision: 1, workerId });
  const serviceRevision = (await management.getService()).revision;
  if (prepare) await prepareGameReleaseSchema(f.client, { expectedServiceRevision: serviceRevision });
  const review = {
    id: randomUUID(), requestId: randomUUID(), operatorId: 'fixture-operator', authorizationRef: 'fixture:authorization',
    runId: running.id, candidateId: 'candidate-fixture', policyVersion: 'teen-v1', snapshotDigest: hash('a'),
    sourceDigest: hash('b'), assetsDigest: hash('c'), gameVersion: 'fixture-v1', contentSha256: hash('d'),
    runtimeDigest: hash('e'), evidenceDigest: hash('f'), workerId, runRevision: running.revision,
    serviceRevision, roundId: row.roundId, bindings,
  };
  const releaseBinding = Object.fromEntries(RELEASE_BINDING_KEYS.map(key => [key, review[key]]));
  const completed = { id: running.id, revision: running.revision, workerId, status: 'completed',
    releaseReviewId: review.id, releaseBinding, bindings, roundId: row.roundId, serviceRevision };
  return { ...f, admin, management, member, review, completed,
    releases: createGameReleaseStore(f.client, { databaseClockSql: TEST_CLOCK_SQL }) };
}

test('preparation is additive, idempotent, and rejects stale or disabled service controls', async t => {
  const f = await fixture(t, { prepare: false });
  const before = await f.client.execute('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM proposals) AS proposals');
  await assert.rejects(prepareGameReleaseSchema(f.client, { expectedServiceRevision: 999 }), errorCode('WORKER_BLOCKED'));
  assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='game_release_reviews'")).rows[0].n, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await prepareGameReleaseSchema(f.client, { expectedServiceRevision: f.review.serviceRevision }),
      { prepared: true, schemaVersion: 1, serviceRevision: f.review.serviceRevision, pointsIssued: false });
  }
  assert.deepEqual((await f.client.execute('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM proposals) AS proposals')).rows, before.rows);
  await f.client.execute('UPDATE service_control SET development_enabled=0 WHERE id=1');
  await assert.rejects(prepareGameReleaseSchema(f.client, { expectedServiceRevision: f.review.serviceRevision }), errorCode('WORKER_BLOCKED'));
});

test('trusted issuance is immutable, exact-replay idempotent, and separately audited without publication or points', async t => {
  const f = await fixture(t);
  const receipt = await f.releases.issueReview(f.review);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.gamePublished, false);
  assert.equal(receipt.pointsIssued, false);
  assert.deepEqual(receipt.releaseBinding, f.completed.releaseBinding);
  assert.equal((await f.releases.issueReview(f.review)).replayed, true);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM game_release_reviews')).rows[0].n, 1);
  const audit = (await f.client.execute("SELECT actor_user_id,actor_name,reason FROM admin_audit WHERE action='operator_review_game_release'")).rows[0];
  assert.equal(audit.actor_user_id, null);
  assert.equal(audit.actor_name, 'codex-delegated:fixture-operator');
  assert.match(audit.reason, /^[a-f0-9]{64}$/);
  await assert.rejects(f.releases.issueReview({ ...f.review, evidenceDigest: hash('1') }), errorCode('RELEASE_REVIEW_CONFLICT'));
  await assert.rejects(f.client.execute('UPDATE game_release_reviews SET runtime_digest=runtime_digest'));
  await assert.rejects(f.client.execute('DELETE FROM game_release_reviews'));
  assert.equal((await f.management.readWorkerState({ runId: f.review.runId })).run.status, 'running');
});

test('receipt lookup rejects missing infrastructure, missing receipt, and every changed content/runtime binding', async t => {
  const f = await fixture(t, { prepare: false });
  const expected = { reviewId: f.review.id, runId: f.review.runId, ...f.completed.releaseBinding };
  await assert.rejects(verifyReleaseReview(f.client, expected), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  await prepareGameReleaseSchema(f.client, { expectedServiceRevision: f.review.serviceRevision });
  await assert.rejects(verifyReleaseReview(f.client, expected), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  await f.releases.issueReview(f.review);
  for (const key of RELEASE_BINDING_KEYS) {
    const changed = ['candidateId', 'gameVersion'].includes(key) ? 'different-version' : key === 'policyVersion' ? 'teen-old' : hash('9');
    await assert.rejects(verifyReleaseReview(f.client, { ...expected, [key]: changed }), errorCode('RELEASE_REVIEW_UNAVAILABLE'), key);
  }
  assert.equal((await verifyReleaseReview(f.client, expected)).reviewId, f.review.id);
});

test('issuer rejects self-approval fields, empty/duplicate inputs, stale ownership and current safety changes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.releases.issueReview({ ...f.review, approved: true }), errorCode('INVALID_RELEASE_REVIEW'));
  for (const bindings of [[], [...f.review.bindings, ...f.review.bindings]]) {
    await assert.rejects(f.releases.issueReview({ ...f.review, bindings }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  }
  for (const overrides of [{ workerId: 'another-worker' }, { runRevision: 999 }, { serviceRevision: 999 }]) {
    await assert.rejects(f.releases.issueReview({ ...f.review, ...overrides }), errorCode('WORKER_BLOCKED'));
  }
  await f.client.execute({ sql: "UPDATE proposal_safety_reviews SET status='held',revision=revision+1 WHERE id=?", args: [f.review.bindings[0].safetyReviewId] });
  await assert.rejects(f.releases.issueReview(f.review), errorCode('WORKER_BLOCKED'));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM game_release_reviews')).rows[0].n, 0);
});

test('a current exact trusted receipt permits only work completion; ordinary booleans remain blocked', async t => {
  const f = await fixture(t);
  await assert.rejects(f.management.updateRun({ ...f.completed, releaseReviewId: undefined, approved: true }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  await f.releases.issueReview(f.review);
  for (const overrides of [{ bindings: [] }, { roundId: undefined }, { serviceRevision: undefined }, { releaseBinding: { ...f.completed.releaseBinding, approved: true } }]) {
    await assert.rejects(f.management.updateRun({ ...f.completed, ...overrides }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  }
  const completed = await f.management.updateRun(f.completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.revision, f.review.runRevision + 1);
  assert.equal((await f.releases.issueReview(f.review)).replayed, true);
  await assert.rejects(f.store.contribution.settle({ releaseReviewId: f.review.id }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
});

test('a stored receipt cannot complete a stale or withdrawn input, stopped service, or cancelled run', async t => {
  for (const change of [
    f => f.client.execute({ sql: "UPDATE proposal_safety_reviews SET status='held',revision=revision+1 WHERE id=?", args: [f.review.bindings[0].safetyReviewId] }),
    f => f.client.execute('UPDATE service_control SET revision=revision+1 WHERE id=1'),
    f => f.client.execute('UPDATE service_control SET development_enabled=0 WHERE id=1'),
    f => f.client.execute({ sql: 'UPDATE development_runs SET cancel_requested=1 WHERE id=?', args: [f.review.runId] }),
    f => f.client.execute({ sql: "UPDATE member_access SET status='suspended' WHERE user_id=?", args: [f.member.session.user.id] }),
  ]) {
    const f = await fixture(t);
    await f.releases.issueReview(f.review);
    await change(f);
    await assert.rejects(f.management.updateRun(f.completed));
    assert.equal((await f.management.readWorkerState({ runId: f.review.runId })).run.status, 'running');
  }
});

test('a control change after receipt preflight is rejected in the completion write transaction', async t => {
  const f = await fixture(t);
  await f.releases.issueReview(f.review);
  let changed = false;
  const delayed = createAdminStore({
    execute: (...args) => f.client.execute(...args),
    async batch(...args) {
      if (!changed) {
        changed = true;
        await f.client.execute('UPDATE service_control SET revision=revision+1 WHERE id=1');
      }
      return f.client.batch(...args);
    },
  }, { databaseClockSql: TEST_CLOCK_SQL });
  await assert.rejects(delayed.updateRun(f.completed), errorCode('REVISION_CONFLICT'));
  assert.equal(changed, true);
  assert.equal((await f.management.readWorkerState({ runId: f.review.runId })).run.status, 'running');
});
