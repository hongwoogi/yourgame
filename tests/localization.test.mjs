import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createApiHandler } from '../server/app.mjs';
import { ADMIN_AUTH_MAX_AGE_MS, ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { readConfig } from '../server/config.mjs';
import { ApiError } from '../server/errors.mjs';
import { LOCALE_VARY } from '../server/localization.mjs';
import { ERROR_MESSAGES, apiErrorMessage } from '../public/error-messages.js';
import { backendFixture, request, signedHeaders } from './backend-helpers.mjs';

const ORIGIN = 'https://yourga.me';
const production = { VERCEL: '1', VERCEL_ENV: 'production' };
const preference = locale => ({ 'x-yourgame-language': locale });
const selection = (locale, source) => ({ locale, source, supportedLocales: ['en', 'ko'] });

function independentHandler(env = {}) {
  const calls = { store: 0, google: 0, log: 0 };
  const config = readConfig({ APP_ORIGIN: ORIGIN, ...env });
  const handler = createApiHandler({
    config,
    getStore: async () => { calls.store += 1; throw new Error('Database must not be called by locale'); },
    verifyCredential: async () => { calls.google += 1; throw new Error('Google must not be called by locale'); },
    log: () => { calls.log += 1; },
  });
  return { config, handler, calls,
    locale: options => request(handler, '/api/locale', { origin: ORIGIN, ...options }),
  };
}

test('locale is database/session/auth independent and defaults to English without relying on browser language', async () => {
  const f = independentHandler();
  for (const headers of [{}, { 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' }, { 'x-vercel-ip-country': 'KR', 'accept-language': 'ko' }]) {
    const response = await f.locale({ headers });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, selection('en', 'default'));
    assert.equal(response.headers['content-language'], 'en');
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.headers.vary, LOCALE_VARY);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.deepEqual(f.calls, { store: 0, google: 0, log: 0 });
  const outage = await request(f.handler, '/api/status', { origin: ORIGIN });
  assert.equal(outage.status, 503);
  assert.equal(outage.body.error.message, ERROR_MESSAGES.en.SERVICE_UNAVAILABLE);
  assert.equal((await f.locale()).status, 200);
  assert.equal(f.calls.store, 1);
  assert.equal(f.calls.google, 0);
});

test('only exact KR from a production or preview Vercel deployment selects automatic Korean', async () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    const f = independentHandler({ VERCEL: '1', VERCEL_ENV });
    assert.equal(f.config.trustVercelGeoHeader, true);
    assert.deepEqual((await f.locale({ headers: { 'x-vercel-ip-country': 'KR' } })).body, selection('ko', 'country'));
    for (const country of ['US', 'CA', 'ZZ', 'kr', ' KR', 'KR ', 'KR,US', '', 'South Korea']) {
      assert.deepEqual((await f.locale({ headers: { 'x-vercel-ip-country': country, 'accept-language': 'ko-KR' } })).body,
        selection('en', 'default'), `${VERCEL_ENV}/${country}`);
    }
    assert.deepEqual(f.calls, { store: 0, google: 0, log: 0 });
  }
  for (const env of [{}, { NODE_ENV: 'production' }, { VERCEL: '1' }, { VERCEL: '1', VERCEL_ENV: 'development' },
    { VERCEL: '1', VERCEL_ENV: 'custom' }, { VERCEL: '0', VERCEL_ENV: 'production' }]) {
    const f = independentHandler(env);
    assert.equal(f.config.trustVercelGeoHeader, false);
    assert.deepEqual((await f.locale({ headers: { 'x-vercel-ip-country': 'KR' } })).body, selection('en', 'default'));
    // Geolocation tightening must not silently change the existing IP limiter.
    assert.equal(f.config.trustVercelIpHeader, env.VERCEL === '1');
  }
});

test('explicit language header overrides cookie, cookie overrides country, and Korean can be chosen outside Korea', async () => {
  const f = independentHandler(production);
  for (const [headers, cookie, expected] of [
    [{ 'x-vercel-ip-country': 'KR', ...preference('en') }, 'yourgame_language=ko', 'en'],
    [{ 'x-vercel-ip-country': 'US', ...preference('ko') }, 'yourgame_language=en', 'ko'],
    [{ 'x-vercel-ip-country': 'KR' }, 'yourgame_language=en', 'en'],
    [{ 'x-vercel-ip-country': 'US' }, 'unrelated=x; yourgame_language=ko; other=y', 'ko'],
    [{ ...preference('ko') }, 'yourgame_language=en; yourgame_language=ko', 'ko'],
    [{ ...preference('invalid') }, 'yourgame_language=ko', 'ko'],
  ]) {
    const response = await f.locale({ headers, cookie });
    assert.deepEqual(response.body, selection(expected, 'preference'));
    assert.equal(response.headers['content-language'], expected);
  }
  assert.deepEqual((await independentHandler().locale({ headers: preference('ko') })).body, selection('ko', 'preference'));
});

test('invalid, duplicated and joined header/cookie values never become a preference or a trusted country', async () => {
  const f = independentHandler(production);
  for (const headers of [
    preference('KO'), preference(' ko'), preference('ko '), preference('ko,en'), preference('ko;admin=true'),
    preference(['ko']), { 'X-Yourgame-Language': 'ko', 'x-yourgame-language': 'en' },
    { 'x-vercel-ip-country': ['KR'] },
  ]) assert.deepEqual((await f.locale({ headers })).body, selection('en', 'default'));
  for (const cookie of [
    'yourgame_language=KO', 'yourgame_language=%6Bo', 'yourgame_language="ko"', 'yourgame_language=ko,en',
    'yourgame_language=ko; yourgame_language=ko', 'yourgame_language=ko; yourgame_language=invalid',
    'yourgame_language=ko=extra', 'yourgame_language =ko', `other=${'x'.repeat(16384)}; yourgame_language=ko`,
  ]) assert.deepEqual((await f.locale({ cookie })).body, selection('en', 'default'));
  for (const name of ['X-Yourgame-Language', 'X-Vercel-IP-Country', 'Cookie']) {
    const value = name === 'Cookie' ? 'yourgame_language=ko' : name === 'X-Vercel-IP-Country' ? 'KR' : 'ko';
    const duplicated = (req, res) => {
      req.rawHeaders = [name, value, name.toLowerCase(), value];
      return f.handler(req, res);
    };
    const response = await request(duplicated, '/api/locale', { origin: ORIGIN, headers: { [name.toLowerCase()]: value } });
    assert.deepEqual(response.body, selection('en', 'default'));
  }
  const fallback = await f.locale({ headers: { 'x-yourgame-language': 'invalid', 'x-vercel-ip-country': 'KR' }, cookie: 'yourgame_language=ko; yourgame_language=en' });
  assert.deepEqual(fallback.body, selection('ko', 'country'));
  assert.deepEqual(f.calls, { store: 0, google: 0, log: 0 });
});

test('the locale endpoint keeps method and same-origin protections without touching session storage', async () => {
  const f = independentHandler(production);
  const method = await f.locale({ method: 'POST', headers: preference('ko'), body: {} });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'GET');
  assert.equal(method.body.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(method.body.error.message, ERROR_MESSAGES.ko.METHOD_NOT_ALLOWED);
  const crossOrigin = await f.locale({ headers: preference('en'), origin: 'https://evil.invalid' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.message, ERROR_MESSAGES.en.ORIGIN_REJECTED);
  assert.deepEqual(f.calls, { store: 0, google: 0, log: 0 });
});

test('every server ApiError code has English and Korean text and unknown fallback handling is prototype-safe', async () => {
  const directory = new URL('../server/', import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.mjs')).map(name => readFile(new URL(name, directory), 'utf8')));
  const codes = new Set(sources.flatMap(source => [...source.matchAll(/new ApiError\(\s*\d+\s*,\s*'([A-Z_]+)'/g)].map(match => match[1])));
  assert.ok(codes.size > 40);
  assert.deepEqual(Object.keys(ERROR_MESSAGES.en).sort(), Object.keys(ERROR_MESSAGES.ko).sort());
  for (const code of codes) {
    assert.ok(Object.hasOwn(ERROR_MESSAGES.en, code), `Missing English: ${code}`);
    assert.ok(Object.hasOwn(ERROR_MESSAGES.ko, code), `Missing Korean: ${code}`);
    assert.equal(apiErrorMessage(code, 'en', '서버가 보내던 한국어 안내'), ERROR_MESSAGES.en[code]);
    assert.equal(apiErrorMessage(code, 'ko', 'untranslated fallback'), ERROR_MESSAGES.ko[code]);
    assert.notEqual(ERROR_MESSAGES.en[code], ERROR_MESSAGES.ko[code]);
  }
  assert.equal(apiErrorMessage('NOT_A_CODE', 'ko', '지정한 대체 문구'), '지정한 대체 문구');
  assert.equal(apiErrorMessage('NOT_A_CODE', 'en', 'Fallback text'), 'Fallback text');
  for (const code of ['__proto__', 'constructor', 'toString', undefined, {}]) {
    assert.equal(apiErrorMessage(code), ERROR_MESSAGES.en.SERVICE_UNAVAILABLE);
  }
  assert.equal(apiErrorMessage('MISSING', 'ko', ' '), ERROR_MESSAGES.ko.SERVICE_UNAVAILABLE);
  assert.equal(apiErrorMessage('LOGIN_REQUIRED', 'invalid'), ERROR_MESSAGES.en.LOGIN_REQUIRED);
});

test('the actual handler translates all catalog codes while retaining HTTP status, code and details', async () => {
  const config = readConfig({ APP_ORIGIN: ORIGIN });
  for (const code of Object.keys(ERROR_MESSAGES.en)) {
    const details = { quota: { remaining: 0, limit: 3, nextAvailableAt: '2026-09-01T00:00:00.000Z' }, retryAfterSeconds: 3 };
    const handler = createApiHandler({ config, log() {},
      getStore: async () => { throw new ApiError(429, code, '원래의 한국어 메세지', details); },
    });
    for (const locale of ['en', 'ko']) {
      const result = await request(handler, '/api/proposals', { origin: ORIGIN, headers: preference(locale) });
      assert.equal(result.status, 429);
      assert.equal(result.body.error.code, code);
      assert.equal(result.body.error.message, ERROR_MESSAGES[locale][code]);
      assert.equal(result.headers['content-language'], locale);
      assert.equal(result.headers['retry-after'], '3');
      assert.deepEqual(result.body.quota, details.quota);
      assert.equal(result.body.retryAfterSeconds, 3);
    }
  }
});

test('unknown server error codes preserve status and code without exposing private diagnostics in either language', async () => {
  const logs = [];
  const handler = createApiHandler({ config: readConfig({ APP_ORIGIN: ORIGIN }), log: entry => logs.push(entry),
    getStore: async () => { throw new ApiError(503, 'UNLISTED_BACKEND_FAILURE', 'private diagnostic: internal-store-path / private upstream response'); },
  });
  for (const locale of ['en', 'ko']) {
    const result = await request(handler, '/api/proposals', { origin: ORIGIN, headers: preference(locale) });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'UNLISTED_BACKEND_FAILURE');
    assert.equal(result.body.error.message, ERROR_MESSAGES[locale].SERVICE_UNAVAILABLE);
    assert.equal(result.headers['content-language'], locale);
    assert.doesNotMatch(result.text, /private diagnostic|internal-store-path|private upstream response/);
  }
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private diagnostic|internal-store-path|private upstream response/);
});

test('real proposal validation, quota, idempotency and edit cooldown errors stay unchanged across languages', async t => {
  const f = await backendFixture(t);
  const member = await f.login();
  const auth = signedHeaders(member);
  for (const locale of ['en', 'ko']) {
    const headers = preference(locale);
    const guest = await request(f.handler, '/api/proposals', { headers });
    assert.equal(guest.status, 401);
    assert.equal(guest.body.error.message, ERROR_MESSAGES[locale].LOGIN_REQUIRED);
    const invalidJson = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers, raw: '{' });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.message, ERROR_MESSAGES[locale].INVALID_JSON);
    for (const [body, status, code] of [[' ', 422, 'INVALID_BODY'], ['가'.repeat(667), 413, 'BODY_TOO_LARGE']]) {
      const result = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers, body: { body, requestId: randomUUID() } });
      assert.equal(result.status, status);
      assert.equal(result.body.error.code, code);
      assert.equal(result.body.error.message, ERROR_MESSAGES[locale][code]);
    }
  }
  assert.equal((await f.store.listProposals(member.session.user.id)).quota.remaining, 3);
  const original = { body: '한글 원문 <&> English source', requestId: randomUUID() };
  const created = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers: preference('en'), body: original });
  for (let index = 0; index < 2; index += 1) await f.store.createProposal(member.session.user.id, { body: `제안 ${index}`, requestId: randomUUID() });
  for (const locale of ['en', 'ko']) {
    const headers = preference(locale);
    const quota = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers, body: { body: '추가 제안', requestId: randomUUID() } });
    assert.equal(quota.status, 429);
    assert.equal(quota.body.error.message, ERROR_MESSAGES[locale].QUOTA_EXCEEDED);
    assert.equal(quota.body.quota.remaining, 0);
    assert.equal(quota.headers['retry-after'], '3600');
    const retry = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers, body: original });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.proposal.id, created.body.proposal.id);
    assert.equal(retry.body.proposal.body, original.body);
    const conflict = await request(f.handler, '/api/proposals', { ...auth, method: 'POST', headers, body: { ...original, body: '다른 원문' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.message, ERROR_MESSAGES[locale].IDEMPOTENCY_CONFLICT);
  }
  const edited = await request(f.handler, '/api/proposals', { ...auth, method: 'PATCH', headers: preference('ko'),
    body: { id: created.body.proposal.id, revision: 1, body: '수정된 원문 English text' } });
  assert.equal(edited.status, 200);
  for (const locale of ['en', 'ko']) {
    const cooldown = await request(f.handler, '/api/proposals', { ...auth, method: 'PATCH', headers: preference(locale),
      body: { id: created.body.proposal.id, revision: 2, body: '다음 수정 원문' } });
    assert.equal(cooldown.status, 429);
    assert.equal(cooldown.body.error.code, 'EDIT_RATE_LIMITED');
    assert.equal(cooldown.body.error.message, ERROR_MESSAGES[locale].EDIT_RATE_LIMITED);
    assert.equal(cooldown.headers['retry-after'], '3');
  }
});

test('only fixed safety notices are translated; original text, names, hashes and administrator reasons remain unchanged', async t => {
  const f = await backendFixture(t);
  const member = await f.login();
  const anon = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anon.session, { googleSub: 'locale-admin-user', name: '관리자 원래 이름', email: ADMIN_EMAIL, emailVerified: true });
  const created = await request(f.handler, '/api/proposals', { ...signedHeaders(member), method: 'POST', headers: preference('en'),
    body: { body: '  한국어 원문은 그대로 <b>English</b>  ', requestId: randomUUID() } });
  assert.match(created.body.proposal.safety.message, /^Awaiting safety review/);
  const id = created.body.proposal.id;
  for (const status of ['pending', 'approved', 'held', 'blocked']) {
    if (status !== 'pending') {
      const row = (await f.store.admin.query(admin.session, { section: 'proposals' })).items[0];
      await f.store.admin.mutate(admin.session, {
        action: 'review_proposal_safety', requestId: randomUUID(), reason: '번역하지 않을 심사 사유',
        proposalId: id, proposalRevision: row.revision, bodyHash: row.safety.bodyHash, policyVersion: row.safety.policyVersion,
        revision: row.safety.revision, status, checklistConfirmed: true, developmentBrief: '번역하지 않을 개발 요구사항',
      });
    }
    const english = await request(f.handler, '/api/proposals', { ...signedHeaders(member), headers: preference('en') });
    const korean = await request(f.handler, '/api/proposals', { ...signedHeaders(member), headers: preference('ko') });
    const enProposal = english.body.proposals[0];
    const koProposal = korean.body.proposals[0];
    assert.equal(enProposal.body, created.body.proposal.body);
    assert.equal(koProposal.body, created.body.proposal.body);
    assert.equal(enProposal.safety.status, status);
    assert.equal(koProposal.safety.status, status);
    assert.notEqual(enProposal.safety.message, koProposal.safety.message);
    assert.deepEqual({ ...enProposal, safety: { status } }, { ...koProposal, safety: { status } });
    const enAdmin = await request(f.handler, '/api/admin?section=proposals', { ...signedHeaders(admin), headers: preference('en') });
    const koAdmin = await request(f.handler, '/api/admin?section=proposals', { ...signedHeaders(admin), headers: preference('ko') });
    assert.deepEqual(enAdmin.body, koAdmin.body);
    assert.equal(enAdmin.body.items[0].body, created.body.proposal.body);
    if (status !== 'pending') assert.equal(enAdmin.body.items[0].safety.reason, '번역하지 않을 심사 사유');
    if (status === 'approved') assert.equal(enAdmin.body.items[0].safety.developmentBrief, '번역하지 않을 개발 요구사항');
  }
  for (const locale of ['en', 'ko']) {
    const session = await request(f.handler, '/api/session', { ...signedHeaders(admin), headers: preference(locale) });
    assert.equal(session.body.user.name, '관리자 원래 이름');
  }
});

test('manual and country locale metadata cannot bypass authentication, ownership, CSRF or administrator authority', async t => {
  const f = await backendFixture(t);
  const member = await f.login();
  const other = await f.login('localization-other-member');
  const proposal = await f.store.createProposal(member.session.user.id, { body: '보호할 원문', requestId: randomUUID() });
  const handler = createApiHandler({ config: { ...f.config, trustVercelGeoHeader: true }, store: f.store, now: f.now, log() {} });
  for (const headers of [preference('en'), preference('ko'), { 'x-vercel-ip-country': 'KR' }]) {
    const locale = headers['x-yourgame-language'] === 'en' ? 'en' : 'ko';
    const csrf = await request(handler, '/api/proposals', { cookie: signedHeaders(member).cookie, method: 'POST', headers,
      body: { body: '위조 요청', requestId: randomUUID() } });
    assert.equal(csrf.status, 403);
    assert.equal(csrf.body.error.message, ERROR_MESSAGES[locale].CSRF_REJECTED);
    const owner = await request(handler, '/api/proposals', { ...signedHeaders(other), method: 'PATCH', headers,
      body: { id: proposal.proposal.id, revision: 1, body: '타인 원문 수정' } });
    assert.equal(owner.status, 403);
    assert.equal(owner.body.error.message, ERROR_MESSAGES[locale].NOT_PROPOSAL_OWNER);
    const admin = await request(handler, '/api/admin', { ...signedHeaders(member), headers });
    assert.equal(admin.status, 403);
    assert.equal(admin.body.error.message, ERROR_MESSAGES[locale].ADMIN_REQUIRED);
    const origin = await request(handler, '/api/proposals', { ...signedHeaders(member), method: 'POST', headers,
      origin: 'https://evil.invalid', body: { body: '외부 요청', requestId: randomUUID() } });
    assert.equal(origin.status, 403);
    assert.equal(origin.body.error.message, ERROR_MESSAGES[locale].ORIGIN_REJECTED);
  }
  assert.equal((await f.store.listProposals(member.session.user.id)).proposals[0].body, '보호할 원문');
});

test('administrator confirmations and announcements remain verbatim while administrative errors are localized', async t => {
  const f = await backendFixture(t);
  const anon = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anon.session, { googleSub: 'locale-control-admin', name: '관리자', email: ADMIN_EMAIL, emailVerified: true });
  const service = await f.store.admin.getService();
  const update = {
    action: 'set_service', requestId: randomUUID(), reason: '번역하지 않는 운영 사유', revision: service.revision,
    mode: 'ended', proposalsEnabled: false, developmentEnabled: false, message: '운영자가 작성한 한국어 공지', confirmation: 'End service',
  };
  const wrong = await request(f.handler, '/api/admin', { method: 'POST', ...signedHeaders(admin), headers: preference('en'), body: update });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.message, ERROR_MESSAGES.en.CONFIRMATION_REQUIRED);
  const accepted = await request(f.handler, '/api/admin', { method: 'POST', ...signedHeaders(admin), headers: preference('en'),
    body: { ...update, requestId: randomUUID(), confirmation: '서비스 종료' } });
  assert.equal(accepted.status, 200);
  for (const locale of ['en', 'ko']) {
    const status = await request(f.handler, '/api/status', { headers: preference(locale) });
    assert.equal(status.body.service.message, '운영자가 작성한 한국어 공지');
    const audit = await request(f.handler, '/api/admin?section=audit', { ...signedHeaders(admin), headers: preference(locale) });
    assert.equal(audit.body.items[0].reason, '번역하지 않는 운영 사유');
  }
  await f.setTime(f.now() + ADMIN_AUTH_MAX_AGE_MS);
  const ended = await f.store.admin.getService();
  const reauth = await request(f.handler, '/api/admin', { method: 'POST', ...signedHeaders(admin), headers: preference('en'),
    body: { ...update, requestId: randomUUID(), mode: 'active', proposalsEnabled: true, developmentEnabled: true,
      revision: ended.revision, confirmation: '서비스 재개' } });
  assert.equal(reauth.status, 403);
  assert.equal(reauth.body.error.message, ERROR_MESSAGES.en.ADMIN_REAUTH_REQUIRED);
});

test('administrator HTML declares English, redirects use the selected language, and health JSON shape is unaffected', async t => {
  const f = await backendFixture(t);
  const anon = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anon.session, { googleSub: 'locale-page-admin', name: '관리자', email: ADMIN_EMAIL, emailVerified: true });
  const handler = createApiHandler({ config: f.config, store: f.store, now: f.now, log() {},
    readAdminPage: async () => '<!doctype html><html lang="en"><p>Administration</p></html>',
  });
  async function page(locale, authenticated = false) {
    const req = Readable.from([]);
    req.method = 'GET'; req.url = '/api/admin-page';
    req.headers = { ...preference(locale), ...(authenticated ? { cookie: signedHeaders(admin).cookie } : {}) };
    const result = { headers: {}, status: 0, text: '' };
    await handler(req, { setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
      set statusCode(value) { result.status = value; }, end(value) { result.text = value; } });
    return result;
  }
  const enRedirect = await page('en');
  const koRedirect = await page('ko');
  assert.equal(enRedirect.status, 302);
  assert.equal(koRedirect.status, 302);
  assert.equal(enRedirect.headers.location, '/?master=1');
  assert.equal(koRedirect.headers.location, '/?master=1');
  assert.equal(enRedirect.text, 'Administrator sign-in is required.');
  assert.equal(koRedirect.text, '관리자 로그인이 필요합니다.');
  const allowed = await page('ko', true);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['content-language'], 'en');
  assert.match(allowed.text, /lang="en"/);
  const englishHealth = await request(handler, '/api/health', { headers: preference('en') });
  const koreanHealth = await request(handler, '/api/health', { headers: preference('ko') });
  assert.deepEqual(englishHealth.body, koreanHealth.body);
  assert.equal(Object.hasOwn(englishHealth.body, 'locale'), false);
});
