import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageMessenger } from '../extension-tracker/storage-client.mjs';

function event() {
  const listeners = new Set();
  return { listeners, addListener: callback => listeners.add(callback),
    removeListener: callback => listeners.delete(callback), emit: value => {
      for (const callback of [...listeners]) callback(value);
    } };
}
function fixture(post = () => {}) {
  let disconnects = 0, connects = 0;
  const port = { onMessage: event(), onDisconnect: event(),
    postMessage: message => post(message, port), disconnect() { disconnects++; port.onDisconnect.emit(); } };
  return { port, runtime: { connect(options) {
    assert.equal(options.name, 'bossReadonlyTracker.storage.v1'); connects++; return port;
  } }, counts: () => ({ disconnects, connects }) };
}

test('storage activity is observed and only a final committed result resolves the request', async () => {
  const h = fixture();
  let activities = 0, resolved = false;
  const request = createStorageMessenger(h.runtime)({ type: 'BULK_SNAPSHOTS' }, { onActivity: () => activities++ });
  request.then(() => { resolved = true; });
  h.port.onMessage.emit({ type: 'STORAGE_ACTIVITY' });
  await Promise.resolve();
  assert.equal(activities, 1); assert.equal(resolved, false);
  h.port.onMessage.emit({ type: 'STORAGE_RESULT', result: { ok: true, newMessageCount: 2 } });
  assert.deepEqual(await request, { ok: true, newMessageCount: 2 });
  assert.deepEqual(h.counts(), { connects: 1, disconnects: 1 });
  assert.equal(h.port.onMessage.listeners.size, 0);
  assert.equal(h.port.onDisconnect.listeners.size, 0);
});

test('listeners are ready for an immediate result and progress callback exceptions do not corrupt the commit', async () => {
  const h = fixture((_message, port) => {
    port.onMessage.emit({ type: 'STORAGE_ACTIVITY' });
    port.onMessage.emit({ type: 'STORAGE_RESULT', result: { ok: true } });
  });
  assert.deepEqual(await createStorageMessenger(h.runtime)({ type: 'BULK_PROGRESS' },
    { onActivity: () => { throw new Error('synthetic observer failure'); } }), { ok: true });
});

test('premature disconnect returns a safe error and consumes but never exposes lastError', async () => {
  const h = fixture(); let reads = 0;
  Object.defineProperty(h.runtime, 'lastError', { get() { reads++; return { message: 'private token or path' }; } });
  const request = createStorageMessenger(h.runtime)({ type: 'BULK_PROGRESS' });
  h.port.onDisconnect.emit();
  await assert.rejects(request, error => error.code === 'BULK_STORAGE_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(reads, 1);
  assert.equal(h.port.onMessage.listeners.size, 0);
});

test('cancel closes the communication once and removes both subscriptions', async () => {
  const h = fixture();
  const request = createStorageMessenger(h.runtime)({ type: 'BULK_PROGRESS' });
  const rejected = assert.rejects(request, error => error.code === 'BULK_STORAGE_UNAVAILABLE');
  request.cancel(); request.cancel();
  await rejected;
  assert.deepEqual(h.counts(), { connects: 1, disconnects: 1 });
  assert.equal(h.port.onMessage.listeners.size, 0);
});

test('only a missing connect API uses the legacy offline sendMessage fallback', async () => {
  let calls = 0;
  const send = createStorageMessenger({ sendMessage: async message => { calls++; return { ok: true, type: message.type }; } });
  assert.deepEqual(await send({ type: 'BULK_PROGRESS' }), { ok: true, type: 'BULK_PROGRESS' });
  assert.equal(calls, 1);
  const h = fixture(() => { throw new Error('synthetic post failure'); });
  h.runtime.sendMessage = async () => { calls++; };
  await assert.rejects(createStorageMessenger(h.runtime)({ type: 'BULK_PROGRESS' }),
    error => error.code === 'BULK_STORAGE_UNAVAILABLE');
  assert.equal(calls, 1, 'a request is never repeated after a port attempt');
});
