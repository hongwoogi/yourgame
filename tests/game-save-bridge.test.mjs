import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { attachGameSavePort, parseGameSaveRequest } from '../public/game-save-bridge.js';

function fixture(store = {}) {
  const listeners = new Map();
  const sent = [];
  let closed = false;
  const port = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    start() {}, close() { closed = true; }, postMessage: (value) => sent.push(value),
  };
  let stored = null;
  let storeClosed = false;
  let time = 0;
  const adapter = {
    async load() { return stored; },
    async save(data, { expectedRevision }) {
      if (expectedRevision !== (stored?.revision ?? 0)) throw Object.assign(new Error('private detail'), { code: 'SAVE_CONFLICT' });
      stored = { schemaVersion: 1, gameVersion: 'test-v1', revision: expectedRevision + 1, data };
      return stored;
    }, close() { storeClosed = true; }, ...store,
  };
  const bridge = attachGameSavePort(port, 'test-v1', { store: adapter, now: () => time });
  return { sent, bridge, receive: (data) => listeners.get('message')?.({ data }),
    advance: (value) => { time += value; }, isClosed: () => closed && storeClosed,
    messageerror: () => listeners.get('messageerror')?.() };
}
const load = (requestId = 'request-1') => ({ protocol: 1, type: 'save:load', requestId });
const write = (expectedRevision = 0) => ({ protocol: 1, type: 'save:write', requestId: 'write-1', expectedRevision, data: { seed: 42, turn: 1 } });

test('save port binds every response to host-selected version and persists through CAS', async () => {
  const f = fixture();
  await f.receive(load());
  assert.equal(f.sent[0].record, null);
  await f.receive(write());
  assert.equal(f.sent[1].record.revision, 1);
  await f.receive(load('read-2'));
  assert.deepEqual(f.sent[2].record.data, { seed: 42, turn: 1 });
  await f.receive(write());
  assert.equal(f.sent[3].error, 'SAVE_CONFLICT');
  assert.ok(f.sent.every(row => row.gameVersion === 'test-v1'));
});

test('rejects alternate version, URLs, admin/session actions, extras and malformed data without storage access', async () => {
  const f = fixture({ load() { assert.fail('must not touch storage'); }, save() { assert.fail('must not touch storage'); } });
  for (const bad of [null, [], { ...load(), gameVersion: 'other' }, { ...load(), url: '/api/admin' },
    { ...load(), type: 'admin:approve' }, { ...load(), type: 'session:read' },
    { ...write(), expectedRevision: -1 }, { ...write(), data: [] },
    { ...load(), requestId: 1 }, { ...load(), requestId: 'x'.repeat(65) },
    { ...load(), protocol: 2 }, { ...write(), data: { payload: 'a'.repeat(262144) } }]) {
    await f.receive(bad);
  }
  assert.equal(f.sent.length, 0);
});

test('parser does not execute getters or accept prototype keys', () => {
  assert.throws(() => parseGameSaveRequest({ ...load(), get evil() { assert.fail('getter ran'); } }));
  assert.throws(() => parseGameSaveRequest(JSON.parse('{"protocol":1,"type":"save:load","requestId":"x","__proto__":{}}')));
});

test('limits concurrent work, drops floods and refills bounded request budget', async () => {
  let finish;
  const f = fixture({ load: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.receive(load());
  for (let i = 0; i < 100; i++) await f.receive(load('busy-' + i));
  assert.equal(f.sent.length, 59);
  assert.ok(f.sent.every(row => row.error === 'SAVE_BUSY'));
  finish(null); await first;
  assert.equal(f.sent.length, 60);
  f.advance(1000);
  const next = f.receive(load('again'));
  finish(null); await next;
  assert.equal(f.sent.length, 61);
});

test('unknown failure is sanitized and closing suppresses in-flight replies without deleting saves', async () => {
  const bad = fixture({ load() { throw new Error('private-secret-or-stack'); } });
  await bad.receive(load());
  assert.equal(bad.sent[0].error, 'SAVE_IO');
  assert.equal(JSON.stringify(bad.sent).includes('private'), false);
  let finish;
  const f = fixture({ load: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.receive(load());
  f.bridge.close(); f.bridge.close();
  finish(null); await pending;
  assert.equal(f.sent.length, 0);
  assert.equal(f.isClosed(), true);
  assert.equal(f.receive(write()), undefined);
});

test('message decoding failure closes the capability', () => {
  const f = fixture(); f.messageerror();
  assert.equal(f.isClosed(), true);
});

test('native MessageChannel delivers only the closed save protocol', async () => {
  const { port1, port2 } = new MessageChannel();
  const bridge = attachGameSavePort(port1, 'native-v1', {
    store: { async load() { return null; }, close() {} },
  });
  try {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('save port response timed out')), 2000);
      port2.once('message', value => { clearTimeout(timeout); resolve(value); });
    });
    port2.postMessage({ ...load('denied'), gameVersion: 'other-version' });
    port2.postMessage(load('accepted'));
    assert.deepEqual(await response, {
      protocol: 1, type: 'save:result', requestId: 'accepted', gameVersion: 'native-v1', ok: true, record: null,
    });
  } finally { bridge.close(); port2.close(); }
});
