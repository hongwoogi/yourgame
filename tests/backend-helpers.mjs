import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { INITIAL_CUTOFF, readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { activateCommunityPublicDefaults } from '../server/community-schema.mjs';
import { createStore } from '../server/store.mjs';
import { createApiHandler } from '../server/app.mjs';
import { ApiError } from '../server/errors.mjs';

export const TEST_CLOCK_SQL = '(SELECT now_ms FROM test_clock WHERE id = 1)';
export const TEST_CLIENT_ID = 'test-client.apps.googleusercontent.com';

export async function backendFixture(t, { time = INITIAL_CUTOFF - 4 * 3600000, secure = false, publicDefaults = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-backend-'));
  const config = readConfig({
    APP_ORIGIN: secure ? 'https://yourga.me' : 'http://localhost:3000',
    TURSO_DATABASE_URL: 'file::memory:',
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
  });
  let currentTime = time;
  const now = () => currentTime;
  const client = await openDatabase(config);
  await client.execute('CREATE TABLE test_clock(id INTEGER PRIMARY KEY, now_ms INTEGER NOT NULL)');
  await client.execute({ sql: 'INSERT INTO test_clock(id, now_ms) VALUES (1, ?)', args: [time] });
  if (publicDefaults) await activateCommunityPublicDefaults(client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });
  const clients = [client];
  const store = createStore(client, { now, databaseClockSql: TEST_CLOCK_SQL });
  const logs = [];
  const handler = createApiHandler({
    config, store, now, log: entry => logs.push(entry),
    verifyCredential: async credential => {
      if (credential !== 'valid-test-credential') throw new ApiError(401, 'INVALID_GOOGLE_CREDENTIAL', '다시 로그인해 주세요.');
      return { googleSub: '1234567890', name: '테스트 참여자' };
    },
  });
  t.after(async () => {
    for (const db of clients) db.close();
    // This fixture only creates flat files in its own unique temporary directory.
    for (const name of await readdir(directory)) {
      const target = resolve(directory, name);
      assert.equal(dirname(target), resolve(directory));
      // Windows may briefly keep a just-closed native SQLite handle open.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await unlink(target);
          break;
        } catch (error) {
          if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= 10) throw error;
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    }
    await rmdir(directory);
  });
  return {
    config, client, store, handler, logs, now,
    raceDatabaseUrl: `file:${join(directory, 'test.db').replaceAll('\\', '/')}`,
    async setTime(value) {
      currentTime = value;
      await client.execute({ sql: 'UPDATE test_clock SET now_ms = ? WHERE id = 1', args: [value] });
    },
    async login(googleSub = '1234567890') {
      const initial = await store.createAnonymousSession();
      return store.completeLogin(initial.session, { googleSub, name: '참여자' });
    },
    async anotherStore() {
      // Independent repository instances; the worker test separately covers
      // multiple native connections racing on a real shared database file.
      return createStore(client, { now, databaseClockSql: TEST_CLOCK_SQL });
    },
  };
}

export async function request(handler, route, {
  method = 'GET', body, raw, cookie, csrf, origin = 'http://localhost:3000',
  headers = {}, preparsed = false, remoteAddress = '127.0.0.1',
} = {}) {
  const content = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : '';
  const req = Readable.from([Buffer.from(content)]);
  req.url = route;
  req.method = method;
  req.socket = { remoteAddress };
  req.headers = { ...headers };
  if (cookie) req.headers.cookie = cookie;
  if (csrf) req.headers['x-csrf-token'] = csrf;
  if (origin !== null) req.headers.origin = origin;
  if (method !== 'GET' && !req.headers['content-type']) req.headers['content-type'] = 'application/json';
  if (preparsed) req.body = body;
  const response = { status: 200, headers: {}, text: '' };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    set statusCode(value) { response.status = value; },
    get statusCode() { return response.status; },
    end(value) { response.text = value; },
  };
  await handler(req, res);
  response.body = JSON.parse(response.text);
  response.cookie = response.headers['set-cookie']?.split(';')[0];
  return response;
}

export function signedHeaders(login, secure = false) {
  return {
    cookie: `${secure ? '__Host-yourgame_session' : 'yourgame_session'}=${login.token}`,
    csrf: login.session.csrfToken,
  };
}

export function errorCode(code) {
  return error => error instanceof ApiError && error.code === code;
}
