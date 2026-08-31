import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_SAVE_LIMITS, GameSaveError, cloneValidatedSaveData, createGameSaveStore,
  validateGameVersion, validateSaveRecord,
} from '../public/game-save-store.js';

const version = 'release-2026.09.01';
const errorCode = (code) => (error) => error instanceof GameSaveError && error.code === code;
const namedError = (name) => Object.assign(new Error('private browser detail'), { name });

// Minimal asynchronous transactional IDB double: commits only on completion,
// rolls writes back on abort, and serializes transactions on the shared database.
function fakeIndexedDB({ openError, writeError, blocked = false } = {}) {
  const databases = new Map();
  const opens = [];
  let closeCount = 0;
  const factory = {
    open(name, schemaVersion) {
      opens.push({ name, schemaVersion });
      const request = {};
      setImmediate(() => {
        if (openError) {
          request.error = openError;
          request.onerror?.();
          return;
        }
        if (blocked) request.onblocked?.();
        const existing = databases.has(name);
        const state = databases.get(name) ?? { stores: new Set(), records: new Map(), queue: [], active: false };
        databases.set(name, state);
        let closed = false;
        let upgradeAborted = false;
        request.transaction = { abort() { upgradeAborted = true; } };
        request.result = {
          objectStoreNames: { contains: (key) => state.stores.has(key) },
          createObjectStore: (key) => state.stores.add(key),
          close() { closed = true; closeCount += 1; },
          transaction(storeName, mode) {
            if (closed) throw namedError('InvalidStateError');
            assert.equal(storeName, 'saves');
            const jobs = [];
            let working;
            let finished = false;
            const transaction = {
              error: null,
              abort() {
                if (finished) throw namedError('InvalidStateError');
                finished = true;
                setImmediate(() => { transaction.onabort?.(); release(); });
              },
              objectStore() {
                function schedule(operation) {
                  const operationRequest = {};
                  jobs.push(() => {
                    try {
                      operationRequest.result = operation();
                      operationRequest.onsuccess?.();
                    } catch (error) {
                      operationRequest.error = error;
                      transaction.error = error;
                      operationRequest.onerror?.();
                      transaction.onerror?.();
                      transaction.abort();
                    }
                  });
                  return operationRequest;
                }
                return {
                  get(key) { return schedule(() => structuredClone(working.get(key))); },
                  put(value, key) {
                    const copy = structuredClone(value);
                    return schedule(() => {
                      assert.equal(mode, 'readwrite');
                      if (writeError) throw writeError;
                      working.set(key, copy);
                      return key;
                    });
                  },
                };
              },
            };
            function release() {
              state.active = false;
              state.queue.shift()?.();
            }
            function next() {
              if (finished) return;
              const job = jobs.shift();
              if (job) {
                job();
                setImmediate(next);
                return;
              }
              finished = true;
              if (mode === 'readwrite') state.records = working;
              transaction.oncomplete?.();
              release();
            }
            function start() {
              state.active = true;
              working = new Map(state.records);
              setImmediate(next);
            }
            if (state.active) state.queue.push(start);
            else start();
            return transaction;
          },
        };
        if (!existing) request.onupgradeneeded?.({ oldVersion: 0 });
        if (upgradeAborted) {
          request.error = namedError('AbortError');
          request.onerror?.();
        } else request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory, databases, opens, get closeCount() { return closeCount; } };
}

test('version identifiers are strict and never silently normalized', () => {
  for (const value of ['v1', 'V1', version, 'a'.repeat(128)]) assert.equal(validateGameVersion(value), value);
  for (const value of ['', '../v1', ' v1', 'v1 ', 'a/b', 'a:b', 1, null, 'a'.repeat(129)]) {
    assert.throws(() => validateGameVersion(value), errorCode('SAVE_INVALID'));
  }
});

test('JSON data is cloned without keeping caller object references', () => {
  const value = { room: 3, ko: '저장', inventory: [null, true, { power: 1.5 }] };
  const copy = cloneValidatedSaveData(value);
  assert.deepEqual(copy, value);
  copy.inventory[2].power = 9;
  assert.equal(value.inventory[2].power, 1.5);
});

test('invalid JSON types, sparse arrays, cycles, and unsafe keys are rejected', () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [null, [], 'save', { n: NaN }, { n: Infinity }, { n: 1n }, { n: undefined },
    { n() {} }, { n: new Date() }, { n: new Map() }, { n: [, 1] }, { n: Symbol('n') }, cycle,
    JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 1 }, { prototype: 1 }]) {
    assert.throws(() => cloneValidatedSaveData(value), errorCode('SAVE_INVALID'));
  }
  assert.equal({}.polluted, undefined);
});

test('accessors, hidden properties, and toJSON are not invoked or discarded', () => {
  let calls = 0;
  const getter = { get secret() { calls += 1; return 'secret'; } };
  const toJSON = { toJSON() { calls += 1; return {}; } };
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  for (const value of [getter, toJSON, hidden, { [Symbol('hidden')]: 1 }]) {
    assert.throws(() => cloneValidatedSaveData(value), errorCode('SAVE_INVALID'));
  }
  assert.equal(calls, 0);
});

test('save limits cover UTF-8 bytes, nesting, and node count', () => {
  assert.throws(() => cloneValidatedSaveData({ text: '한'.repeat(GAME_SAVE_LIMITS.maxBytes / 2) }), errorCode('SAVE_INVALID'));
  let nested = {};
  for (let i = 0; i <= GAME_SAVE_LIMITS.maxDepth; i += 1) nested = { nested };
  assert.throws(() => cloneValidatedSaveData(nested), errorCode('SAVE_INVALID'));
  assert.throws(() => cloneValidatedSaveData({ entries: Array(GAME_SAVE_LIMITS.maxNodes).fill(0) }), errorCode('SAVE_INVALID'));
});

test('records must bind exact version, schema, positive safe revision, and validated data', () => {
  const record = { schemaVersion: 1, gameVersion: version, revision: 1, data: { hp: 4 } };
  assert.deepEqual(validateSaveRecord(record, version), record);
  for (const patch of [{ schemaVersion: 2 }, { gameVersion: 'other' }, { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { data: { hp: undefined } }, { extra: true }]) {
    assert.throws(() => validateSaveRecord({ ...record, ...patch }, version), errorCode('SAVE_CORRUPT'));
  }
  let calls = 0;
  Object.defineProperty(record, 'data', { get() { calls += 1; return {}; }, enumerable: true });
  assert.throws(() => validateSaveRecord(record, version), errorCode('SAVE_CORRUPT'));
  assert.equal(calls, 0);
});

test('new version has no save and each immutable version has its own database', async () => {
  const idb = fakeIndexedDB();
  const oldStore = createGameSaveStore('v1', { indexedDB: idb.factory });
  const newStore = createGameSaveStore('v2', { indexedDB: idb.factory });
  assert.equal(await oldStore.load(), null);
  await oldStore.save({ level: 4 }, { expectedRevision: 0 });
  assert.equal(await newStore.load(), null);
  await newStore.save({ level: 1 }, { expectedRevision: 0 });
  assert.equal((await oldStore.load()).data.level, 4);
  assert.deepEqual(idb.opens, [
    { name: 'yourgame:save:v1', schemaVersion: 1 }, { name: 'yourgame:save:v2', schemaVersion: 1 },
  ]);
  assert.equal(oldStore.delete, undefined);
  assert.equal(oldStore.reset, undefined);
});

test('save commits increasing revisions and snapshots the input before awaiting', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  const data = { level: 1 };
  const pending = store.save(data, { expectedRevision: 0 });
  data.level = 99;
  const first = await pending;
  assert.equal(first.revision, 1);
  assert.equal(first.data.level, 1);
  first.data.level = 100;
  assert.equal((await store.load()).data.level, 1);
  const second = await store.save({ level: 2 }, { expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.deepEqual(await store.load(), second);
});

test('separate tabs cannot overwrite a save from a stale revision', async () => {
  const idb = fakeIndexedDB();
  const tabA = createGameSaveStore(version, { indexedDB: idb.factory });
  const tabB = createGameSaveStore(version, { indexedDB: idb.factory });
  const results = await Promise.allSettled([
    tabA.save({ level: 1 }, { expectedRevision: 0 }),
    tabB.save({ level: 99 }, { expectedRevision: 0 }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'SAVE_CONFLICT');
  assert.equal((await tabB.load()).data.level, 1);
  await assert.rejects(tabA.save({ level: 4 }, { expectedRevision: 0 }), errorCode('SAVE_CONFLICT'));
  assert.equal((await tabA.load()).revision, 1);
});

test('invalid saves and missing expected revisions fail before opening a database', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  for (const expectedRevision of [undefined, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.save({}, { expectedRevision }), errorCode('SAVE_INVALID'));
  }
  await assert.rejects(store.save({ bad: undefined }, { expectedRevision: 0 }), errorCode('SAVE_INVALID'));
  assert.equal(idb.opens.length, 0);
});

test('corrupt stored data is reported and never repaired or overwritten', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  await store.load();
  const state = idb.databases.get('yourgame:save:' + version);
  const corrupt = { schemaVersion: 99, gameVersion: version, revision: 1, data: {} };
  state.records.set('current', corrupt);
  await assert.rejects(store.load(), errorCode('SAVE_CORRUPT'));
  await assert.rejects(store.save({}, { expectedRevision: 1 }), errorCode('SAVE_CORRUPT'));
  assert.deepEqual(state.records.get('current'), corrupt);
});

test('unavailable storage and browser failures return sanitized explicit codes', async () => {
  await assert.rejects(createGameSaveStore(version, { indexedDB: null }).load(), errorCode('SAVE_UNAVAILABLE'));
  for (const [name, code] of [['SecurityError', 'SAVE_UNAVAILABLE'], ['VersionError', 'SAVE_UNAVAILABLE'], ['UnknownError', 'SAVE_IO']]) {
    const idb = fakeIndexedDB({ openError: namedError(name) });
    await assert.rejects(createGameSaveStore(version, { indexedDB: idb.factory }).load(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('quota failure rejects the save without committing any data', async () => {
  const idb = fakeIndexedDB({ writeError: namedError('QuotaExceededError') });
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  await assert.rejects(store.save({ level: 1 }, { expectedRevision: 0 }), errorCode('SAVE_QUOTA'));
  assert.equal(await store.load(), null);
  const previous = { schemaVersion: 1, gameVersion: version, revision: 4, data: { level: 9 } };
  idb.databases.get('yourgame:save:' + version).records.set('current', previous);
  await assert.rejects(store.save({ level: 10 }, { expectedRevision: 4 }), errorCode('SAVE_QUOTA'));
  assert.deepEqual(await store.load(), previous);
});

test('exhausted safe revisions cannot wrap or overwrite the last save', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  await store.load();
  const previous = { schemaVersion: 1, gameVersion: version, revision: Number.MAX_SAFE_INTEGER, data: { level: 9 } };
  idb.databases.get('yourgame:save:' + version).records.set('current', previous);
  await assert.rejects(store.save({}, { expectedRevision: Number.MAX_SAFE_INTEGER }), errorCode('SAVE_CONFLICT'));
  assert.deepEqual(await store.load(), previous);
});

test('blocked open rejects promptly and closes a connection that later succeeds', async () => {
  const idb = fakeIndexedDB({ blocked: true });
  idb.databases.set('yourgame:save:' + version, { stores: new Set(['saves']), records: new Map(), queue: [], active: false });
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  await assert.rejects(store.load(), errorCode('SAVE_UNAVAILABLE'));
  assert.equal(idb.closeCount, 1);
});

test('closing the adapter leaves saves intact and requires a fresh adapter to reopen', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  const saved = await store.save({ level: 3 }, { expectedRevision: 0 });
  store.close();
  await assert.rejects(store.load(), errorCode('SAVE_UNAVAILABLE'));
  await assert.rejects(store.save({}, { expectedRevision: 1 }), errorCode('SAVE_UNAVAILABLE'));
  const reopened = createGameSaveStore(version, { indexedDB: idb.factory });
  assert.deepEqual(await reopened.load(), saved);
  assert.equal(idb.closeCount, 1);
});

test('an adapter closed while opening cannot leak the eventual connection', async () => {
  const idb = fakeIndexedDB();
  const store = createGameSaveStore(version, { indexedDB: idb.factory });
  const loading = store.load();
  store.close();
  await assert.rejects(loading, errorCode('SAVE_UNAVAILABLE'));
  // The initial schema creation was cancelled, so no save could be written.
  assert.equal(idb.databases.get('yourgame:save:' + version).records.size, 0);
});
