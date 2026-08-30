import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { initializeDatabase } from '../server/database.mjs';
import { createCommunityStore, COMMUNITY_RATE_LIMIT, COMMUNITY_RATE_WINDOW_MS } from '../server/community-store.mjs';
import { checkCommunitySchema } from '../server/community-schema.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { backendFixture, errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const operation = (action, values = {}) => ({ action, requestId: randomUUID(), ...values });
const adminOperation = (action, values = {}) => operation(action, { reason: 'Synthetic independent review', ...values });

async function fixture(t, options) {
  const f = await backendFixture(t, options);
  // The real migration starts the initial community round at database wall
  // time. This synthetic database uses a deliberately controlled test clock.
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [Math.min(f.now() - 1000, INITIAL_CUTOFF - 1000)] });
  const anonymous = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anonymous.session, {
    googleSub: 'community-verified-admin', name: 'Private admin name', email: ADMIN_EMAIL, emailVerified: true,
  });
  return { ...f, admin, community: f.store.community };
}

async function create(f, member, body = 'A fantasy game with colorful jumping puzzles.') {
  return (await f.store.createProposal(member.session.user.id, { body, requestId: randomUUID() })).proposal;
}

async function review(f, proposalId, status = 'approved') {
  const row = (await f.store.admin.query(f.admin.session, { section: 'proposals', limit: 50 })).items.find(item => item.id === proposalId);
  await f.store.admin.mutate(f.admin.session, adminOperation('review_proposal_safety', {
    proposalId, proposalRevision: row.revision, bodyHash: row.safety.bodyHash, policyVersion: row.safety.policyVersion,
    revision: row.safety.revision, status, checklistConfirmed: status === 'approved',
    developmentBrief: status === 'approved' ? 'Implement colorful jumping puzzles in a fantasy setting.' : '',
  }));
}

async function publication(f, member, proposal, visible = true, overrides = {}) {
  const own = await f.community.privateState(member.session);
  const existing = own.publications.find(item => item.proposalId === proposal.id);
  const input = operation('set_publication', { proposalId: proposal.id, proposalRevision: proposal.revision,
    publicationRevision: existing?.publicationRevision ?? 0, visible, ...overrides });
  const result = await f.community.mutate(member.session, input);
  return { result, input, publicId: result.targetId };
}

async function publish(f, member, body) {
  const proposal = await create(f, member, body);
  await review(f, proposal.id);
  const shared = await publication(f, member, proposal);
  const item = (await f.community.privateState(member.session)).publications.find(value => value.proposalId === proposal.id);
  return { proposal, id: item.publicId, proposalRevision: item.proposalRevision,
    publicationRevision: item.publicationRevision, roundId: proposal.roundId === 'initial' ? 'initial' : null, ...shared };
}

function voteInput(item, direction = 'up', values = {}) {
  return operation('vote', { publicId: item.id, proposalRevision: item.proposalRevision,
    publicationRevision: item.publicationRevision, roundId: item.roundId, direction, ...values });
}

async function setService(f, changes) {
  const service = await f.store.admin.getService();
  return f.store.admin.mutate(f.admin.session, adminOperation('set_service', {
    mode: service.mode, proposalsEnabled: service.proposalsEnabled, developmentEnabled: service.developmentEnabled,
    message: service.message, revision: service.revision, ...changes,
  }));
}

async function count(f, table, userId) {
  const allowed = { community_events: 'actor_user_id', community_requests: 'user_id', community_votes: 'user_id', community_profiles: 'user_id' };
  assert.ok(Object.hasOwn(allowed, table));
  return Number((await f.client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}${userId ? ` WHERE ${allowed[table]} = ?` : ''}`,
    args: userId ? [userId] : [] })).rows[0].n);
}

test('community is private by default and uses independent generated identities with a strict public projection', async t => {
  const f = await fixture(t);
  const member = await f.login('private-google-subject');
  const proposal = await create(f, member, '  Private original idea\nwith preserved whitespace.  ');
  await review(f, proposal.id);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  assert.equal(await count(f, 'community_profiles'), 0);
  const own = await f.community.privateState(member.session);
  assert.equal(own.ownerId, member.session.user.id);
  assert.equal(own.profile.leaderboardVisible, false);
  assert.match(own.profile.alias, /^Player-[0-9a-f]{12}$/);
  assert.match(own.profile.id, /^[a-f0-9-]{36}$/);
  assert.notEqual(own.profile.id, member.session.user.id);
  assert.deepEqual(own.publications, [{ proposalId: proposal.id, proposalRevision: 1, publicationRevision: 0,
    publicId: null, requested: false, eligible: false }]);
  const shared = await publication(f, member, proposal);
  const item = (await f.community.publicFeed()).recent[0];
  assert.notEqual(item.id, proposal.id);
  assert.equal(item.id, shared.publicId);
  assert.equal(item.body, proposal.body);
  assert.deepEqual(Object.keys(item).sort(), ['author', 'body', 'createdAt', 'downvotes', 'id', 'proposalRevision', 'publicationRevision', 'roundId', 'upvotes', 'votingOpen']);
  assert.deepEqual(Object.keys(item.author).sort(), ['alias', 'id']);
  assert.deepEqual(item.author, { id: own.profile.id, alias: own.profile.alias });
  assert.doesNotMatch(JSON.stringify(item), /google|Private admin|Synthetic independent|bodyHash|reviewId|userId|email/i);
  assert.equal((await f.community.privateState(member.session)).profile.id, own.profile.id);
  assert.equal((await f.store.listProposals(member.session.user.id)).quota.remaining, 2);
});

test('pending consent becomes public only after explicit approval of the same source and current safety policy', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('viewer-subject');
  const proposal = await create(f, author);
  const shared = await publication(f, author, proposal);
  assert.equal((await f.community.privateState(author.session)).publications[0].requested, true);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  const input = voteInput({ id: shared.publicId, proposalRevision: 1, publicationRevision: 1, roundId: 'initial' });
  await assert.rejects(f.community.mutate(viewer.session, input), errorCode('PUBLICATION_UNAVAILABLE'));
  await review(f, proposal.id);
  assert.equal((await f.community.publicFeed()).recent[0].body, proposal.body);
  await f.community.mutate(viewer.session, input);
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 1);
  await f.client.execute("UPDATE safety_meta SET value = 'synthetic-next-policy' WHERE key = 'policy_version'");
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
});

test('publication changes use compare-and-swap and receipts cannot replay a hide/show transition or different payload', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const proposal = await create(f, author);
  await review(f, proposal.id);
  const original = operation('set_publication', { proposalId: proposal.id, proposalRevision: 1, publicationRevision: 0, visible: true });
  const secondStore = createCommunityStore(f.client, { databaseClockSql: TEST_CLOCK_SQL });
  const results = await Promise.all([f.community.mutate(author.session, original), secondStore.mutate(author.session, { ...original })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await count(f, 'community_events', author.session.user.id), 1);
  await assert.rejects(f.community.mutate(author.session, { ...original, visible: false }), errorCode('IDEMPOTENCY_CONFLICT'));
  const changed = await Promise.allSettled([
    publication(f, author, proposal, false, { publicationRevision: 1 }),
    publication(f, author, proposal, true, { publicationRevision: 1 }),
  ]);
  assert.equal(changed.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(changed.find(value => value.status === 'rejected').reason.code, 'COMMUNITY_REVISION_CONFLICT');
  const state = await f.community.privateState(author.session);
  assert.equal(state.publications[0].publicationRevision, 2);
  await f.community.mutate(author.session, original);
  assert.deepEqual((await f.community.privateState(author.session)).publications, state.publications);
  assert.equal(await count(f, 'community_events', author.session.user.id), 2);
  assert.equal(await count(f, 'community_requests', author.session.user.id), 2);
});

test('combined up/down voting has three atomic slots; switching, retries and cancellation have exact accounting', async t => {
  const f = await fixture(t);
  const viewer = await f.login('voter');
  const items = [];
  for (let index = 0; index < 6; index += 1) items.push(await publish(f, await f.login(`author-${index}`), `Puzzle idea ${index}.`));
  const inputs = items.map((item, index) => voteInput(item, index % 2 ? 'down' : 'up'));
  const repositories = await Promise.all(inputs.map(() => f.anotherStore()));
  const outcomes = await Promise.allSettled(inputs.map((input, index) => repositories[index].community.mutate(viewer.session, input)));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 3);
  assert.deepEqual(outcomes.filter(value => value.status === 'rejected').map(value => value.reason.code), Array(3).fill('VOTE_QUOTA_EXCEEDED'));
  const successful = outcomes.flatMap((value, index) => value.status === 'fulfilled' ? [index] : []);
  const first = successful[0];
  const before = await f.community.privateState(viewer.session);
  assert.deepEqual(before.voteQuota, { roundId: 'initial', limit: 3, used: 3, remaining: 0, closesAt: new Date(INITIAL_CUTOFF).toISOString() });
  await f.community.mutate(viewer.session, { ...inputs[first] });
  assert.equal(await count(f, 'community_events', viewer.session.user.id), 3);
  await assert.rejects(f.community.mutate(viewer.session, { ...inputs[first], direction: inputs[first].direction === 'up' ? 'down' : 'up' }), errorCode('IDEMPOTENCY_CONFLICT'));
  const switchDirection = inputs[first].direction === 'up' ? 'down' : 'up';
  await f.community.mutate(viewer.session, voteInput(items[first], switchDirection));
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 3);
  assert.equal((await f.community.privateState(viewer.session)).votes.find(item => item.publicId === items[first].id).direction, switchDirection);
  await f.community.mutate(viewer.session, voteInput(items[first], 'none'));
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.remaining, 1);
  const waiting = outcomes.findIndex(value => value.status === 'rejected');
  await f.community.mutate(viewer.session, inputs[waiting]);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 3);
  assert.equal(await count(f, 'community_events', viewer.session.user.id), 6);
});

test('three independent native database connections cannot allocate more than three combined vote slots', async t => {
  const f = await fixture(t);
  const viewer = await f.login('native-race-voter');
  const items = [];
  for (let index = 0; index < 12; index += 1) items.push(await publish(f, await f.login(`native-author-${index}`), `Native race puzzle ${index}.`));
  // Copy only this test's synthetic in-memory database to its unique temporary
  // directory. No production database, env file or user data is read.
  await f.client.execute({ sql: 'VACUUM INTO ?', args: [f.raceDatabaseUrl.slice('file:'.length)] });
  const tasks = Array.from({ length: 3 }, (_, number) => {
    const worker = new Worker(new URL('./fixtures/community-race-worker.mjs', import.meta.url), {
      workerData: { databaseUrl: f.raceDatabaseUrl, session: viewer.session,
        inputs: items.slice(number * 4, number * 4 + 4).map((item, index) => voteInput(item, index % 2 ? 'down' : 'up')) },
    });
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let final;
    const done = new Promise((resolve, reject) => {
      worker.on('error', error => { readyReject(error); reject(error); });
      worker.on('message', message => {
        if (message.ready) readyResolve();
        if (message.outcomes) final = message;
      });
      worker.on('exit', code => {
        if (code !== 0 || !final) {
          const error = new Error(`Native community worker exited without a complete result: ${code}`);
          readyReject(error); reject(error);
        } else resolve(final);
      });
    });
    t.after(() => worker.terminate());
    return { worker, ready, done };
  });
  await Promise.all(tasks.map(task => task.ready));
  for (const task of tasks) task.worker.postMessage('start');
  const completed = await Promise.all(tasks.map(task => task.done));
  const outcomes = completed.flatMap(value => value.outcomes);
  assert.equal(outcomes.filter(value => value === 'accepted').length, 3);
  assert.equal(outcomes.filter(value => value === 'VOTE_QUOTA_EXCEEDED').length, 9);
  assert.ok(completed.every(value => value.used === 3));
});

test('self voting, forged ownership and revoked sessions cannot affect another account or expose its publications', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('separate-voter');
  const item = await publish(f, author);
  await assert.rejects(f.community.mutate(author.session, voteInput(item)), errorCode('SELF_VOTE_FORBIDDEN'));
  await assert.rejects(f.community.mutate(viewer.session, operation('set_publication', {
    proposalId: item.proposal.id, proposalRevision: 1, publicationRevision: 1, visible: false,
  })), errorCode('NOT_PROPOSAL_OWNER'));
  const forged = { ...viewer.session, user: author.session.user };
  await assert.rejects(f.community.privateState(forged), errorCode('LOGIN_REQUIRED'));
  await assert.rejects(f.community.mutate(forged, voteInput(item)), errorCode('LOGIN_REQUIRED'));
  assert.deepEqual((await f.community.privateState(viewer.session)).publications, []);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', {
    userId: viewer.session.user.id, status: 'suspended', revision: 1,
  }));
  await assert.rejects(f.community.mutate(viewer.session, voteInput(item)), errorCode('LOGIN_REQUIRED'));
  assert.equal(await count(f, 'community_votes'), 0);
});

test('withdrawing and republishing consent creates a new generation and never resurrects previous votes', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('generation-voter');
  const item = await publish(f, author);
  const originalVote = voteInput(item);
  await f.community.mutate(viewer.session, originalVote);
  await publication(f, author, item.proposal, false);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  await publication(f, author, item.proposal, true);
  const republished = (await f.community.publicFeed()).recent[0];
  assert.equal(republished.id, item.id);
  assert.equal(republished.publicationRevision, 3);
  assert.equal(republished.upvotes, 0);
  await f.community.mutate(viewer.session, originalVote); // receipt, not a new vote
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  await assert.rejects(f.community.mutate(viewer.session, voteInput(item)), errorCode('COMMUNITY_REVISION_CONFLICT'));
  await f.community.mutate(viewer.session, voteInput(republished));
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 1);
});

test('editing requires new exact-content consent and approval without changing the submission quota or inheriting votes', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('edit-voter');
  const item = await publish(f, author, 'Original jump puzzle.');
  await f.community.mutate(viewer.session, voteInput(item));
  const edit = (await f.store.editProposal(author.session.user.id, { id: item.proposal.id, body: 'A revised colorful puzzle.', revision: 1 })).proposal;
  assert.equal(edit.revision, 2);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  const stale = (await f.community.privateState(author.session)).publications[0];
  assert.equal(stale.requested, true);
  assert.equal(stale.proposalRevision, 1);
  assert.equal(stale.eligible, false);
  await review(f, edit.id);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await assert.rejects(publication(f, author, item.proposal), errorCode('COMMUNITY_REVISION_CONFLICT'));
  await publication(f, author, edit);
  const visible = (await f.community.publicFeed()).recent[0];
  assert.equal(visible.body, edit.body);
  assert.equal(visible.proposalRevision, 2);
  assert.equal(visible.upvotes, 0);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  assert.equal((await f.store.listProposals(author.session.user.id)).quota.remaining, 2);
  assert.equal(edit.createdAt, item.proposal.createdAt);
});

test('holding/reapproving safety and excluding/restoring moderation invalidate old vote bindings permanently', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('review-voter');
  const item = await publish(f, author);
  await f.community.mutate(viewer.session, voteInput(item));
  await review(f, item.proposal.id, 'held');
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await review(f, item.proposal.id);
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 0);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  await f.community.mutate(viewer.session, voteInput(item));
  await f.store.admin.mutate(f.admin.session, adminOperation('moderate_proposal', { proposalId: item.proposal.id, moderation: 'excluded', revision: 1 }));
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await f.store.admin.mutate(f.admin.session, adminOperation('moderate_proposal', { proposalId: item.proposal.id, moderation: 'reviewed', revision: 2 }));
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 0);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
});

test('suspend/restore control revisions never reactivate old author consent or old voter choices', async t => {
  const f = await fixture(t);
  let author = await f.login('suspension-author');
  let viewer = await f.login('suspension-voter');
  const item = await publish(f, author);
  await f.community.mutate(viewer.session, voteInput(item));
  await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', { userId: viewer.session.user.id, status: 'suspended', revision: 1 }));
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 0);
  await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', { userId: viewer.session.user.id, status: 'active', revision: 2 }));
  viewer = await f.login('suspension-voter');
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
  await f.community.mutate(viewer.session, voteInput(item));
  await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', { userId: author.session.user.id, status: 'suspended', revision: 1 }));
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', { userId: author.session.user.id, status: 'active', revision: 2 }));
  author = await f.login('suspension-author');
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await publication(f, author, item.proposal);
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 0);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.used, 0);
});

test('exact round close disables new, switched and cancelled votes; pending proposals never get an unlimited voting round', async t => {
  const f = await fixture(t, { time: INITIAL_CUTOFF - 1000 });
  const author = await f.login();
  const viewer = await f.login('boundary-voter');
  const item = await publish(f, author);
  const input = voteInput(item);
  await f.community.mutate(viewer.session, input);
  await f.setTime(INITIAL_CUTOFF);
  for (const direction of ['up', 'down', 'none']) await assert.rejects(f.community.mutate(viewer.session, voteInput(item, direction)), errorCode('VOTING_CLOSED'));
  await f.community.mutate(viewer.session, input); // receipt is still readable
  const closedFeed = await f.community.publicFeed();
  assert.equal(closedFeed.round.status, 'closed');
  assert.equal(closedFeed.recent[0].votingOpen, false);
  assert.equal(closedFeed.recent[0].upvotes, 1);
  assert.equal((await f.community.privateState(viewer.session)).voteQuota.remaining, 0);
  const pending = await publish(f, author, 'Next-round puzzle suggestion.');
  const pendingItem = (await f.community.publicFeed()).recent.find(value => value.id === pending.id);
  assert.equal(pendingItem.roundId, null);
  assert.equal(pendingItem.votingOpen, false);
  await assert.rejects(f.community.mutate(viewer.session, voteInput(pendingItem, 'up', { roundId: 'initial' })), errorCode('VOTING_CLOSED'));
  assert.deepEqual((await f.client.execute('SELECT id FROM community_rounds')).rows.map(row => row.id), ['initial']);
});

test('a vote whose write is delayed until cutoff is rejected using database execution time', async t => {
  const f = await fixture(t, { time: INITIAL_CUTOFF - 1 });
  const author = await f.login();
  const viewer = await f.login('delayed-voter');
  const item = await publish(f, author);
  let delayed = false;
  const wrapper = { execute: (...args) => f.client.execute(...args), batch: async (statements, mode) => {
    if (!delayed && statements.some(statement => String(statement.sql || statement).includes('INSERT INTO community_votes'))) {
      delayed = true;
      await f.setTime(INITIAL_CUTOFF);
    }
    return f.client.batch(statements, mode);
  } };
  const store = createCommunityStore(wrapper, { databaseClockSql: TEST_CLOCK_SQL });
  await assert.rejects(store.mutate(viewer.session, voteInput(item)), errorCode('VOTING_CLOSED'));
  assert.equal(delayed, true);
  assert.equal(await count(f, 'community_votes'), 0);
  assert.equal(await count(f, 'community_events', viewer.session.user.id), 0);
});

test('last-write safety, privacy, membership and service changes cannot be bypassed by an earlier valid read', async t => {
  for (const change of ['safety', 'publication', 'voter', 'author', 'service']) {
    await t.test(change, async nested => {
      const f = await fixture(nested);
      const author = await f.login();
      const viewer = await f.login(`late-${change}-voter`);
      const item = await publish(f, author);
      let changed = false;
      const wrapper = { execute: (...args) => f.client.execute(...args), batch: async (statements, mode) => {
        if (!changed && statements.some(statement => String(statement.sql || statement).includes('INSERT INTO community_votes'))) {
          changed = true;
          if (change === 'safety') await review(f, item.proposal.id, 'held');
          if (change === 'publication') await publication(f, author, item.proposal, false);
          if (change === 'service') await setService(f, { mode: 'ended', confirmation: 'END SERVICE' });
          if (change === 'author' || change === 'voter') await f.store.admin.mutate(f.admin.session, adminOperation('set_user_status', {
            userId: change === 'author' ? author.session.user.id : viewer.session.user.id, status: 'suspended', revision: 1,
          }));
        }
        return f.client.batch(statements, mode);
      } };
      const store = createCommunityStore(wrapper, { databaseClockSql: TEST_CLOCK_SQL });
      const expected = { safety: 'PUBLICATION_UNAVAILABLE', publication: 'COMMUNITY_REVISION_CONFLICT',
        voter: 'LOGIN_REQUIRED', author: 'PUBLICATION_UNAVAILABLE', service: 'SERVICE_ENDED' };
      await assert.rejects(store.mutate(viewer.session, voteInput(item)), errorCode(expected[change]));
      assert.equal(changed, true);
      assert.equal(await count(f, 'community_votes'), 0);
      assert.equal(await count(f, 'community_events', viewer.session.user.id), 0);
    });
  }
});

test('delayed publication consent cannot transfer across a source edit', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const proposal = await create(f, author);
  await review(f, proposal.id);
  let changed = false;
  const wrapper = { execute: (...args) => f.client.execute(...args), batch: async (statements, mode) => {
    if (!changed && statements.some(statement => String(statement.sql || statement).includes('INSERT INTO community_publications'))) {
      changed = true;
      await f.store.editProposal(author.session.user.id, { id: proposal.id, revision: 1, body: 'A different valid puzzle.' });
    }
    return f.client.batch(statements, mode);
  } };
  const store = createCommunityStore(wrapper, { databaseClockSql: TEST_CLOCK_SQL });
  await assert.rejects(store.mutate(author.session, operation('set_publication', {
    proposalId: proposal.id, proposalRevision: 1, publicationRevision: 0, visible: true,
  })), errorCode('COMMUNITY_REVISION_CONFLICT'));
  assert.equal(changed, true);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  assert.equal((await f.community.privateState(author.session)).publications[0].requested, false);
  assert.equal(await count(f, 'community_events', author.session.user.id), 0);
});

test('service controls gate publication, opt-in and voting while explicit privacy opt-out remains available', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('controls-voter');
  const item = await publish(f, author);
  const profile = (await f.community.privateState(author.session)).profile;
  await f.community.mutate(author.session, operation('set_profile_visibility', { visible: true, revision: profile.revision }));
  await setService(f, { mode: 'maintenance' });
  assert.equal((await f.community.publicFeed()).recent[0].votingOpen, false);
  await assert.rejects(publication(f, author, item.proposal), errorCode('SERVICE_MAINTENANCE'));
  await assert.rejects(f.community.mutate(viewer.session, voteInput(item)), errorCode('SERVICE_MAINTENANCE'));
  await f.community.mutate(author.session, operation('set_profile_visibility', { visible: false, revision: 2 }));
  await publication(f, author, item.proposal, false);
  assert.deepEqual((await f.community.publicFeed()).recent, []);
  await setService(f, { mode: 'ended', confirmation: 'END SERVICE' });
  await publication(f, author, item.proposal, false);
  await f.community.mutate(author.session, operation('set_profile_visibility', { visible: false, revision: 3 }));
  await assert.rejects(f.community.mutate(author.session, operation('set_profile_visibility', { visible: true, revision: 4 })), errorCode('SERVICE_ENDED'));
  await assert.rejects(f.community.mutate(viewer.session, voteInput(item)), errorCode('SERVICE_ENDED'));
  assert.equal((await f.store.listProposals(author.session.user.id)).proposals[0].body, item.proposal.body);
});

test('the per-account attempt cap includes failed requests and receipts, is atomic and resets only at the fixed window boundary', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const other = await f.login('independent-rate-account');
  const state = await f.community.privateState(author.session);
  const first = operation('set_profile_visibility', { visible: true, revision: state.profile.revision });
  await f.community.mutate(author.session, first);
  const attempts = await Promise.allSettled(Array.from({ length: 35 }, (_, index) => f.community.mutate(author.session,
    index % 2 ? first : operation('set_profile_visibility', { visible: true, revision: 'invalid' }))));
  assert.equal(attempts.filter(value => value.status === 'rejected' && value.reason.code === 'COMMUNITY_RATE_LIMITED').length, 6);
  assert.equal(await count(f, 'community_events', author.session.user.id), 1);
  assert.equal(await count(f, 'community_requests', author.session.user.id), 1);
  const row = (await f.client.execute({ sql: 'SELECT used, expires_at FROM community_rate_windows WHERE user_id = ?', args: [author.session.user.id] })).rows[0];
  assert.equal(Number(row.used), COMMUNITY_RATE_LIMIT);
  const otherState = await f.community.privateState(other.session);
  await f.community.mutate(other.session, operation('set_profile_visibility', { visible: true, revision: otherState.profile.revision }));
  await f.setTime(Number(row.expires_at) - 1);
  await assert.rejects(f.community.mutate(author.session, first), error => error.code === 'COMMUNITY_RATE_LIMITED' && error.details.retryAfterSeconds === 1);
  await f.setTime(Number(row.expires_at));
  await f.community.mutate(author.session, first);
  assert.equal(await count(f, 'community_events', author.session.user.id), 1);
  assert.equal(Number((await f.client.execute({ sql: 'SELECT used FROM community_rate_windows WHERE user_id = ?', args: [author.session.user.id] })).rows[0].used), 1);
});

test('rate cleanup is bounded, stores no request content and malformed attempts cannot mint actions', async t => {
  const f = await fixture(t);
  const member = await f.login();
  const userId = member.session.user.id;
  await f.client.batch(Array.from({ length: 150 }, (_, index) => ({ sql: 'INSERT INTO community_rate_windows(user_id, window_start, used, expires_at) VALUES (?, ?, 1, ?)',
    args: [userId, f.now() - (index + 2) * COMMUNITY_RATE_WINDOW_MS, f.now() - (index + 1) * COMMUNITY_RATE_WINDOW_MS] })), 'write');
  await assert.rejects(f.community.mutate(member.session, operation('award_points', { points: '999', admin: true })), errorCode('INVALID_COMMUNITY_INPUT'));
  const rows = (await f.client.execute('SELECT * FROM community_rate_windows')).rows;
  assert.equal(rows.length, 51);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['expires_at', 'used', 'user_id', 'window_start']);
  assert.equal(await count(f, 'community_events'), 0);
  assert.equal(await count(f, 'community_profiles'), 0);
});

test('public lists are bounded and net-vote ordering has deterministic upvote, time and identity tie breaks', async t => {
  const f = await fixture(t);
  const items = [];
  for (let index = 0; index < 8; index += 1) {
    await f.setTime(f.now() + 1);
    items.push(await publish(f, await f.login(`sort-author-${index}`), `Distinct puzzle ${index}.`));
  }
  const voterA = await f.login('sort-voter-a');
  const voterB = await f.login('sort-voter-b');
  const voterC = await f.login('sort-voter-c');
  await f.community.mutate(voterA.session, voteInput(items[0]));
  await f.community.mutate(voterA.session, voteInput(items[1]));
  await f.community.mutate(voterB.session, voteInput(items[1]));
  await f.community.mutate(voterC.session, voteInput(items[1], 'down'));
  await f.community.mutate(voterB.session, voteInput(items[7], 'down'));
  const feed = await f.community.publicFeed();
  assert.equal(feed.recent.length, 6);
  assert.deepEqual(feed.recent.map(item => item.id), items.slice(2).reverse().map(item => item.id));
  assert.equal(feed.popular.length, 6);
  assert.deepEqual(feed.popular.slice(0, 2).map(item => item.id), [items[1].id, items[0].id]);
  assert.deepEqual(feed.popular.slice(2).map(item => item.id), items.slice(3, 7).reverse().map(item => item.id));
  assert.deepEqual((await f.community.publicFeed()).popular, feed.popular);
});

test('additive migration preserves private originals and append-only audit, receipts and independent identities', async t => {
  const f = await fixture(t);
  const author = await f.login();
  const viewer = await f.login('migration-voter');
  const item = await publish(f, author);
  await f.community.mutate(viewer.session, voteInput(item));
  const before = await f.community.privateState(author.session);
  const voteBefore = await f.community.privateState(viewer.session);
  await initializeDatabase(f.client);
  await f.store.health();
  assert.deepEqual(await f.community.privateState(author.session), before);
  assert.deepEqual(await f.community.privateState(viewer.session), voteBefore);
  for (const table of ['schema_meta', 'admin_meta', 'safety_meta', 'community_meta']) {
    assert.equal(Number((await f.client.execute(`SELECT value FROM ${table} WHERE key = 'schema_version'`)).rows[0].value), 1);
  }
  for (const sql of ["UPDATE community_profiles SET alias = 'Player-000000000000'", 'UPDATE community_publications SET public_id = proposal_id',
    "UPDATE community_events SET details_json = '{}'", 'DELETE FROM community_events',
    'INSERT OR REPLACE INTO community_events SELECT * FROM community_events LIMIT 1',
    "UPDATE community_requests SET response_json = '{}'", 'DELETE FROM community_requests',
    'INSERT OR REPLACE INTO community_requests SELECT * FROM community_requests LIMIT 1']) {
    await assert.rejects(f.client.execute(sql));
  }
  assert.equal((await f.store.listProposals(author.session.user.id)).proposals[0].body, item.proposal.body);
  assert.equal((await f.community.publicFeed()).recent[0].upvotes, 1);
  assert.equal(SAFETY_POLICY_VERSION, 'teen-v1');
});

test('missing community integrity schema is a safe explicit outage, not a successful empty feed', async t => {
  const f = await fixture(t);
  await f.client.execute('DROP TRIGGER community_events_no_replace');
  await assert.rejects(checkCommunitySchema(f.client), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
  await assert.rejects(f.store.health(), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
  await initializeDatabase(f.client);
  await f.store.health();
  await f.client.execute('DROP TABLE community_requests');
  await assert.rejects(checkCommunitySchema(f.client), error => error.code === 'COMMUNITY_SCHEMA_UNAVAILABLE'
    && !/SQLITE|no such|community_requests/.test(error.message));
});
