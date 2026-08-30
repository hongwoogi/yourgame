import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createClient } from '@libsql/client';
import { createApiHandler } from '../server/app.mjs';
import { createStore, hashValue } from '../server/store.mjs';
import { createAdminStore, INITIAL_RUN_ID } from '../server/admin-store.mjs';
import { ADMIN_AUTH_MAX_AGE_MS, ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { initializeAdminDatabase } from '../server/admin-schema.mjs';
import { SCHEMA, checkSchema, initializeDatabase } from '../server/database.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { backendFixture, errorCode, request, signedHeaders, TEST_CLOCK_SQL } from './backend-helpers.mjs';

async function loginIdentity(f, identity) {
  const anonymous = await f.store.createAnonymousSession();
  return f.store.completeLogin(anonymous.session, { googleSub: randomUUID().replaceAll('-', ''), name: '관리 테스트', ...identity });
}

async function adminFixture(t, options) {
  const f = await backendFixture(t, options);
  const admin = await loginIdentity(f, { googleSub: 'verified-admin-subject', email: ADMIN_EMAIL, emailVerified: true });
  return { ...f, admin, management: f.store.admin };
}

function operation(action, values = {}) {
  return { action, requestId: randomUUID(), reason: '테스트에서 검증하는 관리 사유', ...values };
}

async function changeService(f, changes = {}) {
  const service = await f.management.getService();
  return f.management.mutate(f.admin.session, operation('set_service', {
    mode: service.mode, proposalsEnabled: service.proposalsEnabled, developmentEnabled: service.developmentEnabled,
    message: service.message, revision: service.revision, ...changes,
  }));
}

async function approveProposal(f, proposalId) {
  const row = (await f.management.query(f.admin.session, { section: 'proposals' })).items.find(item => item.id === proposalId);
  await f.management.mutate(f.admin.session, operation('review_proposal_safety', {
    proposalId, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
    policyVersion: row.safety.policyVersion, revision: row.safety.revision, status: 'approved',
    checklistConfirmed: true, developmentBrief: '검토한 게임 요구사항을 입력으로 사용합니다.',
  }));
  const input = (await f.management.listEligibleProposals({ roundId: row.roundId, proposalIds: [proposalId] }))[0];
  return { id: input.id, revision: input.revision, bodyHash: input.bodyHash, policyVersion: input.policyVersion,
    safetyReviewId: input.safetyReviewId, safetyRevision: input.safetyRevision, developmentBriefHash: input.developmentBriefHash };
}

async function pageRequest(handler, login) {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/api/admin-page';
  req.headers = login ? { cookie: signedHeaders(login).cookie } : {};
  const response = { status: 200, headers: {}, text: '' };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    set statusCode(value) { response.status = value; },
    end(value) { response.text = value; },
  };
  await handler(req, res);
  return response;
}

test('only verified exact email can pin the initial administrator subject; aliases and role flags cannot', async t => {
  const f = await backendFixture(t);
  for (const identity of [
    { email: ADMIN_EMAIL, emailVerified: false, isAdmin: true },
    { email: ADMIN_EMAIL, emailVerified: 'true' },
    { email: 'hs.o1025@gmail.com', emailVerified: true },
    { email: 'hso1025+admin@gmail.com', emailVerified: true },
    { email: ' hso1025@gmail.com', emailVerified: true },
    { email: 'hso1025@gmail.com.evil.invalid', emailVerified: true },
    { name: ADMIN_EMAIL, isAdmin: true },
  ]) {
    const login = await loginIdentity(f, identity);
    assert.equal(login.session.user.isAdmin, false);
    await assert.rejects(f.store.admin.requireAdmin({ ...login.session, user: { ...login.session.user, isAdmin: true } }), errorCode('ADMIN_REQUIRED'));
  }
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM admin_identity')).rows[0].n, 0);
  const first = await loginIdentity(f, { email: 'HSO1025@GMAIL.COM', emailVerified: true, googleSub: 'first-admin-sub' });
  assert.equal(first.session.user.isAdmin, true);
  const second = await loginIdentity(f, { email: ADMIN_EMAIL, emailVerified: true, googleSub: 'different-google-sub' });
  assert.equal(second.session.user.isAdmin, false);
  assert.equal((await f.client.execute('SELECT google_sub FROM admin_identity')).rows[0].google_sub, 'first-admin-sub');
  const noEmail = await loginIdentity(f, { googleSub: 'first-admin-sub' });
  assert.equal(noEmail.session.user.isAdmin, false);
  await assert.rejects(f.store.admin.requireAdmin(noEmail.session), errorCode('ADMIN_REQUIRED'));
});

test('concurrent verified administrator candidates result in one pinned subject', async t => {
  const f = await backendFixture(t);
  const anonymous = await Promise.all([f.store.createAnonymousSession(), f.store.createAnonymousSession()]);
  const logins = await Promise.all(anonymous.map((item, index) => f.store.completeLogin(item.session, {
    googleSub: `candidate-admin-${index}`, name: '관리자 후보', email: ADMIN_EMAIL, emailVerified: true,
  })));
  assert.equal(logins.filter(login => login.session.user.isAdmin).length, 1);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM admin_identity')).rows[0].n, 1);
});

test('login ignores client email/admin claims and administrator HTML is never served to ordinary sessions', async t => {
  const f = await adminFixture(t);
  let pageReads = 0;
  const handler = createApiHandler({
    config: f.config, store: f.store, now: f.now, log() {},
    verifyCredential: async () => ({ googleSub: 'ordinary-google-sub', name: '일반 회원', email: 'member@example.com', emailVerified: true }),
    readAdminPage: async () => { pageReads += 1; return '<!doctype html><p>private administrator shell</p>'; },
  });
  const anonymous = await request(handler, '/api/session');
  const forged = await request(handler, '/api/login', {
    method: 'POST', cookie: anonymous.cookie, csrf: anonymous.body.csrfToken,
    body: { credential: 'signed-other-account', email: ADMIN_EMAIL, email_verified: true, isAdmin: true, role: 'admin' },
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.user.isAdmin, false);
  const ordinary = { token: forged.cookie.split('=')[1], session: { csrfToken: forged.body.csrfToken } };
  const guestPage = await pageRequest(handler);
  assert.equal(guestPage.status, 302);
  assert.equal(guestPage.headers.location, '/?admin=1');
  const denied = await pageRequest(handler, ordinary);
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.text, /private administrator shell/);
  assert.equal(pageReads, 0);
  const allowed = await pageRequest(handler, f.admin);
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers['content-type'], /text\/html/);
  assert.match(allowed.headers['cache-control'], /no-store/);
  assert.match(allowed.text, /private administrator shell/);
  assert.equal(pageReads, 1);
});

test('every administrator read/write action rejects guests and ordinary users and checks CSRF/Origin', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const memberAuth = signedHeaders(member);
  for (const section of ['overview', 'users', 'proposals', 'versions', 'audit']) {
    assert.equal((await request(f.handler, `/api/admin?section=${section}`)).status, 401);
    assert.equal((await request(f.handler, `/api/admin?section=${section}`, memberAuth)).status, 403);
  }
  for (const action of ['set_user_status', 'moderate_proposal', 'create_version', 'retry_version', 'cancel_version', 'set_service', 'review_proposal_safety']) {
    const body = operation(action);
    assert.equal((await request(f.handler, '/api/admin', { method: 'POST', body })).status, 401);
    assert.equal((await request(f.handler, '/api/admin', { method: 'POST', body, ...memberAuth })).status, 403);
  }
  const body = operation('create_version', { label: '요청', summary: '개발 요청' });
  const adminAuth = signedHeaders(f.admin);
  assert.equal((await request(f.handler, '/api/admin', { method: 'POST', body, cookie: adminAuth.cookie })).body.error.code, 'CSRF_REJECTED');
  for (const origin of [null, 'https://evil.invalid', 'null']) {
    assert.equal((await request(f.handler, '/api/admin', { method: 'POST', body, ...adminAuth, origin })).body.error.code, 'ORIGIN_REJECTED');
  }
  const allowed = await request(f.handler, '/api/admin', { method: 'POST', body, ...adminAuth });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal((await f.management.query(f.admin.session, { section: 'audit' })).items.length, 1);
});

test('administrator idempotency is atomic, binds all content, and records one immutable audit', async t => {
  const f = await adminFixture(t);
  const body = operation('create_version', { label: '중복 방지', summary: '한 작업만 생성해야 합니다.' });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.management.mutate(f.admin.session, body)));
  assert.ok(results.every(result => result.ok && result.targetId === results[0].targetId));
  assert.equal((await f.management.query(f.admin.session, { section: 'versions' })).items.length, 1);
  assert.equal((await f.management.query(f.admin.session, { section: 'audit' })).items.length, 1);
  assert.deepEqual(await f.management.mutate(f.admin.session, { ...body, summary: body.summary }), results[0]);
  await assert.rejects(f.management.mutate(f.admin.session, { ...body, reason: '다른 사유' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.management.mutate(f.admin.session, { ...body, summary: '다른 내용' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.client.execute("UPDATE admin_audit SET reason = 'overwrite'"));
  await assert.rejects(f.client.execute('DELETE FROM admin_audit'));
  await assert.rejects(f.client.execute('DELETE FROM admin_identity'));
});

test('concurrent revision changes permit one result and self suspension is forbidden', async t => {
  const f = await adminFixture(t);
  const service = await f.management.getService();
  const mutations = ['첫 공지', '두 번째 공지'].map(message => operation('set_service', {
    mode: 'active', proposalsEnabled: true, developmentEnabled: true, message, revision: service.revision,
  }));
  const outcomes = await Promise.allSettled(mutations.map(body => f.management.mutate(f.admin.session, body)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  await assert.rejects(f.management.mutate(f.admin.session, operation('set_user_status', {
    userId: f.admin.session.user.id, status: 'suspended', revision: 1,
  })), errorCode('SELF_SUSPEND_FORBIDDEN'));
  assert.equal((await f.store.getSession(f.admin.token)).user.isAdmin, true);
});

test('suspension revokes every session, prevents login and writes, and preserves proposals and quota history', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const anotherSession = await f.login();
  const userId = member.session.user.id;
  const proposal = await f.store.createProposal(userId, { body: '원문을 보존합니다.', requestId: 'suspend-original' });
  await f.management.mutate(f.admin.session, operation('set_user_status', { userId, status: 'suspended', revision: 1 }));
  assert.equal(await f.store.getSession(member.token), null);
  assert.equal(await f.store.getSession(anotherSession.token), null);
  assert.equal((await f.client.execute({ sql: 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', args: [userId] })).rows[0].n, 0);
  await assert.rejects(f.login(), errorCode('USER_SUSPENDED'));
  await assert.rejects(f.store.createProposal(userId, { body: '차단', requestId: 'suspend-new' }), errorCode('USER_SUSPENDED'));
  await assert.rejects(f.store.editProposal(userId, { id: proposal.proposal.id, body: '차단 수정', revision: 1 }), errorCode('USER_SUSPENDED'));
  const preserved = await f.store.listProposals(userId);
  assert.equal(preserved.proposals[0].body, '원문을 보존합니다.');
  assert.equal(preserved.quota.remaining, 2);
  assert.equal((await f.management.listEligibleProposals({ roundId: 'initial' })).length, 0);
  await f.management.mutate(f.admin.session, operation('set_user_status', { userId, status: 'active', revision: 2 }));
  assert.equal((await f.login()).session.user.id, userId);
  assert.equal((await f.store.listProposals(userId)).quota.remaining, 2);
  assert.equal(await f.store.getSession(member.token), null);
});

test('moderation changes a separate revision and cannot edit/delete the original or refund quota', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const created = await f.store.createProposal(member.session.user.id, { body: '검토 대상 원문', requestId: 'moderation-original' });
  const proposalId = created.proposal.id;
  await f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId, moderation: 'excluded', revision: 1 }));
  const list = await f.management.query(f.admin.session, { section: 'proposals', status: 'excluded' });
  assert.equal(list.items[0].body, '검토 대상 원문');
  assert.equal(list.items[0].revision, 1);
  assert.equal(list.items[0].moderationRevision, 2);
  assert.equal(list.items[0].createdAt, created.proposal.createdAt);
  assert.equal((await f.store.listProposals(member.session.user.id)).quota.remaining, 2);
  assert.equal((await f.management.listEligibleProposals({ roundId: 'initial' })).length, 0);
  assert.equal((await f.management.readWorkerState({ proposalIds: [proposalId], roundId: 'initial' })).blockedReason, 'snapshot_ineligible');
  await assert.rejects(f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId, moderation: 'reviewed', revision: 1 })), errorCode('REVISION_CONFLICT'));
  await assert.rejects(f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId, moderation: 'pending', revision: 2, body: '덮어쓰기' })), errorCode('INVALID_ADMIN_INPUT'));
  await f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId, moderation: 'pending', revision: 2 }));
  assert.equal((await f.management.readWorkerState({ proposalIds: [proposalId], roundId: 'initial' })).snapshot.allEligible, false);
  await approveProposal(f, proposalId);
  assert.equal((await f.management.readWorkerState({ proposalIds: [proposalId], roundId: 'initial' })).snapshot.allEligible, true);
});

test('end/resume require actual recent Google login and exact confirmation; session refresh does not renew authentication', async t => {
  const f = await adminFixture(t);
  await assert.rejects(changeService(f, { mode: 'ended', confirmation: '서비스 종료 ' }), errorCode('CONFIRMATION_REQUIRED'));
  await f.setTime(f.now() + ADMIN_AUTH_MAX_AGE_MS);
  await request(f.handler, '/api/session', signedHeaders(f.admin));
  await assert.rejects(changeService(f, { mode: 'ended', confirmation: '서비스 종료' }), errorCode('ADMIN_REAUTH_REQUIRED'));
  const current = await f.store.getSession(f.admin.token);
  const refreshedNonce = await f.store.refreshSessionNonce(current);
  const old = f.admin;
  f.admin = await f.store.completeLogin(refreshedNonce, {
    googleSub: 'verified-admin-subject', name: '재인증 관리자', email: ADMIN_EMAIL, emailVerified: true,
  });
  assert.equal(await f.store.getSession(old.token), null);
  const end = await changeService(f, { mode: 'ended', proposalsEnabled: true, developmentEnabled: true, confirmation: '서비스 종료' });
  assert.equal(end.ok, true);
  const ended = await f.management.getService();
  assert.equal(ended.mode, 'ended');
  assert.equal(ended.proposalsEnabled, false);
  assert.equal(ended.developmentEnabled, false);
  await assert.rejects(changeService(f, { mode: 'active', confirmation: '서비스 종료' }), errorCode('CONFIRMATION_REQUIRED'));
  await changeService(f, { mode: 'active', proposalsEnabled: true, developmentEnabled: false, confirmation: '서비스 재개' });
  const resumed = await f.management.getService();
  assert.equal(resumed.proposalsEnabled, true);
  assert.equal(resumed.developmentEnabled, false);
});

test('intentional maintenance/ending pause public writes while login, administrator recovery and health stay available', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const proposal = await f.store.createProposal(member.session.user.id, { body: '서비스 상태', requestId: 'service-existing' });
  for (const [mode, code] of [['maintenance', 'SERVICE_MAINTENANCE'], ['ended', 'SERVICE_ENDED']]) {
    await changeService(f, { mode, message: '운영 안내', ...(mode === 'ended' ? { confirmation: '서비스 종료' } : {}) });
    const status = await request(f.handler, '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.collection.status, mode === 'ended' ? 'ended' : 'paused');
    assert.equal(status.body.service.mode, mode);
    assert.equal(status.body.game.published, false);
    assert.equal((await request(f.handler, '/api/health')).status, 200);
    const write = await request(f.handler, '/api/proposals', { method: 'POST', ...signedHeaders(member), body: { body: '중단 중 신규', requestId: `stopped-${mode}` } });
    assert.equal(write.status, 409);
    assert.equal(write.body.error.code, code);
    await assert.rejects(f.store.editProposal(member.session.user.id, { id: proposal.proposal.id, body: '중단 중 수정', revision: 1 }), errorCode(code));
    assert.equal((await f.store.listProposals(member.session.user.id)).proposals[0].editable, true);
    assert.equal((await request(f.handler, '/api/admin?section=overview', signedHeaders(f.admin))).status, 200);
    assert.ok((await f.login()).session.user);
  }
  assert.equal(f.logs.length, 0);
});

test('a public create/edit queued before end cannot write after end commits', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const original = await f.store.createProposal(member.session.user.id, { body: '동시 종료 전 원문', requestId: 'end-race-original' });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const delayed = createStore({ async batch(statements, mode) { entered(); await gate; return f.client.batch(statements, mode); } },
    { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const creation = assert.rejects(delayed.createProposal(member.session.user.id, { body: '종료 뒤 도착', requestId: 'end-race-new' }), errorCode('SERVICE_ENDED'));
  const editing = assert.rejects(delayed.editProposal(member.session.user.id, { id: original.proposal.id, body: '종료 뒤 수정', revision: 1 }), errorCode('SERVICE_ENDED'));
  await reached;
  await changeService(f, { mode: 'ended', confirmation: '서비스 종료' });
  release();
  await Promise.all([creation, editing]);
  const after = await f.store.listProposals(member.session.user.id);
  assert.equal(after.proposals.length, 1);
  assert.equal(after.proposals[0].body, '동시 종료 전 원문');
  assert.equal(after.quota.remaining, 2);
});

test('a login and a proposal delayed until after suspension cannot resurrect access', async t => {
  const f = await adminFixture(t);
  const member = await f.login();
  const anon = await f.store.createAnonymousSession();
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const delayed = createStore({ async batch(statements, mode) { entered(); await gate; return f.client.batch(statements, mode); } },
    { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const login = assert.rejects(delayed.completeLogin(anon.session, { googleSub: '1234567890', name: '기존 회원' }), errorCode('USER_SUSPENDED'));
  const create = assert.rejects(delayed.createProposal(member.session.user.id, { body: '늦은 요청', requestId: 'suspend-race-create' }), errorCode('USER_SUSPENDED'));
  await reached;
  await f.management.mutate(f.admin.session, operation('set_user_status', { userId: member.session.user.id, status: 'suspended', revision: 1 }));
  release();
  await Promise.all([login, create]);
  assert.equal((await f.client.execute({ sql: 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', args: [member.session.user.id] })).rows[0].n, 0);
});

test('administrator lists have bounded cursor pagination, literal search and moderation/user/round filters', async t => {
  const f = await adminFixture(t);
  await f.client.batch(Array.from({ length: 54 }, (_, index) => ({
    sql: 'INSERT INTO users(id, google_sub, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    args: [`paging-user-${String(index).padStart(4, '0')}`, `paging-sub-${index}`, index === 0 ? '100% 특별 회원' : `회원 ${index}`, f.now(), f.now()],
  })), 'write');
  const first = await f.management.query(f.admin.session, { section: 'users', limit: 500 });
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const next = await f.management.query(f.admin.session, { section: 'users', cursor: first.nextCursor, limit: 50 });
  assert.equal(next.items.length, 5);
  assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 55);
  assert.equal((await f.management.query(f.admin.session, { section: 'users', q: '%' })).items.length, 1);
  await assert.rejects(f.management.query(f.admin.session, { section: 'users', q: 'changed', cursor: first.nextCursor }), errorCode('INVALID_ADMIN_INPUT'));
  await assert.rejects(f.management.query(f.admin.session, { section: 'users', cursor: 'invalid' }), errorCode('INVALID_ADMIN_INPUT'));
  const user = await f.login();
  await f.store.createProposal(user.session.user.id, { body: '초기 원문', requestId: 'filter-initial' });
  await f.setTime(INITIAL_CUTOFF);
  await f.store.createProposal(user.session.user.id, { body: '다음 원문', requestId: 'filter-pending' });
  const filtered = await f.management.query(f.admin.session, { section: 'proposals', userId: user.session.user.id, round: 'pending', status: 'pending' });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].body, '다음 원문');
});

test('additive migration preserves base schema v1, original data and legacy sessions without elevating them', async t => {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.execute('PRAGMA foreign_keys = ON');
  await client.batch(SCHEMA, 'write');
  const token = randomBytes(32).toString('base64url');
  const time = Date.now();
  await client.batch([
    { sql: 'INSERT INTO users VALUES (?, ?, ?, ?, ?)', args: ['legacy-user-id', 'legacy-sub', '기존 회원', time, time] },
    { sql: 'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)', args: [hashValue(token), 'legacy-user-id', 'old-csrf', 'old-nonce', time + 10000, time, time + 100000] },
    { sql: 'INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: ['legacy-proposal', 'legacy-user-id', 'legacy-request', hashValue('기존 원문'), '기존 원문', time, time, 'initial', 1] },
  ], 'write');
  await initializeAdminDatabase(client);
  await checkSchema(client);
  const store = createStore(client);
  assert.equal((await store.getSession(token)).user.isAdmin, false);
  assert.equal((await client.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'")).rows[0].value, 1);
  await initializeDatabase(client);
  assert.equal((await client.execute('SELECT body FROM proposals')).rows[0].body, '기존 원문');
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM development_runs')).rows[0].n, 0);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM admin_identity')).rows[0].n, 0);
});

test('development requests are records only; cancel/retry preserve history and worker claims are exclusive', async t => {
  const f = await adminFixture(t);
  const created = await f.management.mutate(f.admin.session, operation('create_version', { label: '첫 개발', summary: '검증할 개발 요청' }));
  const id = created.targetId;
  const claims = await Promise.allSettled(['worker-alpha', 'worker-bravo'].map(workerId => f.management.claimRun({ id, revision: 1, workerId })));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const winningIndex = claims.findIndex(result => result.status === 'fulfilled');
  const workerId = ['worker-alpha', 'worker-bravo'][winningIndex];
  assert.equal((await f.management.query(f.admin.session, { section: 'versions' })).items[0].status, 'running');
  await assert.rejects(f.management.updateRun({ id, revision: 2, workerId: 'worker-intruder', status: 'running' }), errorCode('WORKER_NOT_OWNER'));
  await f.management.mutate(f.admin.session, operation('cancel_version', { versionId: id, revision: 2 }));
  const stopped = await f.management.readWorkerState({ runId: id });
  assert.equal(stopped.blockedReason, 'cancel_requested');
  assert.equal(stopped.run.status, 'running');
  await assert.rejects(f.management.updateRun({ id, revision: 3, workerId, status: 'running' }), errorCode('WORKER_BLOCKED'));
  await f.management.updateRun({ id, revision: 3, workerId, status: 'cancelled' });
  const retry = await f.management.mutate(f.admin.session, operation('retry_version', { versionId: id, revision: 4 }));
  assert.notEqual(retry.targetId, id);
  const versions = (await f.management.query(f.admin.session, { section: 'versions' })).items;
  assert.equal(versions.find(row => row.id === id).status, 'cancelled');
  assert.equal(versions.find(row => row.id === retry.targetId).parentId, id);
  assert.equal(versions.find(row => row.id === retry.targetId).status, 'queued');
  await f.management.mutate(f.admin.session, operation('cancel_version', { versionId: retry.targetId, revision: 1 }));
  assert.equal((await f.management.listWorkerRuns()).items.length, 0);
  assert.equal((await request(f.handler, '/api/status')).body.game.published, false);
  await assert.rejects(f.management.mutate(f.admin.session, operation('create_version', { label: '가짜 완료', summary: '요청', status: 'completed' })), errorCode('INVALID_ADMIN_INPUT'));
});

test('workers can record failure or cancellation after service stop but cannot claim or complete work', async t => {
  const f = await adminFixture(t);
  const created = await f.management.mutate(f.admin.session, operation('create_version', { label: '실행 작업', summary: '상태 전이' }));
  await f.management.claimRun({ id: created.targetId, revision: 1, workerId: 'worker-stopping' });
  await changeService(f, { mode: 'ended', confirmation: '서비스 종료' });
  const state = await f.management.readWorkerState({ runId: created.targetId });
  assert.equal(state.allowed, false);
  assert.equal(state.run.cancelRequested, true);
  await assert.rejects(f.management.updateRun({ id: created.targetId, revision: state.run.revision, workerId: 'worker-stopping', status: 'running' }), errorCode('WORKER_BLOCKED'));
  const failed = await f.management.updateRun({ id: created.targetId, revision: state.run.revision, workerId: 'worker-stopping', status: 'failed' });
  assert.equal(failed.status, 'failed');
  const retry = await f.management.mutate(f.admin.session, operation('retry_version', { versionId: failed.id, revision: failed.revision }));
  await assert.rejects(f.management.claimRun({ id: retry.targetId, revision: 1, workerId: 'worker-restart' }), errorCode('WORKER_BLOCKED'));
  assert.equal((await request(f.handler, '/api/health')).status, 200);
});

test('approved initial job is enqueued once only after cutoff, without creating an account or granting authority', async t => {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF - 1 });
  await assert.rejects(f.store.admin.ensureInitialRun({ workerId: 'worker-initial' }), errorCode('ROUND_NOT_CLOSED'));
  await f.setTime(INITIAL_CUTOFF);
  const jobs = await Promise.all(Array.from({ length: 6 }, () => f.store.admin.ensureInitialRun({ workerId: 'worker-initial' })));
  assert.ok(jobs.every(job => job.id === INITIAL_RUN_ID && job.status === 'queued'));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n, 0);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM admin_identity')).rows[0].n, 0);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM admin_audit')).rows[0].n, 1);
  assert.equal((await f.store.admin.listWorkerRuns()).items[0].id, INITIAL_RUN_ID);
  assert.equal((await f.store.admin.claimRun({ id: INITIAL_RUN_ID, revision: 1, workerId: 'worker-initial' })).status, 'running');
});

test('worker progress checks service revision and snapshot eligibility atomically and never publishes a game', async t => {
  const f = await adminFixture(t, { time: INITIAL_CUTOFF - 1000 });
  const user = await f.login();
  const proposal = await f.store.createProposal(user.session.user.id, { body: '개발 입력', requestId: 'worker-source' });
  const binding = await approveProposal(f, proposal.proposal.id);
  await f.setTime(INITIAL_CUTOFF);
  const job = await f.management.ensureInitialRun({ workerId: 'worker-snapshot' });
  const run = await f.management.claimRun({ id: job.id, revision: job.revision, workerId: 'worker-snapshot' });
  const before = await f.management.readWorkerState({ runId: run.id, proposalIds: [proposal.proposal.id], bindings: [binding], roundId: 'initial' });
  assert.equal(before.allowed, true);
  await changeService(f, { message: '동시 운영 변경' });
  await assert.rejects(f.management.updateRun({ id: run.id, revision: run.revision, workerId: 'worker-snapshot', status: 'running',
    proposalIds: [proposal.proposal.id], bindings: [binding], roundId: 'initial', serviceRevision: before.service.revision }), errorCode('REVISION_CONFLICT'));
  const service = await f.management.getService();
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const delayed = createAdminStore({ async batch(statements, mode) { entered(); await gate; return f.client.batch(statements, mode); } },
    { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const progress = assert.rejects(delayed.updateRun({ id: run.id, revision: run.revision, workerId: 'worker-snapshot', status: 'running',
    proposalIds: [proposal.proposal.id], bindings: [binding], roundId: 'initial', serviceRevision: service.revision }), errorCode('REVISION_CONFLICT'));
  await reached;
  await f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId: proposal.proposal.id, moderation: 'excluded', revision: 1 }));
  release();
  await progress;
  assert.equal((await f.management.readWorkerState({ runId: run.id })).run.status, 'running');
  await f.management.mutate(f.admin.session, operation('moderate_proposal', { proposalId: proposal.proposal.id, moderation: 'reviewed', revision: 2 }));
  const updated = await f.management.updateRun({ id: run.id, revision: run.revision, workerId: 'worker-snapshot', status: 'running',
    proposalIds: [proposal.proposal.id], bindings: [binding], roundId: 'initial', serviceRevision: service.revision, commitSha: 'a'.repeat(40) });
  assert.equal(updated.status, 'running');
  assert.equal((await request(f.handler, '/api/status')).body.game.published, false);
});

test('automatic failure retry preserves history, races to one child, and never retries administrative cancellation', async t => {
  const f = await adminFixture(t, { time: INITIAL_CUTOFF });
  const original = await f.management.ensureInitialRun({ workerId: 'worker-recovery' });
  const running = await f.management.claimRun({ id: original.id, revision: original.revision, workerId: 'worker-recovery' });
  const failed = await f.management.updateRun({ id: running.id, revision: running.revision, workerId: 'worker-recovery', status: 'failed', summary: '실패 기록 보존' });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => f.management.retryFailedRun({
    id: failed.id, revision: failed.revision, workerId: 'worker-recovery',
  })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(result => result.status === 'rejected').every(result => result.reason.code === 'REVISION_CONFLICT'));
  const child = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal(child.status, 'queued');
  assert.equal(child.parentId, failed.id);
  const parent = (await f.management.readWorkerState({ runId: failed.id })).run;
  assert.equal(parent.status, 'failed');
  assert.equal(parent.summary, '실패 기록 보존');
  await assert.rejects(f.management.mutate(f.admin.session, operation('retry_version', { versionId: failed.id, revision: parent.revision })), errorCode('ADMIN_ACTION_CONFLICT'));
  const childRunning = await f.management.claimRun({ id: child.id, revision: child.revision, workerId: 'worker-recovery' });
  await f.management.mutate(f.admin.session, operation('cancel_version', { versionId: child.id, revision: childRunning.revision }));
  const childCurrent = (await f.management.readWorkerState({ runId: child.id })).run;
  const childFailed = await f.management.updateRun({ id: child.id, revision: childCurrent.revision, workerId: 'worker-recovery', status: 'failed' });
  await assert.rejects(f.management.retryFailedRun({ id: child.id, revision: childFailed.revision, workerId: 'worker-recovery' }), errorCode('WORKER_BLOCKED'));
  // Returning to the failed ancestor must not bypass its child's cancellation.
  await assert.rejects(f.management.retryFailedRun({ id: parent.id, revision: parent.revision, workerId: 'worker-recovery' }), errorCode('REVISION_CONFLICT'));
  await changeService(f, { developmentEnabled: false });
  await assert.rejects(f.management.retryFailedRun({ id: failed.id, revision: parent.revision, workerId: 'worker-recovery' }), errorCode('WORKER_BLOCKED'));
});

test('automatic recovery follows failed leaves and cannot restart an ancestor after a terminal child', async t => {
  const f = await adminFixture(t, { time: INITIAL_CUTOFF });
  const user = await f.login();
  const proposal = await f.store.createProposal(user.session.user.id, { body: '후속 개발 입력', requestId: 'lineage-source' });
  const binding = await approveProposal(f, proposal.proposal.id);
  const initial = await f.management.ensureInitialRun({ workerId: 'worker-lineage' });
  const firstRun = await f.management.claimRun({ id: initial.id, revision: initial.revision, workerId: 'worker-lineage' });
  const firstFailed = await f.management.updateRun({ id: firstRun.id, revision: firstRun.revision, workerId: 'worker-lineage', status: 'failed' });
  const second = await f.management.retryFailedRun({ id: firstFailed.id, revision: firstFailed.revision, workerId: 'worker-lineage' });
  const secondRun = await f.management.claimRun({ id: second.id, revision: second.revision, workerId: 'worker-lineage' });
  const secondFailed = await f.management.updateRun({ id: secondRun.id, revision: secondRun.revision, workerId: 'worker-lineage', status: 'failed' });
  const firstCurrent = (await f.management.readWorkerState({ runId: firstRun.id })).run;
  await assert.rejects(f.management.retryFailedRun({ id: firstCurrent.id, revision: firstCurrent.revision, workerId: 'worker-lineage' }), errorCode('REVISION_CONFLICT'));
  const third = await f.management.retryFailedRun({ id: secondFailed.id, revision: secondFailed.revision, workerId: 'worker-lineage' });
  const thirdRun = await f.management.claimRun({ id: third.id, revision: third.revision, workerId: 'worker-lineage' });
  await assert.rejects(f.management.updateRun({ id: thirdRun.id, revision: thirdRun.revision, workerId: 'worker-lineage', status: 'completed',
    bindings: [binding], roundId: 'pending', serviceRevision: (await f.management.getService()).revision }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  const cancelled = await f.management.updateRun({ id: thirdRun.id, revision: thirdRun.revision, workerId: 'worker-lineage', status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
  const secondCurrent = (await f.management.readWorkerState({ runId: second.id })).run;
  await assert.rejects(f.management.retryFailedRun({ id: secondCurrent.id, revision: secondCurrent.revision, workerId: 'worker-lineage' }), errorCode('REVISION_CONFLICT'));
  assert.equal((await f.management.query(f.admin.session, { section: 'versions' })).items.length, 3);
});
