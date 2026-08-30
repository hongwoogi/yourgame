import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../public/i18n.js';

const KEY = 'yourgame.language.v1';
function environment({ stored, cookie = '', query = '', blocked = false } = {}) {
  const values = new Map(stored ? [[KEY, stored]] : []);
  const events = new Map();
  const writes = [];
  let cookieValue = cookie;
  const document = {
    documentElement: { lang: 'en', dir: 'ltr', dataset: {} },
    querySelectorAll: () => [],
    get cookie() { if (blocked) throw new Error('Cookie storage is disabled.'); return cookieValue; },
    set cookie(value) {
      if (blocked) throw new Error('Cookie storage is disabled.');
      writes.push(value);
      cookieValue = value.split(';')[0];
    },
  };
  const window = {
    document, navigator: { language: 'ko-KR', languages: ['ko-KR', 'en-US'] },
    location: { href: 'https://yourgame.example/' + query, protocol: 'https:' },
    history: {
      state: { untouched: true },
      replaceState(state, _title, value) {
        this.state = state;
        window.location.href = new URL(value, window.location.href).href;
      },
    },
    localStorage: {
      getItem(key) { if (blocked) throw new Error('Local storage is disabled.'); return values.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error('Local storage is disabled.'); values.set(key, value); },
    },
    addEventListener(name, handler) { events.set(name, handler); },
  };
  return { window, document, values, writes, storage: event => events.get('storage')?.(event) };
}
const response = (locale, source = locale === 'ko' ? 'country' : 'default') =>
  ({ ok: true, json: async () => ({ locale, source, supportedLocales: ['en', 'ko'] }) });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('English is the fallback despite a Korean browser, and lookup never sends a fallback preference', async () => {
  const env = environment();
  const requests = [];
  const locale = createI18n({ ...env, fetch: async (...args) => { requests.push(args); throw new Error('Offline'); } });
  assert.equal(locale.locale, 'en');
  assert.equal(await locale.init(), 'en');
  assert.equal(locale.source, 'default');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api/locale');
  assert.equal(requests[0][1].method, 'GET');
  assert.equal(requests[0][1].headers['X-Yourgame-Language'], undefined);
  assert.equal(env.values.size, 0);
});

test('Korean country detection is not persisted as a manual preference for the next visit', async () => {
  const env = environment();
  const first = createI18n({ ...env, fetch: async () => response('ko') });
  assert.equal(await first.init(), 'ko');
  assert.equal(first.source, 'country');
  assert.equal(env.values.size, 0);
  assert.deepEqual(env.writes, []);
  const next = createI18n({ ...env, fetch: async () => response('en') });
  assert.equal(await next.init(), 'en');
});

test('an explicit English share link overrides stored Korean and persists across public/admin navigation', async () => {
  const env = environment({ stored: 'ko', cookie: 'yourgame_language=ko', query: '?admin=1&lang=en#main' });
  let requests = 0;
  const locale = createI18n({ ...env, fetch: async () => { requests++; return response('ko'); } });
  assert.equal(locale.locale, 'en');
  assert.equal(await locale.init(), 'en');
  assert.equal(requests, 0);
  assert.equal(env.values.get(KEY), 'en');
  assert.match(env.document.cookie, /yourgame_language=en/);
  assert.match(env.writes[0], /SameSite=Lax; Secure/);
  locale.setLocale('ko');
  assert.equal(new URL(env.window.location.href).searchParams.get('lang'), 'ko');
  assert.equal(new URL(env.window.location.href).searchParams.get('admin'), '1');
  assert.equal(new URL(env.window.location.href).hash, '#main');
  assert.deepEqual(env.window.history.state, { untouched: true });
});

test('stored manual selection wins over country without creating another lookup', async () => {
  for (const options of [{ stored: 'en' }, { cookie: 'yourgame_language=en' }]) {
    const env = environment(options);
    const locale = createI18n({ ...env, fetch: async () => { assert.fail('A saved choice must not call geo.'); } });
    assert.equal(await locale.init(), 'en');
    assert.equal(locale.source, 'preference');
  }
});

test('choosing the already-visible English value wins against an older Korean response', async () => {
  const env = environment();
  const lookup = deferred();
  const locale = createI18n({ ...env, fetch: () => lookup.promise });
  const changes = [];
  locale.subscribe(value => changes.push(value));
  const initialization = locale.init();
  assert.equal(locale.setLocale('en'), true);
  lookup.resolve(response('ko'));
  assert.equal(await initialization, 'en');
  assert.equal(locale.source, 'preference');
  assert.deepEqual(changes, ['en']);
});

test('manual selection remains usable when both persistence mechanisms are blocked', async () => {
  const env = environment({ blocked: true });
  const lookup = deferred();
  const locale = createI18n({ ...env, fetch: () => lookup.promise });
  const initialization = locale.init();
  assert.equal(locale.setLocale('ko'), true);
  lookup.resolve(response('en'));
  assert.equal(await initialization, 'ko');
  assert.equal(locale.intlLocale, 'ko-KR');
  assert.equal(env.document.documentElement.lang, 'ko');
});

test('country lookup has a deadline and a late response cannot change a resolved fallback', async () => {
  const env = environment();
  const lookup = deferred();
  let signal;
  const locale = createI18n({ ...env, timeoutMs: 15, fetch: (_url, options) => { signal = options.signal; return lookup.promise; } });
  assert.equal(await locale.init(), 'en');
  assert.equal(signal.aborted, true);
  lookup.resolve(response('ko'));
  await lookup.promise;
  await Promise.resolve();
  assert.equal(locale.locale, 'en');
  assert.equal(locale.source, 'default');
});

test('invalid or duplicated preferences and malformed geo responses cannot inject a locale', async () => {
  for (const options of [
    { query: '?lang=ko&lang=en' }, { query: '?lang=%3Cscript%3E', stored: 'ja' },
    { cookie: 'yourgame_language=ko; yourgame_language=en' },
  ]) {
    const env = environment(options);
    let requests = 0;
    const locale = createI18n({ ...env, fetch: async () => { requests++; return response('ko', 'default'); } });
    assert.equal(await locale.init(), 'en');
    assert.equal(requests, 1);
    assert.equal(locale.setLocale('../../ko'), false);
    assert.equal(locale.locale, 'en');
  }
});

test('another tab’s explicit choice wins against an in-flight lookup without a storage write loop', async () => {
  const env = environment();
  const lookup = deferred();
  const locale = createI18n({ ...env, fetch: () => lookup.promise });
  const initialization = locale.init();
  env.storage({ key: 'yourgame.auth-pulse.v1', newValue: 'unrelated' });
  assert.equal(locale.locale, 'en');
  env.values.set(KEY, 'en');
  env.storage({ key: KEY, newValue: 'en' });
  lookup.resolve(response('ko'));
  assert.equal(await initialization, 'en');
  assert.equal(locale.source, 'preference');
  assert.equal(env.writes.length, 1);
});

test('a saved choice written before its storage event still beats an in-flight country result', async () => {
  const env = environment();
  const lookup = deferred();
  const locale = createI18n({ ...env, fetch: () => lookup.promise });
  const initialization = locale.init();
  env.values.set(KEY, 'en');
  lookup.resolve(response('ko'));
  assert.equal(await initialization, 'en');
  assert.equal(locale.source, 'preference');
});

test('a queued storage event cannot overwrite a newer manual choice or resurrect a removed preference', async () => {
  const env = environment({ stored: 'ko', query: '?lang=ko' });
  const locale = createI18n(env);
  await locale.init();
  locale.setLocale('en');
  const writes = env.writes.length;
  env.storage({ key: KEY, newValue: 'ko' });
  assert.equal(locale.locale, 'en');
  assert.equal(env.values.get(KEY), 'en');
  assert.equal(env.document.cookie, 'yourgame_language=en');
  assert.equal(new URL(env.window.location.href).searchParams.get('lang'), 'en');
  assert.equal(env.writes.length, writes);
  env.values.delete(KEY);
  env.storage({ key: KEY, newValue: 'ko' });
  assert.equal(locale.locale, 'en');
  assert.equal(env.values.has(KEY), false);
  assert.equal(env.writes.length, writes);
});

test('catalogs enforce bilingual keys and parameters, while interpolation never evaluates markup', () => {
  const locale = createI18n(environment());
  assert.throws(() => locale.register('ui', { en: { hello: 'Hello' }, ko: {} }), /keys must match/);
  assert.throws(() => locale.register('ui', { en: { hello: 'Hello {name}' }, ko: { hello: '안녕하세요 {user}' } }), /parameters must match/);
  locale.register('ui', { en: { hello: 'Hello {name}' }, ko: { hello: '{name}님 안녕하세요' } });
  assert.equal(locale.t('ui.hello', { name: '<img src=x onerror=alert(1)>' }), 'Hello <img src=x onerror=alert(1)>');
  assert.equal(locale.t('ui.toString'), '[ui.toString]');
  locale.setLocale('ko', { persist: false });
  assert.equal(locale.t('ui.hello', { name: 'Player' }), 'Player님 안녕하세요');
});
