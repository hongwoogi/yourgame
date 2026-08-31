import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createClient } from '@libsql/client';
import { initializeDatabase } from '../server/database.mjs';
import { DATABASE_NOW_SQL } from '../server/database-clock.mjs';
import { createStore } from '../server/store.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { activateCommunityPublicDefaults } from '../server/community-schema.mjs';
import { prepareGameReleaseSchema } from '../server/game-release-schema.mjs';
import { createGameReleaseStore, RELEASE_BINDING_KEYS } from '../server/game-release-store.mjs';
import { createGamePublicationStore, preparePublicationSchema } from '../server/game-publication-store.mjs';
import { createContributionSettlementStore, prepareContributionSettlementSchema } from '../server/contribution-settlement.mjs';
import { errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const BEFORE = INITIAL_CUTOFF - 3600000;
const AFTER = INITIAL_CUTOFF + 3600000;
const hash = digit => digit.repeat(64);
const scoringPolicy = formula => ({ formula, policyVersion: `contribution-${formula}-v1` });
const operation = (action, input) => ({ action, requestId: randomUUID(), reason: 'Synthetic settlement fixture', ...input });
const bindingOf = row => Object.fromEntries(['id', 'revision', 'bodyHash', 'policyVersion', 'safetyReviewId',
  'safetyRevision', 'developmentBriefHash'].map(key => [key, row[key]]));

async function fixture(t, { prepare = true, activate = true, confirm = true, complete = true, formula = 'weighted',
  authors = ['author-a'], votes = [{ voter: 'supporter-a', proposal: 0, direction: 'up' },
    { voter: 'detractor-a', proposal: 0, direction: 'down' }] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yourgame-contribution-settlement-'));
  const databaseUrl = `file:${path.join(directory, 'test.db').replaceAll('\\', '/')}`;
  const client = createClient({ url: databaseUrl, timeout: 10000 });
  t.after(async () => {
    client.close();
    for (const name of await readdir(directory)) {
      const target = path.resolve(directory, name);
      assert.equal(path.dirname(target), path.resolve(directory));
      try { await unlink(target); }
      catch (error) {
        // Native transaction handles can remain open until process exit on
        // Windows. Preserve this unique synthetic fixture in that case only.
        if (process.platform === 'win32' && ['EBUSY', 'EPERM'].includes(error.code)) return;
        throw error;
      }
    }
    await rmdir(directory);
  });
  await client.execute('PRAGMA foreign_keys=ON');
  await client.execute('CREATE TABLE test_clock(id INTEGER PRIMARY KEY, now_ms INTEGER NOT NULL)');
  await client.execute({ sql: 'INSERT INTO test_clock VALUES(1,?)', args: [BEFORE] });
  // Install the actual schema with its timestamp expression bound to this
  // fixture's clock. Constraints, identities, receipts and guards stay intact;
  // no immutable history is rewritten to make old votes look valid.
  const withClock = statement => typeof statement === 'string' ? statement.replaceAll(DATABASE_NOW_SQL, TEST_CLOCK_SQL)
    : { ...statement, sql: statement.sql.replaceAll(DATABASE_NOW_SQL, TEST_CLOCK_SQL) };
  await initializeDatabase({
    execute: statement => client.execute(withClock(statement)),
    batch: (statements, mode) => client.batch(statements.map(withClock), mode),
  });
  await activateCommunityPublicDefaults(client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  let time = BEFORE;
  const store = createStore(client, { now: () => time, databaseClockSql: TEST_CLOCK_SQL });
  async function setTime(value) {
    time = value;
    await client.execute({ sql: 'UPDATE test_clock SET now_ms=? WHERE id=1', args: [value] });
  }
  const admin = await store.completeLogin((await store.createAnonymousSession()).session, {
    googleSub: 'settlement-test-admin', name: 'Synthetic administrator', email: ADMIN_EMAIL, emailVerified: true,
  });
  const members = new Map();
  async function member(label) {
    if (!members.has(label)) members.set(label, await store.completeLogin((await store.createAnonymousSession()).session, {
      googleSub: `settlement-test-${label}`, name: 'Synthetic participant',
    }));
    return members.get(label);
  }
  const proposals = [];
  for (const [index, label] of authors.entries()) {
    const author = await member(label);
    const proposal = (await store.createProposal(author.session.user.id, {
      body: `A mobile fantasy exploration idea number ${index + 1}.`, requestId: randomUUID(),
    })).proposal;
    const row = (await store.admin.query(admin.session, { section: 'proposals', limit: 100 })).items.find(item => item.id === proposal.id);
    await store.admin.mutate(admin.session, operation('review_proposal_safety', {
      proposalId: row.id, proposalRevision: row.revision, bodyHash: row.safety.bodyHash, policyVersion: row.safety.policyVersion,
      revision: row.safety.revision, status: 'approved', checklistConfirmed: true,
      developmentBrief: `Implement mobile fantasy exploration requirement ${index + 1}.`,
    }));
    const publication = (await store.community.privateState(author.session)).publications.find(item => item.proposalId === proposal.id);
    proposals.push({ ...proposal, publicId: publication.publicId, publicationRevision: publication.publicationRevision });
  }
  for (const vote of votes) {
    const voter = await member(vote.voter);
    const proposal = proposals[vote.proposal];
    await store.community.mutate(voter.session, { action: 'vote', requestId: randomUUID(), publicId: proposal.publicId,
      proposalRevision: proposal.revision, publicationRevision: proposal.publicationRevision,
      roundId: 'initial', direction: vote.direction });
  }
  const bindings = (await store.admin.listEligibleProposals({ roundId: 'initial', proposalIds: proposals.map(item => item.id) })).map(bindingOf);
  const created = await store.admin.mutate(admin.session, operation('create_version', {
    label: 'Synthetic contribution release', summary: 'Verified local fixture only',
  }));
  const workerId = 'settlement-fixture-worker';
  const running = await store.admin.claimRun({ id: created.targetId, revision: 1, workerId });
  await setTime(AFTER);
  await prepareGameReleaseSchema(client, { expectedServiceRevision: 1 });
  await preparePublicationSchema(client, { expectedServiceRevision: 1 });
  const review = { id: randomUUID(), requestId: randomUUID(), operatorId: 'fixture-operator', authorizationRef: 'fixture:authorization',
    runId: running.id, candidateId: 'settlement-candidate', policyVersion: 'teen-v1', snapshotDigest: hash('a'),
    sourceDigest: hash('b'), assetsDigest: hash('c'), gameVersion: 'settlement-fixture-v1', contentSha256: hash('d'),
    runtimeDigest: hash('e'), evidenceDigest: hash('f'), workerId, runRevision: running.revision,
    serviceRevision: 1, roundId: 'initial', bindings };
  const releases = createGameReleaseStore(client, { databaseClockSql: TEST_CLOCK_SQL });
  await releases.issueReview(review);
  const releaseBinding = Object.fromEntries(RELEASE_BINDING_KEYS.map(key => [key, review[key]]));
  const publications = createGamePublicationStore(client, { databaseClockSql: TEST_CLOCK_SQL });
  if (activate) {
    await publications.activate({ operationId: randomUUID(), reviewId: review.id, runId: running.id, workerId,
      runRevision: running.revision, serviceRevision: 1, bindings, roundId: 'initial', releaseBinding,
      commitSha: hash('1'), deploymentId: 'synthetic-deployment', expectedRevision: 0 });
    if (confirm) await publications.confirm({ operationId: randomUUID(), expectedRevision: 1, observationDigest: hash('2') });
  }
  let run = running;
  if (complete) run = await store.admin.updateRun({ id: running.id, revision: running.revision, workerId,
    status: 'completed', releaseReviewId: review.id, releaseBinding, bindings, roundId: 'initial', serviceRevision: 1 });
  if (prepare) await prepareContributionSettlementSchema(client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  const plan = { schemaVersion: 1, requestId: randomUUID(), operatorId: 'fixture-operator', authorizationRef: 'fixture:contribution',
    serviceRevision: 1, publicationRevision: 2, reviewId: review.id, runId: run.id, runRevision: run.revision,
    releaseBinding, bindings, formula, reviewEvidenceDigest: hash('3'), groups: [{ requirementGroupId: 'fantasy-exploration',
      fulfillmentId: 'mobile-exploration-v1', proposalIds: proposals.map(item => item.id), fulfillment: 'full', evidenceDigest: hash('4') }] };
  const settlements = createContributionSettlementStore(client, { databaseClockSql: TEST_CLOCK_SQL, scoringPolicy: scoringPolicy(formula) });
  return { client, databaseUrl, store, admin, members, proposals, bindings, review, run, plan, settlements, setTime };
}

async function effects(client) {
  const hasReceipts = (await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='contribution_settlements'")).rows[0].n;
  return {
    ledger: (await client.execute('SELECT * FROM contribution_ledger ORDER BY id')).rows,
    receipts: hasReceipts ? (await client.execute('SELECT * FROM contribution_settlements ORDER BY request_id')).rows : [],
    audits: (await client.execute('SELECT * FROM admin_audit ORDER BY id')).rows,
  };
}

async function businessData(client) {
  const result = {};
  for (const table of ['users', 'sessions', 'member_access', 'proposals', 'proposal_body_revisions', 'proposal_safety_reviews',
    'community_profiles', 'community_publications', 'community_votes', 'community_events', 'community_requests',
    'service_control', 'development_runs', 'game_release_reviews', 'game_publication_selection', 'game_publication_events']) {
    result[table] = (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows;
  }
  return result;
}

const userId = (f, label) => f.members.get(label).session.user.id;
const awarded = preview => Object.fromEntries(preview.awards.map(row => [row.userId, row]));

test('preview verifies a genuine closed-round release without preparing or writing any settlement data', async t => {
  const f = await fixture(t, { prepare: false });
  const before = await effects(f.client);
  const schema = (await f.client.execute('SELECT name,sql FROM sqlite_master ORDER BY name')).rows;
  const preview = await f.settlements.preview(f.plan);
  assert.equal(preview.kind, 'contribution_settlement_preview');
  assert.equal(preview.awardable, false);
  assert.equal(preview.policyVersion, 'contribution-weighted-v1');
  assert.equal(preview.formula, 'weighted');
  assert.equal(preview.groupCount, 1);
  assert.equal(preview.awardCount, 2);
  assert.equal(preview.totalPoints, '113.5');
  assert.match(preview.payloadDigest, /^[a-f0-9]{64}$/);
  const rows = awarded(preview);
  assert.equal(rows[userId(f, 'author-a')].points, '103');
  assert.equal(rows[userId(f, 'author-a')].adopted, true);
  assert.equal(rows[userId(f, 'supporter-a')].points, '10.5');
  assert.equal(rows[userId(f, 'supporter-a')].halfPointUnits, '21');
  assert.equal(rows[userId(f, 'supporter-a')].role, 'voter');
  assert.equal(rows[userId(f, 'detractor-a')], undefined);
  await assert.rejects(f.settlements.settle(f.plan), errorCode('CONTRIBUTION_SETTLEMENT_SCHEMA_UNAVAILABLE'));
  assert.deepEqual(await effects(f.client), before);
  assert.deepEqual((await f.client.execute('SELECT name,sql FROM sqlite_master ORDER BY name')).rows, schema);
});

test('trusted settlement issues author and supporter points once and makes exact public/private totals readable', async t => {
  const f = await fixture(t);
  const before = await businessData(f.client);
  const audits = (await effects(f.client)).audits.length;
  const result = await f.settlements.settle(f.plan);
  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  assert.equal(result.issuedCount, 2);
  assert.equal(result.pointsIssued, true);
  assert.equal(result.totalPoints, '113.5');
  const after = await effects(f.client);
  assert.equal(after.ledger.length, 2);
  assert.equal(after.receipts.length, 1);
  assert.equal(after.audits.length, audits + 1);
  assert.equal(after.audits.filter(row => row.action === 'operator_settle_contributions').length, 1);
  assert.deepEqual(await businessData(f.client), before);
  assert.deepEqual(await f.store.contribution.privateSummary(f.members.get('author-a').session), { points: '103', adoptedCount: 1, rank: 1 });
  assert.deepEqual(await f.store.contribution.privateSummary(f.members.get('supporter-a').session), { points: '10.5', adoptedCount: 0, rank: 2 });
  const board = await f.store.contribution.leaderboard();
  assert.deepEqual(board.items.slice(0, 2).map(row => [row.rank, row.points, row.adoptedCount]), [[1, '103', 1], [2, '10.5', 0]]);
  await assert.rejects(f.store.contribution.settle(f.plan), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  assert.deepEqual(await effects(f.client), after);
});

test('a reviewed partial fulfillment receives the same score without inventing a percentage or double award', async t => {
  const f = await fixture(t);
  const full = await f.settlements.preview(f.plan);
  const partial = { ...f.plan, groups: f.plan.groups.map(group => ({ ...group, fulfillment: 'partial' })) };
  const preview = await f.settlements.preview(partial);
  const scores = result => result.awards.map(({ fulfillmentEvidenceDigest, ...score }) => score);
  assert.deepEqual(scores(preview), scores(full));
  assert.notEqual(preview.awards[0].fulfillmentEvidenceDigest, full.awards[0].fulfillmentEvidenceDigest);
  assert.equal(preview.totalPoints, '113.5');
  assert.equal((await f.settlements.settle(partial)).issuedCount, 2);
  await assert.rejects(f.settlements.settle({ ...f.plan, requestId: randomUUID() }), errorCode('CONTRIBUTION_ALREADY_ISSUED'));
  assert.equal((await effects(f.client)).ledger.length, 2);
});

test('semantic duplicates and a proposer who also supports the group yield one award per participant', async t => {
  const f = await fixture(t, { authors: ['author-a', 'author-a', 'author-b'], votes: [
    { voter: 'supporter-a', proposal: 0, direction: 'up' }, { voter: 'supporter-a', proposal: 1, direction: 'up' },
    { voter: 'author-a', proposal: 2, direction: 'up' }, { voter: 'detractor-a', proposal: 2, direction: 'down' },
  ] });
  const preview = await f.settlements.preview(f.plan);
  const rows = awarded(preview);
  assert.equal(preview.awardCount, 3);
  for (const label of ['author-a', 'author-b']) {
    assert.equal(rows[userId(f, label)].role, 'proposer');
    assert.equal(rows[userId(f, label)].points, '108');
    assert.equal(rows[userId(f, label)].adopted, true);
  }
  assert.equal(rows[userId(f, 'supporter-a')].points, '11.5');
  assert.equal((await f.settlements.settle(f.plan)).issuedCount, 3);
  assert.equal((await effects(f.client)).ledger.filter(row => row.user_id === userId(f, 'author-a')).length, 1);
});

test('confirmed exponent scoring preserves negative and half-point awards end to end', async t => {
  const f = await fixture(t, { formula: 'exponent', votes: [{ voter: 'supporter-a', proposal: 0, direction: 'up' },
    ...Array.from({ length: 23 }, (_, index) => ({ voter: `detractor-${index}`, proposal: 0, direction: 'down' }))] });
  const preview = await f.settlements.preview(f.plan);
  const rows = awarded(preview);
  assert.equal(rows[userId(f, 'author-a')].points, '-428');
  assert.equal(rows[userId(f, 'supporter-a')].points, '-0.5');
  assert.equal(rows[userId(f, 'supporter-a')].halfPointUnits, '-1');
  assert.equal((await f.settlements.settle(f.plan)).totalPoints, '-428.5');
  assert.equal((await f.store.contribution.privateSummary(f.members.get('author-a').session)).points, '-428');
  assert.equal((await f.store.contribution.privateSummary(f.members.get('supporter-a').session)).points, '-0.5');
});

test('a plan cannot activate its own formula or replace the trusted registered scoring policy', async t => {
  const f = await fixture(t);
  const before = await effects(f.client);
  const unconfirmed = createContributionSettlementStore(f.client, { databaseClockSql: TEST_CLOCK_SQL });
  // Explicit private simulations remain useful while the operator is choosing
  // a policy. They verify evidence but do not activate a scoring policy.
  assert.equal((await unconfirmed.preview(f.plan)).awardable, false);
  await assert.rejects(unconfirmed.settle(f.plan), errorCode('CONTRIBUTION_POLICY_UNCONFIRMED'));
  const alternative = await f.settlements.preview({ ...f.plan, formula: 'exponent' });
  assert.equal(alternative.awardable, false);
  assert.equal(alternative.totalPoints, '110.5');
  await assert.rejects(f.settlements.settle({ ...f.plan, formula: 'exponent' }), errorCode('CONTRIBUTION_POLICY_MISMATCH'));
  for (const policy of [{ formula: 'weighted', policyVersion: 'contribution-exponent-v1' },
    { formula: 'weighted', policyVersion: 'caller-invented-v1' }, { ...scoringPolicy('weighted'), verified: true }]) {
    await assert.rejects(async () => createContributionSettlementStore(f.client, {
      databaseClockSql: TEST_CLOCK_SQL, scoringPolicy: policy,
    }).settle(f.plan), errorCode('CONTRIBUTION_POLICY_MISMATCH'));
  }
  assert.deepEqual(await effects(f.client), before);
});

test('malformed fulfillment plans and caller-written approval or point fields never mutate the ledger', async t => {
  const f = await fixture(t);
  const before = await effects(f.client);
  const cases = [
    { ...f.plan, schemaVersion: 2 }, { ...f.plan, approved: true }, { ...f.plan, points: 999999 },
    { ...f.plan, groups: [] }, { ...f.plan, reviewEvidenceDigest: 'unverified' },
    { ...f.plan, authorizationRef: undefined },
    ...[{ fulfillment: undefined }, { fulfillment: 'unreviewed' }, { fulfillmentId: '' },
      { evidenceDigest: 'unverified' }, { proposalIds: [] }, { points: '1000' }].map(change => ({ ...f.plan,
      groups: [{ ...f.plan.groups[0], ...change }] })),
  ];
  for (const plan of cases) {
    await assert.rejects(f.settlements.preview(plan), errorCode('INVALID_CONTRIBUTION_SETTLEMENT'));
    await assert.rejects(f.settlements.settle(plan), errorCode('INVALID_CONTRIBUTION_SETTLEMENT'));
    assert.deepEqual(await effects(f.client), before);
  }
});

test('release review alone, provisional publication, failed work and stale completion cannot earn points', async t => {
  for (const [label, options, change, code] of [
    ['never selected', { activate: false }, null, 'CONTRIBUTION_PUBLICATION_UNVERIFIED'],
    ['not observed', { confirm: false }, null, 'CONTRIBUTION_PUBLICATION_UNVERIFIED'],
    ['still running', { complete: false }, null, 'CONTRIBUTION_RUN_UNAVAILABLE'],
    ['failed', {}, f => f.client.execute({ sql: "UPDATE development_runs SET status='failed',revision=revision+1 WHERE id=?", args: [f.run.id] }), 'CONTRIBUTION_RUN_UNAVAILABLE'],
    ['stale revision', {}, f => { f.plan.runRevision += 1; }, 'CONTRIBUTION_RUN_UNAVAILABLE'],
    ['wrong selection revision', {}, f => { f.plan.publicationRevision += 1; }, 'CONTRIBUTION_PUBLICATION_UNVERIFIED'],
  ]) await t.test(label, async t => {
    const f = await fixture(t, options);
    if (change) await change(f);
    const before = await effects(f.client);
    await assert.rejects(f.settlements.preview(f.plan), errorCode(code));
    await assert.rejects(f.settlements.settle(f.plan), errorCode(code));
    assert.deepEqual(await effects(f.client), before);
  });
});

test('changed body, safety approval, moderation or participant controls invalidate the exact input binding', async t => {
  const cases = [
    ['body revision', f => f.client.execute({ sql: "UPDATE proposals SET body='Changed synthetic requirement',revision=revision+1 WHERE id=?", args: [f.proposals[0].id] })],
    ['safety withdrawn', f => f.client.execute({ sql: "UPDATE proposal_safety_reviews SET status='held',revision=revision+1 WHERE id=?", args: [f.bindings[0].safetyReviewId] })],
    ['brief binding', f => { f.plan.bindings[0].developmentBriefHash = hash('9'); }],
    ['excluded proposal', f => f.client.execute({ sql: "INSERT INTO proposal_moderation(proposal_id,moderation,revision,updated_at) VALUES(?,'excluded',1,?) ON CONFLICT(proposal_id) DO UPDATE SET moderation='excluded',revision=revision+1", args: [f.proposals[0].id, BEFORE] })],
    ['suspended author', f => f.client.execute({ sql: "UPDATE member_access SET status='suspended',revision=revision+1 WHERE user_id=?", args: [userId(f, 'author-a')] })],
  ];
  for (const [label, change] of cases) await t.test(label, async t => {
    const f = await fixture(t);
    await change(f);
    const before = await effects(f.client);
    await assert.rejects(f.settlements.preview(f.plan), errorCode('CONTRIBUTION_INPUT_BINDING_MISMATCH'));
    await assert.rejects(f.settlements.settle(f.plan), errorCode('CONTRIBUTION_INPUT_BINDING_MISMATCH'));
    assert.deepEqual(await effects(f.client), before);
  });
});

test('a mutable verified flag without its actual publication event cannot authorize settlement', async t => {
  const f = await fixture(t, { confirm: false });
  await f.client.execute('UPDATE game_publication_selection SET active_verified=1,revision=2 WHERE id=1');
  const before = await effects(f.client);
  await assert.rejects(f.settlements.settle(f.plan), errorCode('PUBLICATION_UNAVAILABLE'));
  assert.deepEqual(await effects(f.client), before);
});

test('missing reviews and forged release/publication audit relationships fail closed', async t => {
  for (const action of ['missing-review', 'operator_review_game_release', 'operator_game_verified']) await t.test(action, async t => {
    const f = await fixture(t);
    if (action === 'missing-review') f.plan.reviewId = randomUUID();
    else {
      // Deliberately model a corrupted audit in this disposable database, then
      // restore its guard. A present trigger must not mask a broken receipt join.
      const trigger = (await f.client.execute("SELECT sql FROM sqlite_master WHERE name='admin_audit_no_update'")).rows[0].sql;
      await f.client.execute('DROP TRIGGER admin_audit_no_update');
      await f.client.execute({ sql: "UPDATE admin_audit SET reason='synthetic-unbound-audit' WHERE action=?", args: [action] });
      await f.client.execute(trigger);
    }
    const before = await effects(f.client);
    const code = action === 'missing-review' ? 'CONTRIBUTION_PUBLICATION_UNVERIFIED'
      : action === 'operator_review_game_release' ? 'RELEASE_REVIEW_UNAVAILABLE' : 'PUBLICATION_UNAVAILABLE';
    await assert.rejects(f.settlements.preview(f.plan), errorCode(code));
    await assert.rejects(f.settlements.settle(f.plan), errorCode(code));
    assert.deepEqual(await effects(f.client), before);
  });
});

test('a vote row without its immutable event and request evidence cannot fabricate supporter points', async t => {
  const f = await fixture(t);
  const trigger = (await f.client.execute("SELECT sql FROM sqlite_master WHERE name='community_requests_no_delete'")).rows[0].sql;
  await f.client.execute('DROP TRIGGER community_requests_no_delete');
  await f.client.execute({ sql: 'DELETE FROM community_requests WHERE user_id=?', args: [userId(f, 'supporter-a')] });
  await f.client.execute(trigger);
  const before = await effects(f.client);
  await assert.rejects(f.settlements.preview(f.plan), errorCode('CONTRIBUTION_VOTE_HISTORY_UNAVAILABLE'));
  await assert.rejects(f.settlements.settle(f.plan), errorCode('CONTRIBUTION_VOTE_HISTORY_UNAVAILABLE'));
  assert.deepEqual(await effects(f.client), before);
});

test('exact replay is read-only while changed payloads and a new request for the same award conflict', async t => {
  const f = await fixture(t);
  await f.settlements.settle(f.plan);
  const issued = await effects(f.client);
  const replay = await f.settlements.settle(structuredClone(f.plan));
  assert.equal(replay.replayed, true);
  assert.equal(replay.issuedCount, 0);
  assert.equal(replay.pointsIssued, false);
  assert.equal(replay.totalPoints, '113.5');
  assert.deepEqual(await effects(f.client), issued);
  await assert.rejects(f.settlements.settle({ ...f.plan, reviewEvidenceDigest: hash('9') }), errorCode('CONTRIBUTION_SETTLEMENT_CONFLICT'));
  await assert.rejects(f.settlements.settle({ ...f.plan, requestId: randomUUID() }), errorCode('CONTRIBUTION_ALREADY_ISSUED'));
  assert.deepEqual(await effects(f.client), issued);
});

test('the same fulfillment cannot appear twice under different group names in one request', async t => {
  const f = await fixture(t);
  const before = await effects(f.client);
  const renamed = { ...f.plan.groups[0], requirementGroupId: 'renamed-exploration' };
  const duplicate = { ...f.plan, groups: [...f.plan.groups, renamed] };
  await assert.rejects(f.settlements.preview(duplicate), errorCode('INVALID_CONTRIBUTION_SETTLEMENT'));
  await assert.rejects(f.settlements.settle(duplicate), errorCode('INVALID_CONTRIBUTION_SETTLEMENT'));
  assert.deepEqual(await effects(f.client), before);
});

test('renaming a settled group cannot reissue its fulfillment, while a genuinely different change remains payable', async t => {
  const f = await fixture(t);
  await f.settlements.settle(f.plan);
  const issued = await effects(f.client);
  const regrouped = { ...f.plan, requestId: randomUUID(), groups: [{ ...f.plan.groups[0],
    requirementGroupId: 'renamed-exploration' }] };
  await assert.rejects(f.settlements.settle(regrouped), errorCode('CONTRIBUTION_ALREADY_ISSUED'));
  assert.deepEqual(await effects(f.client), issued);

  // The database also preserves fulfillment identity if a future writer fails
  // to use the application-level duplicate check. This local fixture row has
  // new row/award/group identities but still represents the very same change.
  const duplicate = { ...issued.ledger[0], id: randomUUID(), award_key: hash('9'), requirement_group_id: 'another-renamed-group' };
  const keys = Object.keys(duplicate);
  await assert.rejects(f.client.execute({ sql: `INSERT INTO contribution_ledger(${keys.join(',')})
    VALUES(${keys.map(() => '?').join(',')})`, args: keys.map(key => duplicate[key]) }));
  assert.deepEqual(await effects(f.client), issued);

  // A separate reviewed requirement and fulfillment is not a deployment retry.
  // It also obeys the existing one-award-per-release/group/user constraint.
  const differentChange = { ...f.plan, requestId: randomUUID(), reviewEvidenceDigest: hash('5'),
    groups: [{ ...f.plan.groups[0], requirementGroupId: 'touch-navigation', fulfillmentId: 'touch-navigation-v1', evidenceDigest: hash('6') }] };
  const next = await f.settlements.settle(differentChange);
  assert.equal(next.issuedCount, 2);
  assert.equal(next.replayed, false);
  const after = await effects(f.client);
  assert.equal(after.ledger.length, 4);
  assert.equal(after.receipts.length, 2);
  assert.deepEqual(after.ledger.filter(row => issued.ledger.some(old => old.id === row.id)), issued.ledger);
  assert.equal((await f.store.contribution.privateSummary(f.members.get('author-a').session)).points, '206');
});

test('concurrent exact requests on separate native connections leave one settlement and one award set', async t => {
  const f = await fixture(t);
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    const { createClient } = require('@libsql/client');
    (async () => {
      const { createContributionSettlementStore } = await import(workerData.module);
      const client = createClient({ url: workerData.databaseUrl, timeout: 10000 });
      await client.execute('PRAGMA foreign_keys=ON');
      const store = createContributionSettlementStore(client, workerData.options);
      parentPort.once('message', async () => {
        try { parentPort.postMessage({ result: await store.settle(workerData.plan) }); }
        catch (error) { parentPort.postMessage({ error: { code: error.code, message: error.message } }); }
        finally { client.close(); parentPort.close(); }
      });
      parentPort.postMessage({ ready: true });
    })().catch(error => { parentPort.postMessage({ error: { code: error.code, message: error.message } }); parentPort.close(); });`;
  const workers = Array.from({ length: 2 }, () => new Worker(source, { eval: true, workerData: {
    module: new URL('../server/contribution-settlement.mjs', import.meta.url).href, databaseUrl: f.databaseUrl,
    options: { databaseClockSql: TEST_CLOCK_SQL, scoringPolicy: scoringPolicy('weighted') }, plan: f.plan,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else if (message.result) resolve(message.result);
    });
  }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => { if (message.ready) resolve(); else if (message.error) reject(new Error(message.error.message)); });
  })));
  for (const worker of workers) worker.postMessage('start');
  const completed = await Promise.all(results);
  assert.deepEqual(completed.map(result => result.replayed).sort(), [false, true]);
  assert.equal(completed.reduce((sum, result) => sum + result.issuedCount, 0), 2);
  const after = await effects(f.client);
  assert.equal(after.receipts.length, 1);
  assert.equal(after.ledger.length, 2);
  assert.equal(after.audits.filter(row => row.action === 'operator_settle_contributions').length, 1);
});

test('failure after a ledger insert rolls back the whole award batch and its audit/receipt', async t => {
  const f = await fixture(t);
  const before = await effects(f.client);
  let writes = 0;
  const faulty = createContributionSettlementStore({
    execute: (...args) => f.client.execute(...args),
    async transaction(...args) {
      const transaction = await f.client.transaction(...args);
      return new Proxy(transaction, { get(target, key) {
        if (key === 'execute') return async statement => {
          const sql = typeof statement === 'string' ? statement : statement.sql;
          if (/INSERT\s+INTO\s+contribution_ledger/i.test(sql) && ++writes === 2) throw new Error('Synthetic second-award storage failure');
          return target.execute(statement);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  }, { databaseClockSql: TEST_CLOCK_SQL, scoringPolicy: scoringPolicy('weighted') });
  await assert.rejects(faulty.settle(f.plan), /Synthetic second-award storage failure/);
  assert.equal(writes, 2);
  assert.deepEqual(await effects(f.client), before);
  assert.equal((await f.settlements.settle(f.plan)).issuedCount, 2);
});

test('settlement receipts and ledger rows cannot be edited, deleted, or replaced after issuance', async t => {
  const f = await fixture(t);
  await f.settlements.settle(f.plan);
  const before = await effects(f.client);
  for (const table of ['contribution_settlements', 'contribution_ledger']) {
    await assert.rejects(f.client.execute(`UPDATE ${table} SET ${table === 'contribution_ledger' ? 'points_units=points_units' : 'awards_digest=awards_digest'}`));
    await assert.rejects(f.client.execute(`DELETE FROM ${table}`));
    await assert.rejects(f.client.execute(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`));
    assert.deepEqual(await effects(f.client), before);
  }
});

test('same-name ineffective receipt guards or fulfillment indexes cannot satisfy settlement readiness', async t => {
  const replacements = [
    ['receipt trigger', 'DROP TRIGGER contribution_settlements_no_update',
      'CREATE TRIGGER contribution_settlements_no_update BEFORE UPDATE ON contribution_settlements BEGIN SELECT 1; END'],
    ['fulfillment index', 'DROP INDEX contribution_ledger_fulfillment_user',
      'CREATE INDEX contribution_ledger_fulfillment_user ON contribution_ledger(fulfillment_id,user_id)'],
  ];
  for (const [label, drop, replacement] of replacements) await t.test(label, async t => {
    const f = await fixture(t);
    // Model an incorrectly installed guard only inside this synthetic DB. Its
    // familiar name must not conceal the missing immutability/uniqueness rule.
    await f.client.execute(drop);
    await f.client.execute(replacement);
    const before = await effects(f.client);
    const protectedRows = await businessData(f.client);
    const schema = (await f.client.execute('SELECT name,sql FROM sqlite_master ORDER BY name')).rows;
    await assert.rejects(f.settlements.settle(f.plan), errorCode('CONTRIBUTION_SETTLEMENT_SCHEMA_UNAVAILABLE'));
    assert.deepEqual(await effects(f.client), before);
    assert.deepEqual(await businessData(f.client), protectedRows);
    assert.deepEqual((await f.client.execute('SELECT name,sql FROM sqlite_master ORDER BY name')).rows, schema);
  });
});

test('schema preparation is additive, guarded by current service controls, and never resets earned points', async t => {
  const f = await fixture(t, { prepare: false });
  const before = await businessData(f.client);
  await assert.rejects(prepareContributionSettlementSchema(f.client, { expectedServiceRevision: 99, databaseClockSql: TEST_CLOCK_SQL }), errorCode('WORKER_BLOCKED'));
  assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='contribution_settlements'")).rows[0].n, 0);
  for (let attempt = 0; attempt < 2; attempt++) await prepareContributionSettlementSchema(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  assert.deepEqual(await businessData(f.client), before);
  await f.settlements.settle(f.plan);
  const issued = await effects(f.client);
  await prepareContributionSettlementSchema(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  assert.deepEqual(await effects(f.client), issued);
  await f.client.execute('UPDATE service_control SET development_enabled=0 WHERE id=1');
  await assert.rejects(prepareContributionSettlementSchema(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL }), errorCode('WORKER_BLOCKED'));
  assert.deepEqual(await effects(f.client), issued);
});
