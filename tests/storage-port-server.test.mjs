import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoragePortServer } from '../extension-tracker/storage-port-server.mjs';

function event() {
  const listeners = new Set();
  return { listeners, addListener: callback => listeners.add(callback),
    removeListener: callback => listeners.delete(callback), emit: value => {
      for (const callback of [...listeners]) callback(value);
    } };
}
function port(trusted = true) {
  const sent = [];
  return { name: 'bossReadonlyTracker.storage.v1', sender: { trusted }, sent,
    onMessage: event(), onDisconnect: event(), postMessage: value => sent.push(structuredClone(value)),
    disconnect() { this.onDisconnect.emit(); } };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test('the storage port reports activity and waits for the durable result without echoing checkpoint data', async () => {
  const runtime = { onConnect: event() };
  let complete, calls = 0;
  const server = createStoragePortServer({ runtime, isTrustedSender: sender => sender.trusted,
    handleMessage: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  const p = port(); runtime.onConnect.emit(p);
  p.onMessage.emit({ type: 'BULK_PROGRESS' });
  p.onMessage.emit({ type: 'BULK_PROGRESS' });
  await flush();
  assert.equal(calls, 1, 'one port accepts one request');
  server.activity();
  assert.deepEqual(p.sent, [{ type: 'STORAGE_ACTIVITY' }, { type: 'STORAGE_ACTIVITY' }]);
  complete({ ok: true, progress: { contacts: [{ privateSyntheticContent: 'not echoed' }] } });
  await flush();
  assert.deepEqual(p.sent.at(-1), { type: 'STORAGE_RESULT', result: { ok: true } });
  assert.equal(p.onMessage.listeners.size, 0);
  const count = p.sent.length; server.activity(); assert.equal(p.sent.length, count);
});

test('snapshot commit returns its summary only after the handler completes', async () => {
  const runtime = { onConnect: event() };
  const result = { ok: true, summary: { messageCount: 3 }, newMessageCount: 1 };
  createStoragePortServer({ runtime, isTrustedSender: () => true, handleMessage: async () => result });
  const p = port(); runtime.onConnect.emit(p); p.onMessage.emit({ type: 'BULK_SNAPSHOTS' });
  await flush();
  assert.deepEqual(p.sent.at(-1), { type: 'STORAGE_RESULT', result });
});

test('disconnect removes activity subscription while an accepted commit is still allowed to finish', async () => {
  const runtime = { onConnect: event() };
  let complete, committed = false;
  const server = createStoragePortServer({ runtime, isTrustedSender: () => true,
    handleMessage: async () => { await new Promise(resolve => { complete = resolve; }); committed = true; return { ok: true }; } });
  const p = port(); runtime.onConnect.emit(p); p.onMessage.emit({ type: 'BULK_SNAPSHOTS' });
  await flush(); p.disconnect();
  const count = p.sent.length;
  server.activity(); complete(); await flush();
  assert.equal(committed, true);
  assert.equal(p.sent.length, count, 'a disconnected caller is not sent more activity or a result');
  assert.equal(p.onMessage.listeners.size, 0);
});

test('untrusted senders and non-storage commands never reach the persistence handler', async () => {
  const runtime = { onConnect: event() }; let calls = 0;
  createStoragePortServer({ runtime, isTrustedSender: sender => sender.trusted,
    handleMessage: async () => { calls++; return { ok: true }; } });
  const untrusted = port(false); runtime.onConnect.emit(untrusted);
  assert.equal(untrusted.sent.at(-1).result.error, 'UNTRUSTED_COLLECTOR_SENDER');
  const other = port(); runtime.onConnect.emit(other); other.onMessage.emit({ type: 'START_UPDATE' });
  assert.equal(other.sent.at(-1).result.error, 'UNKNOWN_COLLECTOR_MESSAGE');
  await flush(); assert.equal(calls, 0);
});
