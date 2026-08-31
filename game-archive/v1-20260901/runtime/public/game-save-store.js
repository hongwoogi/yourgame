// Host-owned local game storage. Never read accounts, sessions, or community data.
// A new immutable game version gets a new database; old saves are left untouched.
const DATABASE_PREFIX = 'yourgame:save:';
const STORE_NAME = 'saves';
const SAVE_KEY = 'current';
export const GAME_SAVE_LIMITS = Object.freeze({ maxBytes: 262144, maxDepth: 32, maxNodes: 10000 });

export class GameSaveError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GameSaveError';
    this.code = code;
  }
}

function fail(code) { throw new GameSaveError(code); }

export function validateGameVersion(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail('SAVE_INVALID');
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Reject non-JSON values instead of silently losing them through JSON.stringify.
// Inspect descriptors so untrusted getters/toJSON functions are never invoked.
export function cloneValidatedSaveData(value) {
  if (!isPlainObject(value)) fail('SAVE_INVALID');
  const ancestors = new Set();
  let nodes = 0;
  function clone(item, depth) {
    if (++nodes > GAME_SAVE_LIMITS.maxNodes || depth > GAME_SAVE_LIMITS.maxDepth) fail('SAVE_INVALID');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) && !isPlainObject(item)) fail('SAVE_INVALID');
    if (ancestors.has(item)) fail('SAVE_INVALID');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    const array = Array.isArray(item);
    if (array && (item.length > GAME_SAVE_LIMITS.maxNodes || keys.length !== item.length + 1)) fail('SAVE_INVALID');
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || ['__proto__', 'constructor', 'prototype'].includes(key)
          || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) fail('SAVE_INVALID');
      result[key] = clone(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  const result = clone(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > GAME_SAVE_LIMITS.maxBytes) fail('SAVE_INVALID');
  return result;
}

export function validateSaveRecord(value, gameVersion) {
  validateGameVersion(gameVersion);
  try {
    if (!isPlainObject(value)) fail('SAVE_CORRUPT');
    const fields = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(fields);
    if (names.length !== 4 || !['schemaVersion', 'gameVersion', 'revision', 'data'].every((key) =>
      fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'))) fail('SAVE_CORRUPT');
    if (fields.schemaVersion.value !== 1 || fields.gameVersion.value !== gameVersion
        || !Number.isSafeInteger(fields.revision.value) || fields.revision.value < 1) fail('SAVE_CORRUPT');
    return {
      schemaVersion: 1,
      gameVersion,
      revision: fields.revision.value,
      data: cloneValidatedSaveData(fields.data.value),
    };
  } catch {
    fail('SAVE_CORRUPT');
  }
}

function storageError(error) {
  if (error instanceof GameSaveError) return error;
  if (error?.name === 'QuotaExceededError') return new GameSaveError('SAVE_QUOTA');
  if (['SecurityError', 'NotAllowedError', 'InvalidStateError', 'VersionError'].includes(error?.name)) {
    return new GameSaveError('SAVE_UNAVAILABLE');
  }
  return new GameSaveError('SAVE_IO');
}

// Saves use compare-and-swap in one read/write transaction, including across tabs.
// Pass revision 0 for a new save, then the last loaded/saved revision thereafter.
export function createGameSaveStore(gameVersion, options = {}) {
  validateGameVersion(gameVersion);
  let opening;
  let connection;
  let closed = false;

  function open() {
    if (closed) return Promise.reject(new GameSaveError('SAVE_UNAVAILABLE'));
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let failed = false;
      function rejectOpen(error) {
        failed = true;
        reject(storageError(error));
      }
      try {
        const factory = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
        if (!factory || typeof factory.open !== 'function') fail('SAVE_UNAVAILABLE');
        request = factory.open(DATABASE_PREFIX + gameVersion, 1);
      } catch (error) {
        rejectOpen(error);
        return;
      }
      request.onupgradeneeded = (event) => {
        try {
          if (failed || closed || event.oldVersion !== 0) fail('SAVE_UNAVAILABLE');
          request.result.createObjectStore(STORE_NAME);
        } catch (error) {
          rejectOpen(error);
          try { request.transaction.abort(); } catch { /* Already aborted by the browser. */ }
        }
      };
      request.onerror = () => rejectOpen(request.error);
      request.onblocked = () => rejectOpen(new GameSaveError('SAVE_UNAVAILABLE'));
      request.onsuccess = () => {
        const db = request.result;
        if (failed || closed) {
          db.close();
          rejectOpen(new GameSaveError('SAVE_UNAVAILABLE'));
          return;
        }
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          rejectOpen(new GameSaveError('SAVE_CORRUPT'));
          return;
        }
        connection = db;
        db.onversionchange = () => { closed = true; db.close(); };
        resolve(db);
      };
    });
    return opening;
  }

  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let failure;
      function abort(error) {
        failure = storageError(error);
        try { transaction.abort(); } catch { reject(failure); }
      }
      try {
        if (closed) fail('SAVE_UNAVAILABLE');
        transaction = db.transaction(STORE_NAME, mode);
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure || storageError(transaction.error));
        transaction.onerror = () => { failure ||= storageError(transaction.error); };
        const objectStore = transaction.objectStore(STORE_NAME);
        const read = objectStore.get(SAVE_KEY);
        read.onerror = () => { failure = storageError(read.error); };
        read.onsuccess = () => {
          try {
            const previous = read.result === undefined ? null : validateSaveRecord(read.result, gameVersion);
            result = action(previous, objectStore, (error) => { failure = storageError(error); });
          } catch (error) { abort(error); }
        };
      } catch (error) {
        if (transaction) abort(error);
        else reject(storageError(error));
      }
    });
  }

  return Object.freeze({
    gameVersion,
    load() { return transact('readonly', (previous) => previous); },
    async save(data, { expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('SAVE_INVALID');
      const copy = cloneValidatedSaveData(data);
      return transact('readwrite', (previous, objectStore, captureError) => {
        const revision = previous?.revision ?? 0;
        if (expectedRevision !== revision || revision === Number.MAX_SAFE_INTEGER) fail('SAVE_CONFLICT');
        const record = { schemaVersion: 1, gameVersion, revision: revision + 1, data: copy };
        const write = objectStore.put(record, SAVE_KEY);
        write.onerror = () => captureError(write.error);
        return record;
      });
    },
    close() {
      closed = true;
      connection?.close();
    },
  });
}
