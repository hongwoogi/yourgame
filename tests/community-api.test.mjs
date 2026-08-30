import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiHandler } from '../server/app.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { ApiError } from '../server/errors.mjs';
import { apiErrorMessage } from '../public/error-messages.js';
import { backendFixture as baseFixture, request, signedHeaders } from './backend-helpers.mjs';

const change = (action, values = {}) => ({ action, requestId: randomUUID(), ...values });
const post = (f, login, body, options = {}) => request(f.handler, '/api/community', {
  method: 'POST', ...signedHeaders(login), body, ...options,
});

async function backendFixture(t) {
  const f = await baseFixture(t);
  // The production initializer uses its own authoritative database clock. Keep
  // this synthetic collection open at the fixture clock, independent of today.
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [f.now() - 1000] });
  return f;
}

async function participant(f, subject, name) {
  const anonymous = await f.store.createAnonymousSession();
  return f.store.completeLogin(anonymous.session, { googleSub: subject, name });
}

async function reviewedProposal(f, author, { approve = true, body = 'Add a forest with changing paths.' } = {}) {
  const created = await f.store.createProposal(author.session.user.id, { requestId: randomUUID(), body });
  const proposal = created.proposal;
  const shared = await post(f, author, change('set_publication', {
    proposalId: proposal.id, proposalRevision: proposal.revision, publicationRevision: 0, visible: true,
  }));
  assert.equal(shared.status, 200);
  if (approve) await approveProposal(f, proposal.id);
  return proposal;
}

async function approveProposal(f, proposalId) {
  const anonymous = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anonymous.session, {
    googleSub: 'community-test-admin', name: 'Private reviewer name', email: ADMIN_EMAIL, emailVerified: true,
  });
  const row = (await f.store.admin.query(admin.session, { section: 'proposals', limit: 50 })).items.find(item => item.id === proposalId);
  await f.store.admin.mutate(admin.session, change('review_proposal_safety', {
    proposalId, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
    policyVersion: row.safety.policyVersion, revision: row.safety.revision, status: 'approved',
    checklistConfirmed: true, developmentBrief: 'Add varied paths to the forest in the roguelike.',
    reason: 'Private review detail must never appear in the public community.',
  }));
}

test('anonymous community reads are bounded public DTOs and never create sessions or profiles', async t => {
  const f = await backendFixture(t);
  const author = await participant(f, 'private-google-subject', 'Private Google name');
  await f.store.createProposal(author.session.user.id, { requestId: randomUUID(), body: 'Private unshared idea.' });
  const sessionsBefore = (await f.client.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n;
  for (const url of ['/api/community', '/api/community?view=public']) {
    const result = await request(f.handler, url, { origin: null });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['leaderboard', 'popular', 'recent', 'round', 'scoring', 'serverTime']);
    assert.deepEqual(result.body.recent, []);
    assert.deepEqual(result.body.popular, []);
    assert.deepEqual(result.body.leaderboard, { items: [] });
    assert.equal(result.body.scoring.issuanceEnabled, false);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.match(result.headers['cache-control'], /no-store/);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(result.text, /Private Google name|private-google-subject|Private unshared idea/);
  }
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, sessionsBefore);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_profiles')).rows[0].n, 0);
});

test('only the consented, currently approved body is public under a separate generated identity', async t => {
  const f = await backendFixture(t);
  const author = await participant(f, 'private-author-subject', 'Google identity stays private');
  const proposal = await reviewedProposal(f, author, { approve: false });
  assert.deepEqual((await request(f.handler, '/api/community')).body.recent, []);
  await approveProposal(f, proposal.id);
  const result = await request(f.handler, '/api/community');
  assert.equal(result.status, 200);
  assert.equal(result.body.recent.length, 1);
  const idea = result.body.recent[0];
  assert.deepEqual(Object.keys(idea).sort(), [
    'author', 'body', 'createdAt', 'downvotes', 'id', 'proposalRevision', 'publicationRevision', 'roundId', 'upvotes', 'votingOpen',
  ]);
  assert.equal(idea.body, proposal.body);
  assert.notEqual(idea.id, proposal.id);
  assert.notEqual(idea.author.id, author.session.user.id);
  assert.deepEqual(Object.keys(idea.author).sort(), ['alias', 'id']);
  assert.match(idea.author.alias, /^Player-[a-f0-9]{12}$/);
  for (const secret of [author.session.user.id, proposal.id, 'Google identity stays private', 'private-author-subject',
    ADMIN_EMAIL, 'Private reviewer name', 'Private review detail', 'developmentBrief', 'bodyHash', 'csrfToken', 'tokenHash']) {
    assert.equal(result.text.includes(secret), false, `public DTO exposed ${secret}`);
  }
  assert.deepEqual(result.body.leaderboard.items, [], 'proposal publication is not leaderboard consent');
  await f.store.editProposal(author.session.user.id, { id: proposal.id, revision: 1, body: 'The changed body has not been reviewed or shared.' });
  assert.deepEqual((await request(f.handler, '/api/community')).body.recent, []);
});

test('private community state requires a live owner session and does not grant public visibility', async t => {
  const f = await backendFixture(t);
  const anonymous = await f.store.createAnonymousSession();
  for (const options of [{}, { cookie: `yourgame_session=${anonymous.token}` }]) {
    const response = await request(f.handler, '/api/community?view=me', options);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'LOGIN_REQUIRED');
    assert.equal(response.body.profile, undefined);
  }
  const login = await participant(f, 'private-reader', 'Never publish this name');
  const response = await request(f.handler, '/api/community?view=me', signedHeaders(login));
  assert.equal(response.status, 200);
  assert.equal(response.body.ownerId, login.session.user.id);
  assert.equal(response.body.profile.leaderboardVisible, false);
  assert.deepEqual(response.body.contribution, { points: '0', adoptedCount: 0 });
  assert.equal(response.body.voteQuota.remaining, 3);
  assert.deepEqual(response.body.votes, []);
  assert.deepEqual((await request(f.handler, '/api/community')).body.leaderboard.items, []);
  await f.store.logout(login.session);
  const revoked = await request(f.handler, '/api/community?view=me', signedHeaders(login));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.profile, undefined);
});

test('community view and method parsing reject ambiguous or unbounded requests before public reads', async t => {
  const f = await backendFixture(t);
  for (const query of ['view=public&view=me', 'view=public&view=public', 'view=', 'view=admin',
    'limit=1000000', 'ownerId=someone', `view=${'x'.repeat(200)}`]) {
    const result = await request(f.handler, `/api/community?${query}`);
    assert.equal(result.status, 422, query);
    assert.equal(result.body.error.code, 'INVALID_COMMUNITY_INPUT');
  }
  for (const method of ['DELETE', 'PATCH', 'PUT']) {
    const result = await request(f.handler, '/api/community', { method, body: {} });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, 'GET, POST');
  }
  const login = await f.login();
  const result = await request(f.handler, '/api/community?view=public', {
    method: 'POST', ...signedHeaders(login), body: change('set_profile_visibility', { visible: true, revision: 1 }),
  });
  assert.equal(result.status, 422);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_events')).rows[0].n, 0);
});

test('community writes enforce same origin, CSRF, JSON and a closed mutation action set', async t => {
  const f = await backendFixture(t);
  const login = await f.login();
  const operation = change('set_profile_visibility', { visible: true, revision: 1 });
  for (const options of [{ origin: null }, { origin: 'https://attacker.example' }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
    const result = await post(f, login, operation, options);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'ORIGIN_REJECTED');
  }
  const csrf = await post(f, login, operation, { csrf: 'forged' });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.body.error.code, 'CSRF_REJECTED');
  const wrongType = await post(f, login, operation, { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const malformed = await post(f, login, operation, { raw: '{broken' });
  assert.equal(malformed.status, 400);
  for (const body of [
    change('settle', { points: '999999', gamePublished: true, isAdmin: true }),
    { ...operation, points: '999999' }, { ...operation, userId: 'another-user' },
    { ...operation, alias: 'A Google name' }, { ...operation, visible: 'true' },
  ]) {
    const result = await post(f, login, body);
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'INVALID_COMMUNITY_INPUT');
  }
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM community_events')).rows[0].n, 0);
});

test('a confirmed vote is idempotent, separate from submission quota, and cannot mint contribution', async t => {
  const f = await backendFixture(t);
  const author = await participant(f, 'idea-author', 'Private author');
  await reviewedProposal(f, author);
  const voter = await participant(f, 'idea-supporter', 'Private voter');
  const idea = (await request(f.handler, '/api/community')).body.recent[0];
  const operation = change('vote', {
    publicId: idea.id, proposalRevision: idea.proposalRevision, publicationRevision: idea.publicationRevision,
    roundId: idea.roundId, direction: 'up',
  });
  const before = await f.store.listProposals(voter.session.user.id);
  const first = await post(f, voter, operation);
  const replay = await post(f, voter, operation);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  const publicResult = await request(f.handler, '/api/community');
  assert.equal(publicResult.body.recent[0].upvotes, 1);
  assert.equal(publicResult.body.recent[0].downvotes, 0);
  const own = await request(f.handler, '/api/community?view=me', signedHeaders(voter));
  assert.equal(own.body.voteQuota.used, 1);
  assert.equal(own.body.voteQuota.remaining, 2);
  assert.deepEqual(own.body.contribution, { points: '0', adoptedCount: 0 });
  assert.equal((await f.store.listProposals(voter.session.user.id)).quota.remaining, before.quota.remaining);
  assert.equal(publicResult.text.includes(voter.session.user.id), false);
  assert.equal(publicResult.text.includes('Private voter'), false);
  const conflict = await post(f, voter, { ...operation, direction: 'down' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await request(f.handler, '/api/status')).body.game.published, false);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
});

test('leaderboard opt-in shows actual zero points under an alias and opt-out immediately hides it', async t => {
  const f = await backendFixture(t);
  const login = await participant(f, 'leaderboard-opt-in', 'Private legal name');
  const state = (await request(f.handler, '/api/community?view=me', signedHeaders(login))).body;
  assert.equal((await post(f, login, change('set_profile_visibility', { visible: true, revision: state.profile.revision }))).status, 200);
  const board = (await request(f.handler, '/api/community')).body.leaderboard.items;
  assert.deepEqual(board, [{ rank: 1, author: { id: state.profile.id, alias: state.profile.alias }, points: '0', adoptedCount: 0 }]);
  const stateAfter = (await request(f.handler, '/api/community?view=me', signedHeaders(login))).body;
  assert.equal((await post(f, login, change('set_profile_visibility', { visible: false, revision: stateAfter.profile.revision }))).status, 200);
  assert.deepEqual((await request(f.handler, '/api/community')).body.leaderboard.items, []);
});

test('new community failures use selected English or Korean without exposing server diagnostics', async t => {
  const f = await backendFixture(t);
  for (const locale of ['en', 'ko']) {
    const headers = { 'x-yourgame-language': locale };
    const invalid = await request(f.handler, '/api/community?view=unknown', { headers });
    assert.equal(invalid.body.error.message, apiErrorMessage('INVALID_COMMUNITY_INPUT', locale));
    assert.equal(invalid.headers['content-language'], locale);
    const broken = createApiHandler({ config: f.config, now: f.now, log: () => {}, getStore: async () => {
      throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'PRIVATE database credentials and diagnostics');
    } });
    const failure = await request(broken, '/api/community', { headers });
    assert.equal(failure.status, 503);
    assert.equal(failure.body.error.message, apiErrorMessage('COMMUNITY_SCHEMA_UNAVAILABLE', locale));
    assert.equal(failure.headers['retry-after'], '3');
    assert.doesNotMatch(failure.text, /PRIVATE|credentials|diagnostics/);
  }
});
