import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createApiHandler } from '../server/app.mjs';
import { readConfig, INITIAL_CUTOFF, FIRST_RELEASE, WINDOW_MS, GOOGLE_NONCE_MS, SESSION_CREATION_LIMIT } from '../server/config.mjs';
import { createStore, hashValue, validateBody } from '../server/store.mjs';
import { initializeDatabase } from '../server/database.mjs';
import { backendFixture, errorCode, request, signedHeaders, TEST_CLOCK_SQL } from './backend-helpers.mjs';
import { ANONYMOUS_USER_ID } from '../server/anonymous-policy.mjs';

test('three database clients racing in separate workers cannot exceed the rolling quota', async t => {
  const f = await backendFixture(t);
  const login = await f.login();
  const tasks = [];
  for (let number = 0; number < 3; number += 1) {
    const worker = new Worker(new URL('./fixtures/proposal-race-worker.mjs', import.meta.url), {
      workerData: { databaseUrl: f.raceDatabaseUrl, userId: login.session.user.id, number, seed: number === 0, now: f.now() },
    });
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    let finalMessage;
    const done = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.ready) readyResolve();
        if (message.results) finalMessage = message;
      });
      worker.on('exit', code => {
        if (code !== 0) reject(new Error(`worker exited: ${code}`));
        else if (!finalMessage) reject(new Error('worker exited without results'));
        else resolve(finalMessage);
      });
    });
    t.after(() => worker.terminate());
    tasks.push({ worker, ready, done });
    // Initialize schema/user before the other connections are opened.
    if (number === 0) await ready;
  }
  await Promise.all(tasks.map(task => task.ready));
  for (const task of tasks) task.worker.postMessage('start');
  const completed = await Promise.all(tasks.map(task => task.done));
  const outcomes = completed.flatMap(result => result.results);
  assert.equal(outcomes.filter(value => value === 201).length, 3);
  assert.equal(outcomes.filter(value => value === 429).length, 21);
  assert.ok(completed.every(result => result.count === 3));
});

test('rolling window releases exactly one slot at its 60-minute boundary', async t => {
  const f = await backendFixture(t);
  const { session } = await f.login();
  const start = f.now();
  for (let index = 0; index < 3; index += 1) {
    await f.setTime(start + index * 1000);
    await f.store.createProposal(session.user.id, { body: `proposal ${index}`, requestId: `boundary-${index}` });
  }
  await f.setTime(start + WINDOW_MS - 1);
  await assert.rejects(f.store.createProposal(session.user.id, { body: 'too soon', requestId: 'boundary-four' }), errorCode('QUOTA_EXCEEDED'));
  assert.equal((await f.store.listProposals(session.user.id)).quota.nextAvailableAt, new Date(start + WINDOW_MS).toISOString());
  await f.setTime(start + WINDOW_MS);
  assert.equal((await f.store.listProposals(session.user.id)).quota.remaining, 1);
  const accepted = await f.store.createProposal(session.user.id, { body: 'now allowed', requestId: 'boundary-four' });
  assert.equal(accepted.quota.remaining, 0);
  assert.equal(accepted.quota.nextAvailableAt, new Date(start + WINDOW_MS + 1000).toISOString());
});

test('UTF-8 byte limit covers Korean, emoji, whitespace and malformed Unicode', async t => {
  assert.equal(validateBody('a'.repeat(2000)).length, 2000);
  assert.equal(Buffer.byteLength(validateBody('한'.repeat(666) + 'ab')), 2000);
  assert.equal(Buffer.byteLength(validateBody('😀'.repeat(500))), 2000);
  for (const text of ['a'.repeat(2001), '한'.repeat(667), '😀'.repeat(501)]) {
    assert.throws(() => validateBody(text), errorCode('BODY_TOO_LARGE'));
  }
  for (const text of ['', ' \n\t　', '\ud800']) assert.throws(() => validateBody(text), errorCode('INVALID_BODY'));
  const f = await backendFixture(t);
  const { session } = await f.login();
  await assert.rejects(f.store.createProposal(session.user.id, { requestId: 'invalid-bytes', body: '😀'.repeat(501) }), errorCode('BODY_TOO_LARGE'));
  assert.equal((await f.store.listProposals(session.user.id)).quota.remaining, 3);
  const original = '  <script>alert(1)</script>\n한글😀  ';
  const result = await f.store.createProposal(session.user.id, { requestId: 'plain-text-1', body: original });
  assert.equal(result.proposal.body, original);
});

test('idempotent retries survive quota exhaustion, edits and a second session', async t => {
  const f = await backendFixture(t);
  const firstLogin = await f.login();
  const userId = firstLogin.session.user.id;
  const input = { body: 'original', requestId: 'idempotent-key' };
  const first = await f.store.createProposal(userId, input);
  await f.store.createProposal(userId, { body: 'two', requestId: 'idempotent-two' });
  await f.store.createProposal(userId, { body: 'three', requestId: 'idempotent-three' });
  const anotherLogin = await f.login();
  assert.equal(anotherLogin.session.user.id, userId);
  const otherStore = await f.anotherStore();
  const retry = await otherStore.createProposal(userId, input);
  assert.equal(retry.created, false);
  assert.equal(retry.proposal.id, first.proposal.id);
  assert.equal(retry.quota.remaining, 0);
  await assert.rejects(otherStore.createProposal(userId, { ...input, body: 'different' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await f.store.editProposal(userId, { id: first.proposal.id, body: 'edited', revision: 1 });
  const afterEdit = await otherStore.createProposal(userId, input);
  assert.equal(afterEdit.proposal.body, 'edited');
  assert.equal(afterEdit.proposal.revision, 2);
  assert.equal((await f.store.listProposals(userId)).proposals.length, 3);
});

test('parallel retries of one request create one row and consume one slot', async t => {
  const f = await backendFixture(t);
  const { session } = await f.login();
  const otherStore = await f.anotherStore();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? f.store : otherStore).createProposal(session.user.id, { body: 'same content', requestId: 'duplicate-key' })));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.proposal.id)).size, 1);
  assert.equal((await f.store.listProposals(session.user.id)).quota.remaining, 2);
});

test('edits enforce ownership and revision without consuming or resetting quota', async t => {
  const f = await backendFixture(t);
  const { session } = await f.login();
  const other = await f.login('other-google-subject');
  const start = f.now();
  const first = await f.store.createProposal(session.user.id, { body: 'initial body', requestId: 'edit-first' });
  await f.store.createProposal(session.user.id, { body: 'two', requestId: 'edit-second' });
  await f.store.createProposal(session.user.id, { body: 'three', requestId: 'edit-third' });
  await assert.rejects(f.store.editProposal(other.session.user.id, { id: first.proposal.id, body: 'hijack', revision: 1 }), errorCode('NOT_PROPOSAL_OWNER'));
  await f.setTime(start + WINDOW_MS - 1);
  const updated = await f.store.editProposal(session.user.id, { id: first.proposal.id, body: 'revised body', revision: 1 });
  assert.equal(updated.proposal.createdAt, first.proposal.createdAt);
  assert.equal(updated.proposal.revision, 2);
  assert.equal(updated.quota.remaining, 0);
  assert.equal(updated.quota.nextAvailableAt, new Date(start + WINDOW_MS).toISOString());
  await assert.rejects(f.store.editProposal(session.user.id, { id: first.proposal.id, body: 'stale', revision: 1 }), errorCode('REVISION_CONFLICT'));
  await assert.rejects(f.store.editProposal(session.user.id, { id: first.proposal.id, body: 'x'.repeat(2001), revision: 2 }), errorCode('BODY_TOO_LARGE'));
  await f.setTime(start + WINDOW_MS);
  assert.equal((await f.store.listProposals(session.user.id)).quota.remaining, 3);
});

test('parallel edits with the same revision cannot silently overwrite one another', async t => {
  const f = await backendFixture(t);
  const { session } = await f.login();
  const first = await f.store.createProposal(session.user.id, { body: 'original', requestId: 'edit-race-1' });
  const otherStore = await f.anotherStore();
  const outcomes = await Promise.allSettled([
    f.store.editProposal(session.user.id, { id: first.proposal.id, revision: 1, body: 'one' }),
    otherStore.editProposal(session.user.id, { id: first.proposal.id, revision: 1, body: 'two' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
});

test('cutoff freezes initial proposals but continues receiving into the pending round', async t => {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF - 1 });
  const { session } = await f.login();
  const first = await f.store.createProposal(session.user.id, { body: 'initial', requestId: 'cutoff-initial' });
  assert.equal(first.proposal.roundId, 'initial');
  await f.setTime(INITIAL_CUTOFF);
  await assert.rejects(f.store.editProposal(session.user.id, { id: first.proposal.id, body: 'too late', revision: 1 }), errorCode('ROUND_CLOSED'));
  const second = await f.store.createProposal(session.user.id, { body: 'next collection', requestId: 'cutoff-pending' });
  assert.equal(second.proposal.roundId, 'pending');
  assert.equal(second.proposal.editable, true);
  const list = await f.store.listProposals(session.user.id);
  assert.equal(list.proposals.find(proposal => proposal.id === first.proposal.id).editable, false);
  await f.setTime(FIRST_RELEASE + 1);
  const status = await request(f.handler, '/api/status');
  assert.equal(status.body.game.published, false);
  assert.deepEqual(status.body.collection, { id: 'pending', status: 'open', schedule: 'daily-kst-v1', cycleId: 'daily-2026-09-01',
    opensAt: '2026-08-31T14:00:00.000Z', closesAt: '2026-09-01T14:00:00.000Z',
    releaseAt: '2026-09-01T15:00:00.000Z', initialClosed: true });
});

test('a write delayed past cutoff uses database execution time, not request start time', async t => {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF - 1 });
  const { session } = await f.login();
  const initial = await f.store.createProposal(session.user.id, { body: 'must freeze', requestId: 'delayed-original' });
  let release;
  let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const delayedClient = {
    async batch(statements, mode) {
      reached();
      await gate;
      return f.client.batch(statements, mode);
    },
  };
  const delayedStore = createStore(delayedClient, { now: () => INITIAL_CUTOFF - 1, databaseClockSql: TEST_CLOCK_SQL });
  const editOutcome = delayedStore.editProposal(session.user.id, { id: initial.proposal.id, body: 'late edit', revision: 1 });
  const newOutcome = delayedStore.createProposal(session.user.id, { body: 'arrived after close', requestId: 'delayed-new' });
  const rejected = assert.rejects(editOutcome, errorCode('ROUND_CLOSED'));
  await entered;
  await f.setTime(INITIAL_CUTOFF);
  release();
  await rejected;
  assert.equal((await newOutcome).proposal.roundId, 'pending');
  const list = await f.store.listProposals(session.user.id);
  assert.equal(list.proposals.find(row => row.id === initial.proposal.id).body, 'must freeze');
});

test('database migration preserves data and constraints protect identity and UTF-8 size', async t => {
  const f = await backendFixture(t);
  const { session } = await f.login();
  const created = await f.store.createProposal(session.user.id, { body: 'keep me', requestId: 'migration-keep' });
  await initializeDatabase(f.client);
  assert.equal((await f.store.listProposals(session.user.id)).proposals[0].body, 'keep me');
  await assert.rejects(f.client.execute({ sql: 'UPDATE proposals SET created_at = 0 WHERE id = ?', args: [created.proposal.id] }));
  await assert.rejects(f.client.execute({ sql: 'UPDATE proposals SET body = ? WHERE id = ?', args: ['😀'.repeat(501), created.proposal.id] }));
  await assert.rejects(f.client.execute({
    sql: `INSERT INTO sessions(token_hash, user_id, csrf_token, google_nonce, nonce_expires_at, created_at, expires_at)
      VALUES ('bad', 'missing-user', 'csrf', 'nonce', 1, 1, 2)`,
    args: [],
  }), error => /SQLITE_CONSTRAINT/.test(error.code));
});

test('login uses opaque rotated HttpOnly host-only cookies; logout revokes them', async t => {
  const f = await backendFixture(t, { secure: true });
  const initial = await request(f.handler, '/api/session', { origin: 'https://yourga.me' });
  assert.equal(initial.body.user, null);
  assert.match(initial.headers['set-cookie'], /^__Host-yourgame_session=/);
  assert.match(initial.headers['set-cookie'], /; HttpOnly; SameSite=Lax;/);
  assert.match(initial.headers['set-cookie'], /; Secure$/);
  assert.doesNotMatch(initial.headers['set-cookie'], /Domain=/);
  const login = await request(f.handler, '/api/login', {
    method: 'POST', cookie: initial.cookie, csrf: initial.body.csrfToken,
    origin: 'https://yourga.me', body: { credential: 'valid-test-credential' },
  });
  assert.equal(login.status, 200);
  assert.notEqual(login.cookie, initial.cookie);
  assert.notEqual(login.body.csrfToken, initial.body.csrfToken);
  assert.notEqual(login.body.googleNonce, initial.body.googleNonce);
  assert.deepEqual(Object.keys(login.body.user).sort(), ['id', 'isAdmin', 'name']);
  assert.equal(login.body.user.isAdmin, false);
  const token = login.cookie.split('=')[1];
  const persisted = await f.client.execute('SELECT token_hash FROM sessions');
  assert.ok(persisted.rows.some(row => row.token_hash === hashValue(token)));
  assert.ok(persisted.rows.every(row => row.token_hash !== token));
  assert.equal((await request(f.handler, '/api/proposals', { cookie: initial.cookie, origin: 'https://yourga.me' })).status, 401);
  const logout = await request(f.handler, '/api/logout', {
    method: 'POST', cookie: login.cookie, csrf: login.body.csrfToken, body: {}, origin: 'https://yourga.me',
  });
  assert.equal(logout.body.user, null);
  assert.notEqual(logout.cookie, login.cookie);
  assert.equal((await request(f.handler, '/api/proposals', { cookie: login.cookie, origin: 'https://yourga.me' })).status, 401);
});

test('API rejects missing login, CSRF, cross-origin requests and unsupported deletion', async t => {
  const f = await backendFixture(t);
  const login = await f.login();
  const auth = signedHeaders(login);
  const body = { body: 'proposal', requestId: 'api-request' };
  const unauthenticated = await request(f.handler, '/api/proposals', { method: 'POST', body });
  assert.equal(unauthenticated.status, 401);
  const noCsrf = await request(f.handler, '/api/proposals', { method: 'POST', body, cookie: auth.cookie });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, 'CSRF_REJECTED');
  for (const origin of ['https://evil.example', null, 'null']) {
    const response = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, body, origin });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'ORIGIN_REJECTED');
  }
  const crossRead = await request(f.handler, '/api/proposals', { ...auth, origin: 'https://evil.example' });
  assert.equal(crossRead.status, 403);
  const deletion = await request(f.handler, '/api/proposals', { ...auth, method: 'DELETE', body: {} });
  assert.equal(deletion.status, 405);
  assert.equal((await f.store.listProposals(login.session.user.id)).proposals.length, 0);
});

test('anonymous sessions can submit three ideas per rolling hour without earning an account identity', async t => {
  const f = await backendFixture(t);
  const first = await request(f.handler, '/api/session');
  const anonymous = { cookie: first.cookie, csrf: first.body.csrfToken };
  for (let index = 0; index < 3; index += 1) {
    const response = await request(f.handler, '/api/proposals', { method: 'POST', ...anonymous,
      body: { body: `anonymous idea ${index}`, requestId: `anonymous-request-${index}` } });
    assert.equal(response.status, 201);
    assert.equal(response.body.anonymous, true);
    assert.equal(response.body.quota.remaining, 2 - index);
  }
  const limited = await request(f.handler, '/api/proposals', { method: 'POST', ...anonymous,
    body: { body: 'fourth anonymous idea', requestId: 'anonymous-request-four' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'QUOTA_EXCEEDED');
  const retry = await request(f.handler, '/api/proposals', { method: 'POST', ...anonymous,
    body: { body: 'anonymous idea 0', requestId: 'anonymous-request-0' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.anonymous, true);
  const conflict = await request(f.handler, '/api/proposals', { method: 'POST', ...anonymous,
    body: { body: 'changed replay', requestId: 'anonymous-request-0' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await request(f.handler, '/api/proposals', anonymous)).status, 401);

  const second = await request(f.handler, '/api/session');
  const isolated = await request(f.handler, '/api/proposals', { method: 'POST', cookie: second.cookie,
    csrf: second.body.csrfToken, body: { body: 'separate browser session', requestId: 'anonymous-session-two' } });
  assert.equal(isolated.status, 201);
  const stored = await f.client.execute({ sql: `SELECT COUNT(*) AS n FROM proposals WHERE user_id=?`, args: [ANONYMOUS_USER_ID] });
  assert.equal(Number(stored.rows[0].n), 4);
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM anonymous_proposals')).rows[0].n), 4);
  await f.setTime(INITIAL_CUTOFF);
  const community = await request(f.handler, '/api/community?includeClosed=1');
  assert.ok(community.body.recent.some(idea => idea.author.alias === 'anonymous' && idea.author.anonymous === true));
});

test('raw Node and Vercel-parsed JSON requests share validation and quota behavior', async t => {
  const f = await backendFixture(t);
  const login = await f.login();
  const auth = signedHeaders(login);
  for (const [index, preparsed] of [false, true, false].entries()) {
    const result = await request(f.handler, '/api/proposals', {
      method: 'POST', ...auth, preparsed, body: { body: 'hello', requestId: `api-accepted-${index}` },
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.quota.remaining, 2 - index);
    assert.match(result.headers['cache-control'], /no-store/);
  }
  const full = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, body: { body: 'four', requestId: 'api-over-limit' } });
  assert.equal(full.status, 429);
  assert.equal(full.headers['retry-after'], '3600');
  assert.equal(full.body.quota.remaining, 0);
  const retry = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, body: { body: 'hello', requestId: 'api-accepted-0' } });
  assert.equal(retry.status, 200);
  const list = await request(f.handler, '/api/proposals?ownerId=untrusted-input', auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.ownerId, login.session.user.id);
  assert.equal(list.body.proposals.length, 3);
});

test('malformed/oversized JSON and invalid credentials never create a proposal or login', async t => {
  const f = await backendFixture(t);
  const login = await f.login();
  const auth = signedHeaders(login);
  for (const raw of ['{bad', 'null', '[]', 'true']) {
    assert.equal((await request(f.handler, '/api/proposals', { method: 'POST', ...auth, raw })).status, 400);
  }
  const huge = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, raw: 'x'.repeat(17000) });
  assert.equal(huge.status, 413);
  const wrongType = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const invalidId = await request(f.handler, '/api/proposals', { method: 'POST', ...auth, body: { body: 'hello', requestId: '../bad' } });
  assert.equal(invalidId.status, 422);
  const initial = await request(f.handler, '/api/session');
  const badLogin = await request(f.handler, '/api/login', {
    method: 'POST', cookie: initial.cookie, csrf: initial.body.csrfToken, body: { credential: 'forged' },
  });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers['set-cookie'], undefined);
  assert.equal((await f.store.listProposals(login.session.user.id)).proposals.length, 0);
});

test('expired nonce is refreshed by session endpoint and consumed login cannot replay', async t => {
  const f = await backendFixture(t);
  const initial = await request(f.handler, '/api/session');
  await f.setTime(f.now() + GOOGLE_NONCE_MS);
  const stale = await request(f.handler, '/api/login', {
    method: 'POST', cookie: initial.cookie, csrf: initial.body.csrfToken, body: { credential: 'valid-test-credential' },
  });
  assert.equal(stale.body.error.code, 'GOOGLE_NONCE_EXPIRED');
  const fresh = await request(f.handler, '/api/session', { cookie: initial.cookie });
  assert.notEqual(fresh.body.googleNonce, initial.body.googleNonce);
  const login = await request(f.handler, '/api/login', {
    method: 'POST', cookie: initial.cookie, csrf: fresh.body.csrfToken, body: { credential: 'valid-test-credential' },
  });
  assert.equal(login.status, 200);
  const replay = await request(f.handler, '/api/login', {
    method: 'POST', cookie: initial.cookie, csrf: fresh.body.csrfToken, body: { credential: 'valid-test-credential' },
  });
  assert.equal(replay.status, 401);
});

test('anonymous bootstrap cap is atomic, ignores spoofed forwarding headers, and preserves existing sessions', async t => {
  const f = await backendFixture(t);
  const accepted = await Promise.all(Array.from({ length: SESSION_CREATION_LIMIT }, (_, index) => request(f.handler, '/api/session', {
    headers: { 'x-forwarded-for': `203.0.113.${index}`, 'x-vercel-forwarded-for': `203.0.113.${index}` },
  })));
  assert.ok(accepted.every(response => response.status === 200));
  const blocked = await request(f.handler, '/api/session');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'SESSION_RATE_LIMITED');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await request(f.handler, '/api/session', { cookie: accepted[0].cookie })).status, 200);
  const buckets = await f.client.execute('SELECT bucket_key FROM session_rate_windows');
  assert.equal(buckets.rows.length, 1);
  assert.match(buckets.rows[0].bucket_key, /^[a-f0-9]{64}$/);
  await f.setTime(f.now() + 60000);
  assert.equal((await request(f.handler, '/api/session')).status, 200);
});

test('expired session cleanup is bounded to 100 rows per bootstrap', async t => {
  const f = await backendFixture(t);
  await f.client.batch(Array.from({ length: 250 }, (_, index) => ({
    sql: `INSERT INTO sessions(token_hash, csrf_token, google_nonce, nonce_expires_at, created_at, expires_at)
      VALUES (?, 'csrf', 'nonce', 1, 0, 1)`, args: [`expired-${index}`],
  })), 'write');
  await f.store.createAnonymousSession('cleanup-test');
  const count = await f.client.execute('SELECT COUNT(*) AS remaining FROM sessions WHERE expires_at = 1');
  assert.equal(Number(count.rows[0].remaining), 150);
});

test('health reports true readiness while errors contain no upstream details', async t => {
  const f = await backendFixture(t);
  const ready = await request(f.handler, '/api/health', { origin: null });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ok');
  assert.equal(ready.body.database, 'ok');
  assert.equal(ready.body.authConfigured, true);
  assert.equal(ready.body.gamePublished, false);
  assert.equal(ready.body.version, f.config.version);
  const logs = [];
  const broken = createApiHandler({
    config: f.config,
    getStore: async () => { throw new Error('SECRET token and file:/private/path must never escape'); },
    log: entry => logs.push(entry),
  });
  const health = await request(broken, '/api/health', { origin: null });
  const session = await request(broken, '/api/session');
  assert.equal(health.status, 503);
  assert.equal(health.body.database, 'unavailable');
  assert.equal(session.status, 503);
  assert.doesNotMatch(JSON.stringify([health.body, session.body, logs]), /SECRET|private\/path|token and/);
});

test('configuration fails closed for insecure origins and ephemeral production databases', () => {
  for (const APP_ORIGIN of ['http://example.com', 'https://user:pass@example.com', 'https://yourga.me/path', 'https://yourga.me/?token=bad']) {
    assert.throws(() => readConfig({ APP_ORIGIN }), errorCode('CONFIGURATION_ERROR'));
  }
  assert.throws(() => readConfig({ NODE_ENV: 'production', TURSO_DATABASE_URL: 'file::memory:' }), errorCode('CONFIGURATION_ERROR'));
  assert.equal(readConfig({ NODE_ENV: 'production' }).appOrigin, 'https://yourga.me');
});
