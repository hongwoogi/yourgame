import { cloneValidatedSaveData, createGameSaveStore, validateGameVersion } from './game-save-store.js';

// Host-owned, narrowly scoped capability. The trusted host must transfer this
// port only to its reviewed, isolated game frame. A port is NOT a release gate
// or a browser/network sandbox. This module never listens to window messages.
const ERRORS = new Set(['SAVE_INVALID', 'SAVE_CONFLICT', 'SAVE_CORRUPT', 'SAVE_UNAVAILABLE', 'SAVE_QUOTA', 'SAVE_IO']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseGameSaveRequest(value) {
  const request = cloneValidatedSaveData(value);
  if (request.protocol !== 1 || !REQUEST_ID.test(request.requestId)
      || typeof request.requestId !== 'string') throw new Error('SAVE_INVALID');
  const fields = request.type === 'save:load' ? ['protocol', 'requestId', 'type']
    : request.type === 'save:write' ? ['protocol', 'requestId', 'type', 'expectedRevision', 'data'] : [];
  if (!fields.length || Object.keys(request).length !== fields.length
      || !fields.every(key => Object.hasOwn(request, key))) throw new Error('SAVE_INVALID');
  if (request.type === 'save:write') {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('SAVE_INVALID');
    request.data = cloneValidatedSaveData(request.data);
  }
  return request;
}

export function attachGameSavePort(port, gameVersion, options = {}) {
  validateGameVersion(gameVersion);
  if (!port || typeof port.addEventListener !== 'function' || typeof port.postMessage !== 'function'
      || typeof port.removeEventListener !== 'function'
      || typeof port.start !== 'function' || typeof port.close !== 'function') throw new Error('SAVE_INVALID');
  // Dependency injection is host-only. No message can choose a DB or an adapter.
  const store = options.store ?? createGameSaveStore(gameVersion);
  const now = options.now ?? (() => performance.now());
  let tokens = 60;
  let updated = now();
  let busy = false;
  let closed = false;

  function reply(requestId, value) {
    if (closed) return;
    try { port.postMessage({ protocol: 1, type: 'save:result', requestId, gameVersion, ...value }); }
    catch { close(); }
  }

  async function receive(event) {
    if (closed) return;
    const timestamp = now();
    tokens = Math.min(60, tokens + Math.max(0, timestamp - updated) / 1000);
    updated = timestamp;
    // Bound both validation work and outgoing error messages under flooding.
    if (tokens < 1) return;
    tokens -= 1;
    let request;
    try { request = parseGameSaveRequest(event.data); }
    catch { return; }
    if (busy) { reply(request.requestId, { ok: false, error: 'SAVE_BUSY' }); return; }
    busy = true;
    try {
      const record = request.type === 'save:load' ? await store.load()
        : await store.save(request.data, { expectedRevision: request.expectedRevision });
      reply(request.requestId, { ok: true, record });
    } catch (error) {
      reply(request.requestId, { ok: false, error: ERRORS.has(error?.code) ? error.code : 'SAVE_IO' });
    } finally { busy = false; }
  }

  function close() {
    if (closed) return;
    closed = true;
    port.removeEventListener('message', receive);
    port.removeEventListener('messageerror', close);
    port.close();
    store.close();
  }

  port.addEventListener('message', receive);
  port.addEventListener('messageerror', close);
  port.start();
  return Object.freeze({ gameVersion, close });
}
