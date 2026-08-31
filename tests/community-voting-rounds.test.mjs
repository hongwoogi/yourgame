import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCommunityStore } from '../server/community-store.mjs';
import { prepareCommunityVotingRounds, COMMUNITY_DAILY_ROUND_DDL, checkCommunitySchema } from '../server/community-schema.mjs';
import { COMMUNITY_DAILY_ROUND_TRIGGER_NAMES } from '../server/community-policy.mjs';
import { DAY_MS, INITIAL_CUTOFF, dailyCycleAt } from '../server/daily-schedule.mjs';
import { backendFixture, errorCode, request, signedHeaders, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const operation = (action, values = {}) => ({ action, requestId: randomUUID(), ...values });
const ballot = (idea, direction = 'up', values = {}) => operation('vote', {
  publicId: idea.id, proposalRevision: idea.proposalRevision, publicationRevision: idea.publicationRevision,
  roundId: idea.roundId, direction, ...values,
});

async function fixture(t, time = INITIAL_CUTOFF + 1000) {
  const f = await backendFixture(t, { time });
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'",
    args: [INITIAL_CUTOFF - DAY_MS] });
  return f;
}

async function submit(f, author = null) {
  author ??= await f.login(randomUUID());
  const { proposal } = await f.store.createProposal(author.session.user.id,
    { body: 'Synthetic daily fixture: add another colorful puzzle.', requestId: randomUUID() });
  return { author, proposal };
}

async function idea(f, author) {
  const submitted = await submit(f, author);
  const owner = await f.store.community.privateState(submitted.author.session);
  const publication = owner.publications.find(value => value.proposalId === submitted.proposal.id);
  const item = (await f.store.community.publicIdeas({ includeClosed: true, limit: 50 })).items
    .find(value => value.id === publication.publicId);
  return { ...submitted, item, owner };
}

const historyTables = ['users', 'sessions', 'proposals', 'proposal_body_revisions', 'proposal_safety_reviews',
  'community_profiles', 'community_profile_names', 'community_publications', 'community_publication_defaults',
  'community_profile_defaults', 'community_visibility_choices', 'community_default_events',
  'community_votes', 'community_events', 'community_requests', 'community_rate_windows',
  'service_control', 'member_access', 'proposal_moderation', 'admin_audit', 'admin_requests', 'contribution_ledger'];

async function records(client, tables = historyTables) {
  return Promise.all(tables.map(async table => (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows));
}

async function removeDailyPreparation(f) {
  // Only this fresh synthetic database is changed to model the pre-upgrade
  // schema. It has no daily votes and no production connection or credentials.
  assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM community_votes WHERE round_id GLOB 'daily-*'")).rows[0].n, 0);
  for (const name of COMMUNITY_DAILY_ROUND_TRIGGER_NAMES) await f.client.execute(`DROP TRIGGER ${name}`);
  await f.client.execute("DELETE FROM community_rounds WHERE id GLOB 'daily-*'");
  await f.client.execute("DELETE FROM community_meta WHERE key = 'daily_voting_rounds_schema_version'");
}

test('a new pending idea immediately has a real dated round, owner identity and bounded voting without safety approval', async t => {
  const f = await fixture(t);
  const row = await idea(f);
  const viewer = await f.login('daily-voter');
  const cycle = dailyCycleAt(f.now());
  assert.equal(row.proposal.roundId, 'pending');
  assert.equal(row.proposal.safety.status, 'pending');
  assert.equal(row.item.roundId, cycle.cycleId);
  assert.equal(row.item.votingOpen, true);
  assert.equal(row.item.author.id, row.owner.profile.id);
  const stored = (await f.client.execute({ sql: 'SELECT * FROM community_rounds WHERE id = ?', args: [cycle.cycleId] })).rows[0];
  assert.deepEqual(stored, { id: cycle.cycleId, proposal_round_id: cycle.cycleId,
    opens_at: Date.parse(cycle.opensAt), closes_at: Date.parse(cycle.closesAt) });
  assert.equal((await f.client.execute({ sql: 'SELECT round_id FROM proposals WHERE id = ?', args: [row.proposal.id] })).rows[0].round_id, 'pending');
  await assert.rejects(f.store.community.mutate(row.author.session, ballot(row.item)), errorCode('SELF_VOTE_FORBIDDEN'));
  await f.store.community.mutate(viewer.session, ballot(row.item));
  assert.equal((await f.store.community.publicFeed()).recent[0].upvotes, 1);
  assert.deepEqual((await f.store.community.privateState(viewer.session)).voteQuota,
    { roundId: cycle.cycleId, limit: 3, used: 1, remaining: 2, closesAt: cycle.closesAt });
});

test('23:00 closes the old dated collection and starts the next without modifying its proposals, votes or receipts', async t => {
  const f = await fixture(t, INITIAL_CUTOFF - 1);
  const first = await idea(f);
  const voter = await f.login('boundary-voter');
  const original = ballot(first.item);
  await f.store.community.mutate(voter.session, original);
  const initialHistory = await records(f.client, ['proposals', 'community_votes', 'community_events', 'community_requests']);
  await f.setTime(INITIAL_CUTOFF);
  for (const direction of ['up', 'down', 'none']) {
    await assert.rejects(f.store.community.mutate(voter.session, ballot(first.item, direction)), errorCode('VOTING_CLOSED'));
  }
  await f.store.community.mutate(voter.session, original);
  assert.deepEqual(await records(f.client, ['proposals', 'community_votes', 'community_events', 'community_requests']), initialHistory);
  assert.deepEqual((await f.store.community.publicFeed()).recent, []);
  const historical = (await f.store.community.publicFeed({ includeClosed: true })).recent[0];
  assert.equal(historical.votingOpen, false);
  assert.equal(historical.upvotes, 1);
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.roundId, 'daily-2026-09-01');
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.remaining, 3);
  const next = await idea(f);
  assert.equal(next.item.roundId, 'daily-2026-09-01');
  await f.setTime(INITIAL_CUTOFF + DAY_MS - 1);
  await f.store.community.mutate(voter.session, ballot(next.item, 'down'));
  const previousVotes = await records(f.client, ['community_votes', 'community_events', 'community_requests']);
  await f.setTime(INITIAL_CUTOFF + DAY_MS);
  for (const direction of ['up', 'down', 'none']) {
    await assert.rejects(f.store.community.mutate(voter.session, ballot(next.item, direction)), errorCode('VOTING_CLOSED'));
  }
  assert.deepEqual(await records(f.client, ['community_votes', 'community_events', 'community_requests']), previousVotes);
  const empty = await f.store.community.publicIdeas();
  assert.equal(empty.round.id, 'daily-2026-09-02');
  assert.equal(empty.round.status, 'open');
  assert.equal(empty.total, 0);
  const later = await idea(f);
  assert.equal(later.item.roundId, 'daily-2026-09-02');
  assert.equal(later.item.votingOpen, true);
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.used, 0);
});

test('three combined active vote slots are atomic per dated round and reset without cancelling previous votes', async t => {
  const f = await fixture(t);
  const voter = await f.login('daily-budget-voter');
  const first = [];
  for (let index = 0; index < 6; index += 1) first.push((await idea(f)).item);
  const stores = await Promise.all(first.map(() => f.anotherStore()));
  const outcomes = await Promise.allSettled(first.map((item, index) => stores[index].community.mutate(voter.session,
    ballot(item, index % 2 ? 'down' : 'up'))));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 3);
  assert.deepEqual(outcomes.filter(value => value.status === 'rejected').map(value => value.reason.code),
    Array(3).fill('VOTE_QUOTA_EXCEEDED'));
  const accepted = first.filter((_, index) => outcomes[index].status === 'fulfilled');
  const rejected = first.find((_, index) => outcomes[index].status === 'rejected');
  await f.store.community.mutate(voter.session, ballot(accepted[0], 'none'));
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.remaining, 1);
  await f.store.community.mutate(voter.session, ballot(rejected));
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.used, 3);
  const previous = (await f.client.execute("SELECT * FROM community_votes WHERE round_id = 'daily-2026-09-01' ORDER BY public_id")).rows;
  await f.setTime(INITIAL_CUTOFF + DAY_MS);
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.remaining, 3);
  const later = [];
  for (let index = 0; index < 4; index += 1) later.push((await idea(f)).item);
  for (const item of later.slice(0, 3)) await f.store.community.mutate(voter.session, ballot(item));
  await assert.rejects(f.store.community.mutate(voter.session, ballot(later[3])), errorCode('VOTE_QUOTA_EXCEEDED'));
  assert.deepEqual((await f.client.execute("SELECT * FROM community_votes WHERE round_id = 'daily-2026-09-01' ORDER BY public_id")).rows, previous);
  assert.deepEqual((await f.store.community.privateState(voter.session)).voteQuota,
    { roundId: 'daily-2026-09-02', limit: 3, used: 3, remaining: 0,
      closesAt: new Date(INITIAL_CUTOFF + 2 * DAY_MS).toISOString() });
});

test('three independent Node processes sharing a daily round accept exactly three of twelve concurrent votes', async t => {
  const f = await fixture(t);
  const voter = await f.login('daily-process-race-voter');
  const items = [];
  for (let index = 0; index < 12; index += 1) items.push((await idea(f)).item);
  const inputs = items.map((item, index) => ballot(item, index % 2 ? 'down' : 'up'));
  assert.equal(new Set(inputs.map(input => input.publicId)).size, 12);
  assert.equal(new Set(inputs.map(input => input.roundId)).size, 1);
  assert.equal(inputs[0].roundId, 'daily-2026-09-01');
  // Copy only this synthetic in-memory fixture. Each child opens its own
  // connection to the same file; no parent connection or Worker isolate is
  // shared. The fixture's cleanup runs only after the finally block below has
  // awaited every actual child close event, including failure/timeout paths.
  await f.client.execute({ sql: 'VACUUM INTO ?', args: [f.raceDatabaseUrl.slice('file:'.length)] });
  const source = `import { createClient } from '@libsql/client';
    const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
    const failureCode = error => /^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code || '') ? error.code : 'TEST_CHILD_FAILURE';
    process.once('message', async data => {
      let client;
      try {
        const { createCommunityStore } = await import(data.module);
        client = createClient({ url: data.databaseUrl, timeout: 10000 });
        await client.execute('PRAGMA foreign_keys=ON');
        const store = createCommunityStore(client, data.options);
        process.once('message', async start => {
          try {
            if (start !== 'start') throw new Error('Invalid synthetic barrier');
            const outcomes = [];
            for (const input of data.inputs) {
              try { await store.mutate(data.session, input); outcomes.push('accepted'); }
              catch (error) {
                if (error.code !== 'VOTE_QUOTA_EXCEEDED') throw error;
                outcomes.push(error.code);
              }
            }
            const state = await store.privateState(data.session);
            const counts = (await client.execute({ sql: 'SELECT '
              + '(SELECT COUNT(*) FROM community_votes WHERE user_id=? AND round_id=?) AS votes,'
              + '(SELECT COUNT(*) FROM community_events WHERE actor_user_id=? AND action=?) AS events,'
              + '(SELECT COUNT(*) FROM community_requests WHERE user_id=?) AS receipts,'
              + '(SELECT COUNT(*) FROM contribution_ledger) AS awards',
              args: [data.session.user.id, data.inputs[0].roundId, data.session.user.id, 'vote', data.session.user.id] })).rows[0];
            client.close();
            await send({ result: { outcomes, used: state.voteQuota.used, remaining: state.voteQuota.remaining,
              roundId: state.voteQuota.roundId, ...counts } });
          } catch (error) {
            process.exitCode = 1;
            client.close();
            await send({ failure: failureCode(error) });
          } finally { process.disconnect(); }
        });
        await send({ ready: true, pid: process.pid });
      } catch (error) {
        process.exitCode = 1;
        client?.close();
        await send({ failure: failureCode(error) });
        process.disconnect();
      }
    });`;
  const children = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), env: {}, windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let resolveReady, rejectReady, result, failure, stderrBytes = 0;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      ready.catch(() => {});
      const timeout = setTimeout(() => {
        failure = 'TEST_CHILD_TIMEOUT';
        rejectReady(new Error(failure));
        child.kill();
      }, 30000);
      const closed = new Promise(resolve => child.once('close', (exitCode, signal) => {
        clearTimeout(timeout);
        rejectReady(new Error(failure || `TEST_CHILD_EARLY_EXIT:${exitCode}:${signal}`));
        resolve({ exitCode, signal, result, failure, stderrBytes });
      }));
      child.on('error', error => { failure = error.code || 'TEST_CHILD_SPAWN_FAILURE'; rejectReady(new Error(failure)); });
      child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
      child.on('message', message => {
        if (message.ready) resolveReady(message.pid);
        if (message.result) result = message.result;
        if (message.failure) { failure = message.failure; rejectReady(new Error(failure)); }
      });
      children.push({ child, ready, closed });
      child.send({ module: new URL('../server/community-store.mjs', import.meta.url).href,
        databaseUrl: f.raceDatabaseUrl, options: { databaseClockSql: TEST_CLOCK_SQL }, session: voter.session,
        inputs: inputs.slice(index * 4, index * 4 + 4) }, error => {
        if (error) { failure = error.code || 'TEST_CHILD_IPC_FAILURE'; rejectReady(new Error(failure)); child.kill(); }
      });
    }
    const pids = await Promise.all(children.map(child => child.ready));
    assert.equal(new Set(pids).size, 3);
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid !== process.pid));
    // All three independent connections have opened before any ballot starts.
    for (const { child } of children) child.send('start');
    const exits = await Promise.all(children.map(child => child.closed));
    for (const outcome of exits) {
      assert.equal(outcome.exitCode, 0, `daily voting child exit: ${outcome.exitCode}; stderr bytes: ${outcome.stderrBytes}`);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.failure, undefined);
      assert.equal(outcome.result?.roundId, 'daily-2026-09-01');
      assert.equal(outcome.result?.outcomes.length, 4);
      assert.equal(outcome.result.used, 3);
      assert.equal(outcome.result.remaining, 0);
      assert.equal(Number(outcome.result.votes), 3);
      assert.equal(Number(outcome.result.events), 3);
      assert.equal(Number(outcome.result.receipts), 3);
      assert.equal(Number(outcome.result.awards), 0);
    }
    const outcomes = exits.flatMap(exit => exit.result.outcomes);
    assert.equal(outcomes.length, 12);
    assert.equal(outcomes.filter(value => value === 'accepted').length, 3);
    assert.deepEqual(outcomes.filter(value => value !== 'accepted'), Array(9).fill('VOTE_QUOTA_EXCEEDED'));
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(child => child.closed));
  }
});

test('the additive daily cap protects against an old writer whose embedded cap only counted initial votes', async t => {
  const f = await fixture(t);
  const voter = await f.login('old-writer-daily-voter');
  const items = [];
  for (let index = 0; index < 4; index += 1) items.push((await idea(f)).item);
  for (const item of items.slice(0, 3)) await f.store.community.mutate(voter.session, ballot(item));
  // Disable only the original fixture cap, proving the new independently
  // additive guard is effective without rewriting the production old guard.
  await f.client.execute('DROP TRIGGER community_default_vote_insert_cap');
  await assert.rejects(f.client.execute({ sql: `INSERT INTO community_votes
    SELECT user_id, round_id, ?, direction, proposal_revision, publication_revision, body_hash, policy_version,
      safety_review_id, safety_revision, author_control_revision, voter_control_revision, moderation_revision,
      revision, created_at, updated_at FROM community_votes LIMIT 1`, args: [items[3].id] }),
  error => String(error.code).startsWith('SQLITE_CONSTRAINT'));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_votes')).rows[0].n, 3);
});

test('default and all-ideas modes share recent/popular pagination while all history remains read-only', async t => {
  const f = await fixture(t);
  const voter = await f.login('history-sort-voter');
  const old = await idea(f);
  await f.store.community.mutate(voter.session, ballot(old.item));
  await f.setTime(INITIAL_CUTOFF + DAY_MS);
  const current = [];
  for (let index = 0; index < 7; index += 1) {
    await f.setTime(f.now() + 1);
    current.push((await idea(f)).item);
  }
  await f.store.community.mutate(voter.session, ballot(current[0]));
  await f.store.community.mutate(voter.session, ballot(current[1], 'down'));
  const before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
  for (const includeClosed of [false, true]) {
    const feed = await f.store.community.publicFeed({ includeClosed });
    assert.equal(feed.includeClosed, includeClosed);
    for (const sort of ['recent', 'popular']) {
      const complete = await f.store.community.publicIdeas({ sort, limit: 50, includeClosed });
      const first = await f.store.community.publicIdeas({ sort, limit: 4, includeClosed });
      const second = await f.store.community.publicIdeas({ sort, limit: 4, offset: 4, includeClosed });
      assert.equal(complete.total, includeClosed ? 8 : 7);
      assert.deepEqual([...first.items, ...second.items], complete.items);
      assert.deepEqual(feed[sort], complete.items.slice(0, 6));
      assert.equal(complete.items.some(item => item.id === old.item.id), includeClosed);
      if (includeClosed) assert.equal(complete.items.find(item => item.id === old.item.id).votingOpen, false);
      assert.equal(first.hasMore, true);
      assert.equal(second.hasMore, false);
    }
  }
  assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
});

test('empty future round context and private quota work with query-only storage without inventing identities or rows', async t => {
  const f = await fixture(t, INITIAL_CUTOFF + 40 * DAY_MS + 1000);
  const member = await f.login('empty-future-voter');
  const cycle = dailyCycleAt(f.now());
  assert.equal((await f.client.execute({ sql: 'SELECT COUNT(*) AS n FROM community_rounds WHERE id = ?', args: [cycle.cycleId] })).rows[0].n, 0);
  const before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
  await f.client.execute('PRAGMA query_only = ON');
  try {
    for (const url of ['/api/community', '/api/community?includeClosed=1', '/api/community?view=ideas',
      '/api/community?view=ideas&includeClosed=1', '/api/community?view=me']) {
      const response = await request(f.handler, url, signedHeaders(member));
      assert.equal(response.status, 200);
      if (url.endsWith('view=me')) assert.deepEqual(response.body.voteQuota,
        { roundId: cycle.cycleId, limit: 3, used: 0, remaining: 3, closesAt: cycle.closesAt });
      else assert.equal(response.body.round.id, cycle.cycleId);
    }
    assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
  } finally { await f.client.execute('PRAGMA query_only = OFF'); }
  await f.client.execute({ sql: 'DELETE FROM community_profiles WHERE user_id = ?', args: [member.session.user.id] });
  await f.client.execute('PRAGMA query_only = ON');
  try {
    await assert.rejects(f.store.community.privateState(member.session), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_profiles')).rows[0].n, 0);
  } finally { await f.client.execute('PRAGMA query_only = OFF'); }
});

test('paused participation hides non-votable current ideas by default and keeps them read-only in all-ideas mode', async t => {
  const f = await fixture(t);
  const row = await idea(f);
  const voter = await f.login('paused-voter');
  await f.client.execute("UPDATE service_control SET proposals_enabled = 0 WHERE id = 1");
  assert.equal((await f.store.community.publicFeed()).recent.length, 0);
  assert.equal((await f.store.community.publicIdeas()).total, 0);
  const feed = await f.store.community.publicFeed({ includeClosed: true });
  assert.equal(feed.recent[0].id, row.item.id);
  assert.equal(feed.recent[0].votingOpen, false);
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.remaining, 0);
  await assert.rejects(f.store.community.mutate(voter.session, ballot(row.item)), errorCode('PROPOSALS_PAUSED'));
});

test('a delayed daily vote is checked at database write time and cannot move an old idea to the next round', async t => {
  const f = await fixture(t, INITIAL_CUTOFF + DAY_MS - 1);
  const row = await idea(f);
  const voter = await f.login('delayed-daily-voter');
  let delayed = false;
  const client = { execute: (...args) => f.client.execute(...args), batch: async (statements, mode) => {
    if (!delayed && statements.some(statement => String(statement.sql || statement).includes('INSERT INTO community_votes'))) {
      delayed = true;
      await f.setTime(INITIAL_CUTOFF + DAY_MS);
    }
    return f.client.batch(statements, mode);
  } };
  const community = createCommunityStore(client, { databaseClockSql: TEST_CLOCK_SQL });
  await assert.rejects(community.mutate(voter.session, ballot(row.item)), errorCode('VOTING_CLOSED'));
  await assert.rejects(community.mutate(voter.session, ballot(row.item, 'up', { roundId: 'daily-2026-09-02' })), errorCode('VOTING_CLOSED'));
  assert.equal(delayed, true);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_votes')).rows[0].n, 0);
});

test('operator preparation backfills exact historical pending dates and current empty scope while preserving all business history', async t => {
  const f = await fixture(t, INITIAL_CUTOFF - 1);
  const original = await idea(f);
  const voter = await f.login('upgrade-initial-voter');
  await f.store.community.mutate(voter.session, ballot(original.item));
  await removeDailyPreparation(f);
  for (const time of [INITIAL_CUTOFF, INITIAL_CUTOFF + DAY_MS - 1, INITIAL_CUTOFF + DAY_MS]) {
    await f.setTime(time);
    await submit(f);
  }
  await f.setTime(INITIAL_CUTOFF + 3 * DAY_MS);
  const before = await records(f.client);
  const originalRound = (await f.client.execute("SELECT * FROM community_rounds WHERE id = 'initial'")).rows;
  const output = await prepareCommunityVotingRounds(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  assert.deepEqual(output, { prepared: true, schemaVersion: 1, serviceRevision: 1, roundsAdded: 3,
    existingVotesChanged: false, proposalsChanged: false, pointsIssued: false });
  assert.deepEqual(await records(f.client), before);
  assert.deepEqual((await f.client.execute("SELECT * FROM community_rounds WHERE id = 'initial'")).rows, originalRound);
  assert.deepEqual((await f.client.execute("SELECT id FROM community_rounds WHERE id GLOB 'daily-*' ORDER BY id")).rows.map(row => row.id),
    ['daily-2026-09-01', 'daily-2026-09-02', 'daily-2026-09-04']);
  assert.equal((await f.store.community.publicFeed()).recent.length, 0);
  assert.equal((await f.store.community.publicIdeas({ includeClosed: true })).total, 4);
  const again = await prepareCommunityVotingRounds(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  assert.equal(again.roundsAdded, 0);
  assert.deepEqual(await records(f.client), before);
  const newRow = await idea(f);
  assert.equal(newRow.item.roundId, 'daily-2026-09-04');
  assert.equal(newRow.item.votingOpen, true);
});

test('preparation rejects stale controls, paused service, incompatible rows or guard definitions without partial writes', async t => {
  for (const change of ['revision', 'paused', 'round', 'trigger', 'version']) await t.test(change, async nested => {
    const f = await fixture(nested);
    await removeDailyPreparation(f);
    if (change === 'paused') await f.client.execute("UPDATE service_control SET mode = 'maintenance' WHERE id = 1");
    if (change === 'round') await f.client.execute({ sql: `INSERT INTO community_rounds VALUES (?, ?, ?, ?)`,
      args: ['daily-2026-09-01', 'daily-2026-09-01', INITIAL_CUTOFF + 1, INITIAL_CUTOFF + DAY_MS] });
    if (change === 'trigger') await f.client.execute(`CREATE TRIGGER community_daily_proposal_round AFTER INSERT ON proposals
      BEGIN SELECT 1; END`);
    if (change === 'version') await f.client.execute("INSERT INTO community_meta VALUES ('daily_voting_rounds_schema_version', 99)");
    const before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
    const schema = (await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows;
    await assert.rejects(prepareCommunityVotingRounds(f.client, { expectedServiceRevision: change === 'revision' ? 2 : 1,
      databaseClockSql: TEST_CLOCK_SQL }), errorCode(change === 'revision' ? 'REVISION_CONFLICT'
      : change === 'paused' ? 'PROPOSALS_PAUSED' : 'COMMUNITY_SCHEMA_UNAVAILABLE'));
    assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
    assert.deepEqual((await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows, schema);
  });
});

test('daily guard compatibility preserves literal case and whitespace instead of accepting changed eligibility', async t => {
  for (const change of ['pending-case', 'pending-space', 'cap-case', 'cap-space']) await t.test(change, async nested => {
    const f = await fixture(nested);
    const name = change.startsWith('pending') ? 'community_daily_proposal_round' : 'community_daily_vote_insert_cap';
    const original = COMMUNITY_DAILY_ROUND_DDL.find(sql => sql.startsWith(`CREATE TRIGGER IF NOT EXISTS ${name}`));
    const altered = change === 'pending-case' ? original.replace("= 'pending'", "= 'PENDING'")
      : change === 'pending-space' ? original.replace("= 'pending'", "= ' pending'")
        : change === 'cap-case' ? original.replace("('up', 'down')", "('UP', 'down')")
          : original.replace("('up', 'down')", "('u p', 'down')");
    assert.notEqual(altered, original);
    await f.client.execute(`DROP TRIGGER ${name}`);
    await f.client.execute(altered);
    const before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
    const schema = (await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows;
    await assert.rejects(checkCommunitySchema(f.client), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
    await assert.rejects(prepareCommunityVotingRounds(f.client,
      { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL }), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
    assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
    assert.deepEqual((await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows, schema);
  });
});

test('preparation rechecks changed service controls in its write batch even when its metadata already exists', async t => {
  for (const prepared of [false, true]) await t.test(String(prepared), async nested => {
    const f = await fixture(nested);
    if (!prepared) await removeDailyPreparation(f);
    let changed = false;
    let before;
    let schema;
    const client = { execute: statement => f.client.execute(statement), batch: async (statements, mode) => {
      assert.equal(mode, 'write');
      assert.equal(changed, false);
      changed = true;
      await f.client.execute('UPDATE service_control SET revision = revision + 1 WHERE id = 1');
      before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
      schema = (await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows;
      return f.client.batch(statements, mode);
    } };
    await assert.rejects(prepareCommunityVotingRounds(client,
      { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL }), errorCode('REVISION_CONFLICT'));
    assert.equal(changed, true);
    assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
    assert.deepEqual((await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows, schema);
  });
});

test('a round insert failure rolls back the entire preparation including its early metadata guard and additive DDL', async t => {
  const f = await fixture(t);
  await removeDailyPreparation(f);
  await f.client.execute(`CREATE TRIGGER synthetic_round_failure BEFORE INSERT ON community_rounds
    WHEN NEW.id GLOB 'daily-*' BEGIN SELECT RAISE(ABORT, 'synthetic preparation failure'); END`);
  const before = await records(f.client, [...historyTables, 'community_rounds', 'community_meta']);
  const schema = (await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows;
  await assert.rejects(prepareCommunityVotingRounds(f.client,
    { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL }), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
  assert.deepEqual(await records(f.client, [...historyTables, 'community_rounds', 'community_meta']), before);
  assert.deepEqual((await f.client.execute('SELECT name, sql FROM sqlite_master ORDER BY name')).rows, schema);
});

test('dated round identities and boundaries cannot be edited, deleted or replaced after creation', async t => {
  const f = await fixture(t);
  const row = await idea(f);
  for (const sql of [
    'UPDATE community_rounds SET closes_at = closes_at + 1 WHERE id = ?',
    'DELETE FROM community_rounds WHERE id = ?',
    `INSERT OR REPLACE INTO community_rounds SELECT id, proposal_round_id, opens_at, closes_at + 1 FROM community_rounds WHERE id = ?`,
  ]) await assert.rejects(f.client.execute({ sql, args: [row.item.roundId] }), error => String(error.code).startsWith('SQLITE_CONSTRAINT'));
  // SQLite returns NULL when formatting a date outside its supported range.
  // Such a value must fail the guard, not pass through SQL's three-valued NOT.
  const unsupportedOpen = INITIAL_CUTOFF + 5000000 * DAY_MS;
  await assert.rejects(f.client.execute({ sql: 'INSERT INTO community_rounds VALUES (?, ?, ?, ?)',
    args: ['daily-unsupported', 'daily-unsupported', unsupportedOpen, unsupportedOpen + DAY_MS] }),
  error => String(error.code).startsWith('SQLITE_CONSTRAINT'));
  assert.equal(COMMUNITY_DAILY_ROUND_DDL.length, COMMUNITY_DAILY_ROUND_TRIGGER_NAMES.length);
});
