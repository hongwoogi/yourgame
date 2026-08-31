import test from 'node:test';
import assert from 'node:assert/strict';
import { currentCollection, INITIAL_CUTOFF, FIRST_RELEASE } from '../server/config.mjs';
import { dailyCycleAt, dailyCycleForDate, pendingProposalClosesAt, pendingProposalClosesAtSql,
  FIRST_DAILY_CUTOFF, DAY_MS, DAILY_RELEASE_DELAY_MS } from '../server/daily-schedule.mjs';
import { createStore } from '../server/store.mjs';
import { backendFixture, errorCode, request, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const firstDaily = {
  cycleId: 'daily-2026-09-01', opensAt: '2026-08-31T14:00:00.000Z',
  closesAt: '2026-09-01T14:00:00.000Z', releaseAt: '2026-09-01T15:00:00.000Z',
};

test('the initial cutoff stays fixed and the first daily cycle opens immediately after it', () => {
  assert.equal(INITIAL_CUTOFF, Date.parse('2026-08-31T14:00:00.000Z'));
  assert.equal(FIRST_DAILY_CUTOFF, Date.parse(firstDaily.closesAt));
  assert.equal(dailyCycleAt(INITIAL_CUTOFF - 1), null);
  assert.deepEqual(currentCollection(INITIAL_CUTOFF - 1), { id: 'initial', status: 'open',
    closesAt: new Date(INITIAL_CUTOFF).toISOString(), releaseAt: new Date(FIRST_RELEASE).toISOString(), initialClosed: false });
  assert.deepEqual(dailyCycleAt(INITIAL_CUTOFF), firstDaily);
  assert.deepEqual(currentCollection(INITIAL_CUTOFF), { id: 'pending', status: 'open', schedule: 'daily-kst-v1', ...firstDaily, initialClosed: true });
});

test('22:59:59.999 stays in the closing cycle; exactly23:00 belongs to the next cycle', () => {
  assert.deepEqual(dailyCycleAt(Date.parse('2026-09-01T22:59:59.999+09:00')), firstDaily);
  const next = dailyCycleForDate('2026-09-02');
  assert.deepEqual(dailyCycleAt(Date.parse('2026-09-01T23:00:00.000+09:00')), next);
  assert.deepEqual(dailyCycleAt(Date.parse('2026-09-02T00:00:00.000+09:00')), next);
  assert.equal(next.opensAt, firstDaily.closesAt);
  assert.equal(Date.parse(next.releaseAt) - Date.parse(next.closesAt), DAILY_RELEASE_DELAY_MS);
});

test('real status opts into daily UI and separates the next midnight from the23h intake rollover', async t => {
  const f = await backendFixture(t);
  for (const [time, cycleId, nextReleaseAt] of [
    ['2026-09-01T13:59:59.999Z','daily-2026-09-01','2026-09-01T15:00:00.000Z'],
    ['2026-09-01T14:00:00.000Z','daily-2026-09-02','2026-09-01T15:00:00.000Z'],
    ['2026-09-01T15:00:00.000Z','daily-2026-09-02','2026-09-02T15:00:00.000Z'],
  ]) {
    await f.setTime(Date.parse(time));
    const response = await request(f.handler, '/api/status');
    assert.equal(response.status, 200);
    assert.equal(response.body.collection.schedule, 'daily-kst-v1');
    assert.equal(response.body.collection.cycleId, cycleId);
    assert.equal(response.body.nextReleaseAt, nextReleaseAt);
    assert.equal(response.body.game.published, false);
  }
});

test('month, year and leap-day boundaries advance by calendar days in fixed-offset KST', () => {
  for (const [date, following] of [['2026-09-30', '2026-10-01'], ['2026-12-31', '2027-01-01'],
    ['2028-02-28', '2028-02-29'], ['2028-02-29', '2028-03-01'], ['2027-02-28', '2027-03-01']]) {
    const cycle = dailyCycleForDate(date), next = dailyCycleForDate(following);
    assert.equal(cycle.releaseAt, `${date}T15:00:00.000Z`);
    assert.deepEqual(dailyCycleAt(Date.parse(cycle.closesAt)), next);
    assert.equal(Date.parse(next.closesAt) - Date.parse(cycle.closesAt), DAY_MS);
    assert.equal(Date.parse(cycle.closesAt) - Date.parse(cycle.opensAt), DAY_MS);
  }
});

test('malformed or prelaunch daily dates and nonfinite timestamps cannot invent schedule cycles', () => {
  for (const date of ['2026-08-31', '2027-02-29', '2028-02-30', '2026-13-01', '2026-9-01',
    '2026-09-01T00:00:00Z', '', null, 20260901]) assert.throws(() => dailyCycleForDate(date), /INVALID_DAILY_DATE/);
  for (const now of [NaN, Infinity, -Infinity, 1.5, '2026-09-01', null]) {
    assert.throws(() => dailyCycleAt(now), /INVALID_DAILY_DATE/);
    assert.throws(() => pendingProposalClosesAt(now), /INVALID_DAILY_DATE/);
  }
});

test('pending cutoff follows immutable creation time and clamps old legacy pending rows to firstdaily', () => {
  for (const created of [INITIAL_CUTOFF - DAY_MS, INITIAL_CUTOFF, FIRST_DAILY_CUTOFF - 1]) {
    assert.equal(pendingProposalClosesAt(created), FIRST_DAILY_CUTOFF);
  }
  assert.equal(pendingProposalClosesAt(FIRST_DAILY_CUTOFF), FIRST_DAILY_CUTOFF + DAY_MS);
  assert.equal(pendingProposalClosesAt(FIRST_DAILY_CUTOFF + DAY_MS - 1), FIRST_DAILY_CUTOFF + DAY_MS);
});

test('SQL cutoff matches the pure function across boundaries and rejects injected identifiers', async t => {
  const f = await backendFixture(t);
  for (const created of [0, INITIAL_CUTOFF - DAY_MS - 1, INITIAL_CUTOFF - 1, INITIAL_CUTOFF,
    FIRST_DAILY_CUTOFF - 1, FIRST_DAILY_CUTOFF, FIRST_DAILY_CUTOFF + DAY_MS,
    Date.parse('2028-02-29T14:00:00.000Z'), Date.parse('2026-12-31T13:59:59.999Z')]) {
    const result = await f.client.execute({ sql: `WITH p AS (SELECT ? AS created_at) SELECT ${pendingProposalClosesAtSql('p.created_at')} AS cutoff FROM p`, args: [created] });
    assert.equal(Number(result.rows[0].cutoff), pendingProposalClosesAt(created));
  }
  for (const column of ['created_at); DROP TABLE proposals;--', 'p.created_at + 1', '', null]) {
    assert.throws(() => pendingProposalClosesAtSql(column), /INVALID_DAILY_COLUMN/);
  }
});

test('pending proposals freeze at their own23:00 cutoff while exactly-boundary new submissions use nextday', async t => {
  const f = await backendFixture(t, { time: FIRST_DAILY_CUTOFF - 1 });
  const { session } = await f.login(), userId = session.user.id;
  const old = await f.store.createProposal(userId, { body: 'synthetic closing idea', requestId: 'daily-closing-idea' });
  assert.equal(old.proposal.roundId, 'pending');
  assert.equal(old.proposal.closesAt, firstDaily.closesAt);
  assert.equal(old.proposal.editable, true);
  await f.setTime(FIRST_DAILY_CUTOFF);
  await assert.rejects(f.store.editProposal(userId, { id: old.proposal.id, revision: 1, body: 'must not replace' }), errorCode('ROUND_CLOSED'));
  const next = await f.store.createProposal(userId, { body: 'synthetic nextday idea', requestId: 'daily-nextday-idea' });
  assert.equal(next.proposal.roundId, 'pending');
  assert.equal(next.proposal.closesAt, dailyCycleForDate('2026-09-02').closesAt);
  assert.equal(next.proposal.editable, true);
  const rows = (await f.store.listProposals(userId)).proposals;
  assert.equal(rows.find(row => row.id === old.proposal.id).editable, false);
  assert.equal(rows.find(row => row.id === old.proposal.id).body, 'synthetic closing idea');
  const history = await f.client.execute({ sql: 'SELECT COUNT(*) AS count FROM proposal_body_revisions WHERE proposal_id = ?', args: [old.proposal.id] });
  assert.equal(Number(history.rows[0].count), 1);
});

test('an edit before cutoff does not extend the pending proposal lifetime or consume another submission', async t => {
  const f = await backendFixture(t, { time: FIRST_DAILY_CUTOFF - 60000 });
  const { session } = await f.login(), userId = session.user.id;
  const original = await f.store.createProposal(userId, { body: 'synthetic original', requestId: 'daily-before-edit' });
  await f.setTime(FIRST_DAILY_CUTOFF - 1);
  const edited = await f.store.editProposal(userId, { id: original.proposal.id, revision: 1, body: 'synthetic edited' });
  assert.equal(edited.proposal.revision, 2);
  assert.equal(edited.proposal.createdAt, original.proposal.createdAt);
  assert.equal(edited.proposal.roundId, original.proposal.roundId);
  assert.equal(edited.proposal.closesAt, original.proposal.closesAt);
  assert.equal(edited.quota.remaining, original.quota.remaining);
  await f.setTime(FIRST_DAILY_CUTOFF);
  await assert.rejects(f.store.editProposal(userId, { id: original.proposal.id, revision: 2, body: 'too late' }), errorCode('ROUND_CLOSED'));
});

test('a delayed pending write is frozen by database execution time despite an old application clock', async t => {
  const f = await backendFixture(t, { time: FIRST_DAILY_CUTOFF - 1 });
  const { session } = await f.login(), userId = session.user.id;
  const original = await f.store.createProposal(userId, { body: 'synthetic delayed original', requestId: 'daily-delayed-idea' });
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const delayed = createStore({ async batch(statements, mode) { reached(); await gate; return f.client.batch(statements, mode); } },
    { now: () => FIRST_DAILY_CUTOFF - 1, databaseClockSql: TEST_CLOCK_SQL });
  const outcome = delayed.editProposal(userId, { id: original.proposal.id, revision: 1, body: 'late delayed update' });
  const rejected = assert.rejects(outcome, errorCode('ROUND_CLOSED'));
  await entered;
  await f.setTime(FIRST_DAILY_CUTOFF);
  release();
  await rejected;
  const saved = (await f.store.listProposals(userId)).proposals[0];
  assert.equal(saved.body, original.proposal.body);
  assert.equal(saved.revision, 1);
  assert.equal(saved.editable, false);
});

test('retrying an old submission after multiple cutoffs is idempotent and never relabels or reopens it', async t => {
  const f = await backendFixture(t, { time: FIRST_DAILY_CUTOFF - 1000 });
  const { session } = await f.login(), userId = session.user.id;
  const input = { body: 'synthetic immutable retry', requestId: 'daily-old-idempotency' };
  const original = await f.store.createProposal(userId, input);
  await f.setTime(FIRST_DAILY_CUTOFF + DAY_MS * 3);
  const retried = await f.store.createProposal(userId, input);
  assert.equal(retried.created, false);
  assert.equal(retried.proposal.id, original.proposal.id);
  assert.equal(retried.proposal.createdAt, original.proposal.createdAt);
  assert.equal(retried.proposal.roundId, 'pending');
  assert.equal(retried.proposal.closesAt, original.proposal.closesAt);
  assert.equal(retried.proposal.editable, false);
  assert.equal((await f.store.listProposals(userId)).proposals.length, 1);
  const rows = await f.client.execute({ sql: 'SELECT id, created_at, round_id, revision FROM proposals WHERE id = ?', args: [original.proposal.id] });
  assert.equal(Number(rows.rows[0].created_at), FIRST_DAILY_CUTOFF - 1000);
  assert.equal(rows.rows[0].round_id, 'pending');
  assert.equal(Number(rows.rows[0].revision), 1);
});
