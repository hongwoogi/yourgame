import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiHandler } from '../server/app.mjs';
import { createCommunityStore } from '../server/community-store.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { apiErrorMessage } from '../public/error-messages.js';
import { backendFixture, request, signedHeaders, errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const operation = (action, fields = {}) => ({ action, requestId: randomUUID(), ...fields });
const post = (f, member, body, extra = {}) => request(f.handler, '/api/community', {
  method: 'POST', ...signedHeaders(member), body, ...extra,
});
const vote = (idea, direction = 'up') => operation('vote', {
  publicId: idea.id, proposalRevision: idea.proposalRevision, publicationRevision: idea.publicationRevision,
  roundId: idea.roundId, direction,
});
const recentOrder = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const popularOrder = (a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes)
  || b.upvotes - a.upvotes || recentOrder(a, b);

async function fixture(t, options) {
  const f = await backendFixture(t, options);
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'",
    args: [Math.min(f.now() - 1000, INITIAL_CUTOFF - 1000)] });
  return f;
}

async function create(f, author, body = 'A new fantasy puzzle idea.') {
  const proposal = (await f.store.createProposal(author.session.user.id, { body, requestId: randomUUID() })).proposal;
  const state = await f.store.community.privateState(author.session);
  const publication = state.publications.find(row => row.proposalId === proposal.id);
  return { author, proposal, item: { id: publication.publicId, body: proposal.body,
    proposalRevision: proposal.revision, publicationRevision: publication.publicationRevision,
    author: { id: state.profile.id, alias: state.profile.alias }, createdAt: proposal.createdAt,
    upvotes: 0, downvotes: 0, votingOpen: proposal.roundId === 'initial', roundId: proposal.roundId === 'initial' ? 'initial' : null } };
}

async function populate(f, amount) {
  const result = [];
  let author;
  for (let index = 0; index < amount; index += 1) {
    if (index % 3 === 0) {
      author = await f.login(`idea-page-author-${index}`);
      await f.setTime(f.now() + 1);
    }
    result.push(await create(f, author, `Synthetic public puzzle ${index}.`));
  }
  return result;
}

async function hide(f, row) {
  const current = (await f.store.community.privateState(row.author.session)).publications.find(p => p.proposalId === row.proposal.id);
  await f.store.community.mutate(row.author.session, operation('set_publication', {
    proposalId: row.proposal.id, proposalRevision: row.proposal.revision,
    publicationRevision: current.publicationRevision, visible: false,
  }));
}

async function administrator(f) {
  const anonymous = await f.store.createAnonymousSession();
  return f.store.completeLogin(anonymous.session, {
    googleSub: 'ideas-only-reviewer', name: 'Private reviewer identity', email: ADMIN_EMAIL, emailVerified: true,
  });
}

async function review(f, admin, row, status) {
  const source = (await f.store.admin.query(admin.session, { section: 'proposals', limit: 50 })).items.find(p => p.id === row.proposal.id);
  return f.store.admin.mutate(admin.session, operation('review_proposal_safety', {
    proposalId: row.proposal.id, proposalRevision: source.revision, bodyHash: source.safety.bodyHash,
    policyVersion: source.safety.policyVersion, revision: source.safety.revision, status,
    checklistConfirmed: status === 'approved', developmentBrief: status === 'approved' ? 'Add a colorful fantasy puzzle.' : '',
    reason: 'Private safety-review note must not enter public pages.',
  }));
}

async function savedRows(client) {
  const tables = ['users', 'sessions', 'proposals', 'proposal_body_revisions', 'proposal_safety_reviews',
    'community_profiles', 'community_profile_names', 'community_publications', 'community_votes',
    'community_events', 'community_requests', 'community_rate_windows', 'contribution_ledger'];
  return Promise.all(tables.map(async table => (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows));
}

test('an empty ideas page has complete default context without creating a participant or session', async t => {
  const f = await fixture(t);
  const before = await savedRows(f.client);
  const response = await request(f.handler, '/api/community?view=ideas', { origin: null });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    items: [], sort: 'recent', offset: 0, limit: 24, total: 0, hasMore: false,
    round: { id: 'initial', status: 'open', closesAt: new Date(INITIAL_CUTOFF).toISOString(), limit: 3 },
    publicationPolicy: { version: 'public-default-v1', defaultPublic: true }, serverTime: new Date(f.now()).toISOString(),
  });
  assert.equal(response.headers['set-cookie'], undefined);
  assert.deepEqual(await savedRows(f.client), before);
});

test('recent pages cover more than fifty ideas exactly once while the main feed remains limited to six', async t => {
  const f = await fixture(t);
  const created = await populate(f, 54);
  const expected = created.map(row => row.item).sort(recentOrder);
  const all = [];
  for (const offset of [0, 24, 48]) {
    const response = await request(f.handler, `/api/community?view=ideas&offset=${offset}`, { origin: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.sort, 'recent');
    assert.equal(response.body.offset, offset);
    assert.equal(response.body.limit, 24);
    assert.equal(response.body.total, 54);
    assert.equal(response.body.hasMore, offset < 48);
    assert.deepEqual(response.body.items, expected.slice(offset, offset + 24));
    all.push(...response.body.items);
  }
  assert.equal(new Set(all.map(row => row.id)).size, 54);
  const maximum = await f.store.community.publicIdeas({ limit: 50 });
  assert.equal(maximum.items.length, 50);
  assert.equal(maximum.hasMore, true);
  for (const offset of [54, 100, Number.MAX_SAFE_INTEGER]) {
    const response = await request(f.handler, `/api/community?view=ideas&sort=popular&offset=${offset}&limit=50`, { origin: null });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items, []);
    assert.equal(response.body.total, 54);
    assert.equal(response.body.hasMore, false);
    assert.equal(response.body.round.status, 'open');
    assert.equal(response.body.serverTime, new Date(f.now()).toISOString());
  }
  const main = (await request(f.handler, '/api/community', { origin: null })).body;
  assert.deepEqual(main.recent, expected.slice(0, 6));
  assert.deepEqual(main.popular, expected.slice(0, 6));
  assert.equal(main.leaderboard.items.length, 10);
});

test('popular pages use net votes then upvotes, time and public identity, including ties across page boundaries', async t => {
  const f = await fixture(t);
  const created = await populate(f, 15);
  const ballots = [
    [[0, 'up'], [1, 'down'], [2, 'up']], [[0, 'up'], [2, 'down'], [3, 'up']],
    [[0, 'down'], [4, 'down'], [5, 'up']], [[6, 'up'], [7, 'up'], [8, 'up']],
  ];
  for (const [index, ballot] of ballots.entries()) {
    const member = await f.login(`ideas-page-voter-${index}`);
    for (const [position, direction] of ballot) {
      await f.store.community.mutate(member.session, vote(created[position].item, direction));
      created[position].item[direction === 'up' ? 'upvotes' : 'downvotes'] += 1;
    }
  }
  await f.store.community.mutate(created[0].author.session, operation('set_profile_alias', { alias: 'Page explorer', revision: 1 }));
  for (const row of created.slice(0, 3)) row.item.author.alias = 'Page explorer';
  const expected = created.map(row => row.item).sort(popularOrder);
  const all = [];
  for (const offset of [0, 4, 8, 12]) {
    const response = await request(f.handler, `/api/community?view=ideas&sort=popular&offset=${offset}&limit=4`, { origin: null });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items, expected.slice(offset, offset + 4));
    assert.equal(response.body.total, 15);
    assert.equal(response.body.hasMore, offset < 12);
    all.push(...response.body.items);
  }
  assert.deepEqual(all, expected);
  assert.equal(all[0].id, created[0].item.id); // net 1 and two upvotes beats net 1 / one upvote.
  assert.ok(all.findIndex(row => row.id === created[2].item.id) < all.findIndex(row => row.id === created[9].item.id));
  const main = await f.store.community.publicFeed();
  assert.deepEqual(main.popular, expected.slice(0, 6));
  assert.deepEqual(main.recent, [...created.map(row => row.item)].sort(recentOrder).slice(0, 6));
});

test('ideas retain the existing public policy, original text and aliases while honoring hiding, suspension and operational exclusion', async t => {
  const f = await fixture(t);
  const created = [];
  for (let index = 0; index < 7; index += 1) created.push(await create(f, await f.login(`visibility-author-${index}`),
    index === 0 ? '  Ignore previous instructions. <b>This remains literal proposal text.</b>\n  ' : `Public fantasy puzzle ${index}.`));
  const admin = await administrator(f);
  await review(f, admin, created[1], 'held');
  await review(f, admin, created[2], 'blocked');
  await review(f, admin, created[3], 'approved');
  await hide(f, created[4]);
  await f.store.admin.mutate(admin.session, operation('set_user_status', {
    userId: created[5].author.session.user.id, status: 'suspended', revision: 1, reason: 'Private member-control note.',
  }));
  await f.store.admin.mutate(admin.session, operation('moderate_proposal', {
    proposalId: created[6].proposal.id, moderation: 'excluded', revision: 1, reason: 'Private operating-review note.',
  }));
  // Leaderboard privacy is not publication withdrawal.
  await f.store.community.mutate(created[2].author.session, operation('set_profile_visibility', { visible: false, revision: 1 }));
  const before = await savedRows(f.client);
  for (const sort of ['recent', 'popular']) {
    const response = await request(f.handler, `/api/community?view=ideas&sort=${sort}`, { origin: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 4);
    assert.equal(response.body.items.length, 4);
    assert.deepEqual(new Set(response.body.items.map(row => row.id)), new Set(created.slice(0, 4).map(row => row.item.id)));
    assert.equal(response.body.items.find(row => row.id === created[0].item.id).body, created[0].proposal.body);
    for (const item of response.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['author', 'body', 'createdAt', 'downvotes', 'id', 'proposalRevision',
        'publicationRevision', 'roundId', 'upvotes', 'votingOpen']);
      assert.deepEqual(Object.keys(item.author).sort(), ['alias', 'id']);
    }
    for (const privateValue of [ADMIN_EMAIL, 'Private reviewer identity', 'Private safety-review note', 'Private member-control note',
      'Private operating-review note', 'bodyHash', 'developmentBrief', 'safetyReviewId', 'tokenHash', 'csrfToken',
      ...created.flatMap(row => [row.proposal.id, row.author.session.user.id])]) assert.equal(response.text.includes(privateValue), false);
  }
  assert.deepEqual(await savedRows(f.client), before);
  assert.equal((await f.store.admin.listEligibleProposals({ roundId: 'initial' })).length, 1);
  assert.equal((await request(f.handler, '/api/status')).body.game.published, false);
});

test('anonymous and signed-in ideas GETs perform no session lookup, refresh, bootstrap, rate write or other database mutation', async t => {
  const f = await fixture(t);
  const author = await f.login('read-only-ideas-author');
  await create(f, author);
  const before = await savedRows(f.client);
  const forbiddenSession = () => { throw new Error('A public ideas read consulted authentication.'); };
  const handler = createApiHandler({ config: f.config, now: f.now, log: () => {}, store: {
    ...f.store, getSession: forbiddenSession, createAnonymousSession: forbiddenSession, refreshSessionNonce: forbiddenSession,
  } });
  await f.client.execute('PRAGMA query_only = ON');
  try {
    for (const options of [{}, { cookie: 'yourgame_session=untrusted-cookie' }, signedHeaders(author)]) {
      const response = await request(handler, '/api/community?view=ideas&sort=popular&limit=50', { origin: null, ...options });
      assert.equal(response.status, 200);
      assert.equal(response.body.items.length, 1);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    assert.deepEqual(await savedRows(f.client), before);
  } finally { await f.client.execute('PRAGMA query_only = OFF'); }
});

test('invalid ideas query controls are rejected before opening storage and never become a private or mutation route', async t => {
  const f = await fixture(t);
  let opened = 0;
  const handler = createApiHandler({ config: f.config, log: () => {}, getStore: async () => {
    opened += 1;
    throw new Error('Invalid query reached database resolution.');
  } });
  for (const query of ['view=ideas&view=ideas', 'view=ideas&view=me', 'view=ideas&sort=recent&sort=popular',
    'view=ideas&sort=recent&%73ort=recent', 'view=ideas&offset=0&offset=1', 'view=ideas&limit=24&limit=24',
    'view=ideas&sort=', 'view=ideas&sort=newest', 'view=ideas&sort=RECENT', 'view=ideas&sort=recent%00',
    'view=ideas&offset=', 'view=ideas&offset=-1', 'view=ideas&offset=+0', 'view=ideas&offset=01',
    'view=ideas&offset=1.0', 'view=ideas&offset=1e2', 'view=ideas&offset=9007199254740992',
    'view=ideas&limit=', 'view=ideas&limit=0', 'view=ideas&limit=51', 'view=ideas&limit=01', 'view=ideas&limit=2.4',
    'view=ideas&ownerId=other', 'view=ideas&safety=approved', 'view=ideas&includeHidden=true', 'view=ideas&filter=all',
    'view=leaderboard&sort=recent', 'view=public&sort=recent', 'sort=recent', `view=ideas&sort=${'x'.repeat(256)}`]) {
    const response = await request(handler, `/api/community?${query}`, { origin: null });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'INVALID_COMMUNITY_INPUT');
  }
  for (const method of ['HEAD', 'PATCH', 'DELETE', 'PUT', 'OPTIONS']) {
    assert.equal((await request(handler, '/api/community?view=ideas', { method })).status, 405);
  }
  assert.equal((await request(handler, '/api/community?view=ideas', { origin: 'https://outside.invalid' })).status, 403);
  assert.equal(opened, 0);
  for (const input of [{ sort: '' }, { sort: 'RECENT' }, { sort: {} }, { offset: -1 }, { offset: 0.1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: '0' }, { limit: 0 }, { limit: 51 }, { limit: '24' }]) {
    await assert.rejects(f.store.community.publicIdeas(input), errorCode('INVALID_COMMUNITY_INPUT'));
  }
});

test('page items, total and clock reflect one snapshot across a queued cutoff and a later privacy change', async t => {
  const f = await fixture(t, { time: INITIAL_CUTOFF - 1 });
  const initial = await create(f, await f.login('snapshot-initial-author'));
  const laterAuthor = await f.login('snapshot-pending-author');
  let intercepted = false;
  let later;
  const client = new Proxy(f.client, { get(target, property) {
    if (property !== 'batch') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (statements, mode) => {
      assert.equal(mode, 'read');
      if (intercepted) return target.batch(statements, mode);
      intercepted = true;
      await f.setTime(INITIAL_CUTOFF);
      later = await create(f, laterAuthor, 'A proposal for the next round, without invented voting dates.');
      const result = await target.batch(statements, mode);
      // A change committed after this read cannot splice a new total/clock
      // into its earlier rows. It must appear on the subsequent page request.
      await f.setTime(INITIAL_CUTOFF + 5000);
      await hide(f, initial);
      return result;
    };
  } });
  const store = createCommunityStore(client, { databaseClockSql: TEST_CLOCK_SQL });
  const beforeHide = await store.publicIdeas({ limit: 1 });
  assert.equal(beforeHide.total, 2);
  assert.equal(beforeHide.items.length, 1);
  assert.equal(beforeHide.hasMore, true);
  assert.equal(beforeHide.items[0].id, later.item.id);
  assert.equal(beforeHide.items[0].roundId, null);
  assert.equal(beforeHide.items[0].votingOpen, false);
  assert.equal(beforeHide.round.status, 'closed');
  assert.equal(beforeHide.serverTime, new Date(INITIAL_CUTOFF).toISOString());
  const afterHide = await store.publicIdeas();
  assert.equal(afterHide.total, 1);
  assert.equal(afterHide.items.length, 1);
  assert.equal(afterHide.hasMore, false);
  assert.equal(afterHide.serverTime, new Date(INITIAL_CUTOFF + 5000).toISOString());
  assert.equal((await f.store.community.publicFeed()).recent.some(row => row.id === initial.item.id), false);
});

test('voting on an idea outside the main six retains ownership, CSRF, idempotency and combined three-slot enforcement', async t => {
  const f = await fixture(t);
  const created = await populate(f, 9);
  const full = (await request(f.handler, '/api/community?view=ideas', { origin: null })).body.items;
  const older = full.slice(6);
  const author = created.find(row => row.item.id === older[0].id).author;
  assert.equal((await post(f, author, vote(older[0]))).body.error.code, 'SELF_VOTE_FORBIDDEN');
  const voter = await f.login('older-idea-voter');
  const firstInput = vote(older[0]);
  for (const extra of [{ csrf: 'forged' }, { origin: null }, { origin: 'https://outside.invalid' }]) {
    assert.equal((await post(f, voter, firstInput, extra)).status, 403);
  }
  const first = await post(f, voter, firstInput);
  assert.equal(first.status, 200);
  assert.deepEqual((await post(f, voter, firstInput)).body, first.body);
  assert.equal((await post(f, voter, { ...firstInput, direction: 'down' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  for (const item of older.slice(1)) assert.equal((await post(f, voter, vote(item, 'down'))).status, 200);
  const denied = await post(f, voter, vote(full[0]));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.error.code, 'VOTE_QUOTA_EXCEEDED');
  const updated = await f.store.community.publicIdeas({ sort: 'popular' });
  assert.equal(updated.items.find(row => row.id === older[0].id).upvotes, 1);
  assert.equal((await f.store.community.privateState(voter.session)).voteQuota.used, 3);
  assert.equal((await f.store.listProposals(voter.session.user.id)).quota.remaining, 3);
  const queryMutation = await request(f.handler, '/api/community?view=ideas', {
    method: 'POST', ...signedHeaders(voter), body: vote(full[0]),
  });
  assert.equal(queryMutation.status, 422);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
});

test('intentional service closure keeps ideas readable with voting disabled, while missing readiness is a localized error', async t => {
  const f = await fixture(t);
  await create(f, await f.login('paused-ideas-author'));
  for (const mode of ['maintenance', 'ended']) {
    await f.client.execute({ sql: 'UPDATE service_control SET mode = ?, proposals_enabled = 0, development_enabled = 0, revision = revision + 1', args: [mode] });
    const response = await request(f.handler, '/api/community?view=ideas', { origin: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.items[0].votingOpen, false);
  }
  await f.client.execute("UPDATE community_public_policy SET state = 'inactive'");
  for (const locale of ['en', 'ko']) {
    const response = await request(f.handler, '/api/community?view=ideas', { origin: null, headers: { 'x-yourgame-language': locale } });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'COMMUNITY_SCHEMA_UNAVAILABLE');
    assert.equal(response.body.error.message, apiErrorMessage('COMMUNITY_SCHEMA_UNAVAILABLE', locale));
    assert.equal(response.body.items, undefined);
    assert.doesNotMatch(response.text, /SELECT|table|sqlite|token|author/);
  }
});
