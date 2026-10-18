import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  isProtectedArchiveKey,
  createEncryptedArchiveStorage,
} from '../extension-tracker/encrypted-storage.mjs';

const PARTITIONS_KEY = 'bossReadonlyTracker.accountPartitions.v1';
const RUNTIME_KEY = 'bossReadonlyTracker.accountRuntime.v1';
const conversationsPrefix = 'bossReadonlyTracker.conversations.v1:';
const conversationKey = (uid, suffix = 'header') =>
  `${conversationsPrefix}${encodeURIComponent(uid)}:${suffix}`;

// In-memory Chrome-like storage area. `get` mirrors Chrome's string / array /
// object-of-defaults / no-arg semantics; `set` and `remove` are recorded.
function createMemoryRaw(seed = {}, { withGetBytesInUse = true } = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, set: 0, remove: 0 };
  const raw = {
    async get(keys) {
      calls.get += 1;
      if (keys === undefined || keys === null) {
        const all = {};
        for (const [name, value] of store) all[name] = value;
        return all;
      }
      if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
      if (Array.isArray(keys)) {
        const result = {};
        for (const name of keys) if (store.has(name)) result[name] = store.get(name);
        return result;
      }
      const result = {};
      for (const [name, fallback] of Object.entries(keys)) {
        result[name] = store.has(name) ? store.get(name) : fallback;
      }
      return result;
    },
    async set(items) {
      calls.set += 1;
      for (const [name, value] of Object.entries(items)) store.set(name, value);
    },
    async remove(keys) {
      calls.remove += 1;
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const name of list) store.delete(name);
    },
  };
  if (withGetBytesInUse) raw.getBytesInUse = async () => 0;
  return { raw, store, calls };
}

// Host-injected key provider test double. `keyStore` persists across adapter
// restarts, simulating the host's IDB-backed provider. This double never
// appears in production code; it exists only to exercise the adapter.
function createKeyProvider(keyStore = new Map(), { keyId = 'key-1' } = {}) {
  const calls = [];
  async function issue() {
    const existing = keyStore.get(keyId);
    if (existing) return { ...existing };
    const key = await webcrypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const entry = { keyId, key };
    keyStore.set(keyId, entry);
    return { ...entry };
  }
  async function getKey(params = {}) {
    calls.push(params);
    if (params.create) return issue();
    const existing = keyStore.get(params.keyId);
    if (!existing) {
      const error = new Error('provider: no such key');
      error.code = 'ARCHIVE_KEY_MISSING';
      throw error;
    }
    return { ...existing };
  }
  return { provider: getKey, calls, keyStore };
}

function setup({ seed, withGetBytesInUse } = {}) {
  const memory = createMemoryRaw(seed, { withGetBytesInUse });
  const host = createKeyProvider();
  const storage = createEncryptedArchiveStorage(memory.raw, {
    getKey: host.provider,
    cryptoApi: webcrypto,
  });
  return { ...memory, host, storage };
}

test('isProtectedArchiveKey matches the exact protected keys and conversations prefix', () => {
  assert.equal(isProtectedArchiveKey(PARTITIONS_KEY), true);
  assert.equal(isProtectedArchiveKey(RUNTIME_KEY), true);
  assert.equal(isProtectedArchiveKey(conversationKey('account-1')), true);
  assert.equal(isProtectedArchiveKey(`${conversationsPrefix}x`), true);
  assert.equal(isProtectedArchiveKey('bossReadonlyTracker.conversations.v1'), false);
  assert.equal(isProtectedArchiveKey('bossReadonlyTracker.accountRuntime.v2'), false);
  assert.equal(isProtectedArchiveKey('bossReadonlyTracker.accountPartitions.v1x'), false);
  assert.equal(isProtectedArchiveKey('someOtherKey'), false);
  assert.equal(isProtectedArchiveKey(123), false);
  assert.equal(isProtectedArchiveKey(null), false);
});

test('encrypts on write and round-trips through a fresh adapter (restart read)', async () => {
  const { raw, store } = createMemoryRaw();
  const keyStore = new Map();
  const firstProvider = createKeyProvider(keyStore);
  const first = createEncryptedArchiveStorage(raw, {
    getKey: firstProvider.provider, cryptoApi: webcrypto });
  const value = { schemaVersion: 1, accountUid: 'acc1', nested: { list: [1, 2, 3] },
    token: 'super-secret-token' };
  await first.set({ [RUNTIME_KEY]: value });
  // The create path was requested exactly once.
  assert.equal(firstProvider.calls.length, 1);
  assert.equal(firstProvider.calls[0].create, true);

  const stored = store.get(RUNTIME_KEY);
  assert.equal(stored.__bossArchiveEncrypted, 1);
  assert.equal(stored.keyId, 'key-1');
  assert.equal(Buffer.from(stored.iv, 'base64').length, 12);
  // No plaintext or secret material is persisted.
  assert.ok(!JSON.stringify(stored).includes('super-secret-token'));
  assert.ok(!JSON.stringify(stored).includes('acc1'));

  // "Restart": a new adapter whose provider is backed by the same key store.
  const secondProvider = createKeyProvider(keyStore);
  const second = createEncryptedArchiveStorage(raw, {
    getKey: secondProvider.provider, cryptoApi: webcrypto });
  const got = await second.get(RUNTIME_KEY);
  assert.deepEqual(got[RUNTIME_KEY], value);
  // Reads only ever ask for an existing key, never create.
  assert.ok(secondProvider.calls.length > 0);
  assert.ok(secondProvider.calls.every(call => call.create === false && call.keyId === 'key-1'));
});

test('uses a fresh random IV per value and per write', async () => {
  const { store, storage } = setup();

  await storage.set({ [RUNTIME_KEY]: { n: 1 } });
  const firstIv = store.get(RUNTIME_KEY).iv;
  await storage.set({ [RUNTIME_KEY]: { n: 2 } });
  const secondIv = store.get(RUNTIME_KEY).iv;
  assert.notEqual(firstIv, secondIv);

  await storage.set({ [RUNTIME_KEY]: { n: 3 }, [PARTITIONS_KEY]: { n: 4 } });
  assert.notEqual(store.get(RUNTIME_KEY).iv, store.get(PARTITIONS_KEY).iv);
  assert.equal(Buffer.from(store.get(RUNTIME_KEY).iv, 'base64').length, 12);
  assert.equal(Buffer.from(store.get(PARTITIONS_KEY).iv, 'base64').length, 12);
});

test('AAD binding fails on cross-key and cross-UID relocation', async () => {
  const { store, storage } = setup();
  const uidA = 'account-a';
  const uidB = 'account-b';
  const headerA = conversationKey(uidA, 'header');
  const versionsA = conversationKey(uidA, 'versions');
  const headerB = conversationKey(uidB, 'header');

  await storage.set({ [headerA]: { owner: uidA } });
  const envelopeA = { ...store.get(headerA) };

  // Move ciphertext to a different key for the same account.
  store.set(versionsA, { ...envelopeA });
  await assert.rejects(() => storage.get(versionsA),
    error => error.code === 'ARCHIVE_DECRYPT_FAILED');

  // Move ciphertext to another account's key.
  store.set(headerB, { ...envelopeA });
  await assert.rejects(() => storage.get(headerB),
    error => error.code === 'ARCHIVE_DECRYPT_FAILED');

  // The legitimately stored value still decodes.
  const ok = await storage.get(headerA);
  assert.deepEqual(ok[headerA], { owner: uidA });
});

test('unknown/missing key and corrupt ciphertext fail with static codes and never mutate stored data', async () => {
  const { raw, store, storage } = setup();
  await storage.set({ [RUNTIME_KEY]: { keep: true } });
  const original = JSON.parse(JSON.stringify(store.get(RUNTIME_KEY)));

  // Provider with an empty key store => the referenced key is unknown.
  const emptyProvider = createKeyProvider(new Map());
  const missingStorage = createEncryptedArchiveStorage(raw, {
    getKey: emptyProvider.provider, cryptoApi: webcrypto });
  await assert.rejects(() => missingStorage.get(RUNTIME_KEY), error => {
    assert.equal(error.code, 'ARCHIVE_KEY_MISSING');
    assert.equal(error.message, 'ARCHIVE_KEY_MISSING');
    return true;
  });
  assert.deepEqual(store.get(RUNTIME_KEY), original);

  // Structurally invalid envelope (bad version) => static ARCHIVE_CIPHERTEXT_INVALID.
  store.set(RUNTIME_KEY, { __bossArchiveEncrypted: 2, keyId: 'key-1',
    iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' });
  await assert.rejects(() => storage.get(RUNTIME_KEY),
    error => error.code === 'ARCHIVE_CIPHERTEXT_INVALID');

  // Structurally invalid envelope (missing field).
  store.set(RUNTIME_KEY, { __bossArchiveEncrypted: 1, keyId: 'key-1', iv: 'AAAAAAAAAAAAAAAA' });
  await assert.rejects(() => storage.get(RUNTIME_KEY),
    error => error.code === 'ARCHIVE_CIPHERTEXT_INVALID');

  // Well-formed but tampered ciphertext => authentication failure.
  store.set(RUNTIME_KEY, { ...original });
  const clean = { ...store.get(RUNTIME_KEY) };
  const bytes = Buffer.from(clean.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  const badEnvelope = { ...clean, ciphertext: bytes.toString('base64') };
  store.set(RUNTIME_KEY, badEnvelope);
  await assert.rejects(() => storage.get(RUNTIME_KEY),
    error => error.code === 'ARCHIVE_DECRYPT_FAILED');
  // get never rewrites storage.
  assert.deepEqual(store.get(RUNTIME_KEY), badEnvelope);
});

test('legacy plaintext is read as-is and never auto-migrated, but new writes encrypt', async () => {
  const legacy = { schemaVersion: 1, foo: 'bar', items: [1, 2, 3] };
  const { store, host, storage } = setup({ seed: { [PARTITIONS_KEY]: legacy } });
  const callsBefore = host.calls.length;

  const got = await storage.get(PARTITIONS_KEY);
  assert.deepEqual(got[PARTITIONS_KEY], legacy);
  // No rewrite: the key is still plaintext after a read.
  assert.deepEqual(store.get(PARTITIONS_KEY), legacy);
  // A legacy plaintext read must not consult the key provider.
  assert.equal(host.calls.length, callsBefore);

  await storage.set({ [PARTITIONS_KEY]: { foo: 'baz' } });
  assert.equal(store.get(PARTITIONS_KEY).__bossArchiveEncrypted, 1);
});

test('non-archive keys pass through without ever calling the key provider', async () => {
  const store = new Map();
  const failingProvider = async () => { throw new Error('provider must not be called'); };
  const storage = createEncryptedArchiveStorage(
    {
      async get(keys) {
        if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
        const result = {};
        for (const [name, value] of store) result[name] = value;
        return result;
      },
      async set(items) { for (const [name, value] of Object.entries(items)) store.set(name, value); },
      async remove(keys) {
        const list = typeof keys === 'string' ? [keys] : keys;
        for (const name of list) store.delete(name);
      },
    },
    { getKey: failingProvider, cryptoApi: webcrypto },
  );

  await storage.set({ someOtherKey: { a: 1 }, bossReadonlyTrackerOther: 'plain' });
  assert.deepEqual(store.get('someOtherKey'), { a: 1 });
  const got = await storage.get('someOtherKey');
  assert.deepEqual(got.someOtherKey, { a: 1 });
  // Adapter without getBytesInUse on raw does not expose one.
  assert.equal(storage.getBytesInUse, undefined);
});

test('a mid-batch encryption failure preserves every previous value and makes no write', async () => {
  const { raw, store, calls, storage } = setup();
  await storage.set({ [RUNTIME_KEY]: { old: 'runtime' }, [PARTITIONS_KEY]: { old: 'partitions' } });
  const beforeRuntime = JSON.parse(JSON.stringify(store.get(RUNTIME_KEY)));
  const beforePartitions = JSON.parse(JSON.stringify(store.get(PARTITIONS_KEY)));
  const writesBefore = calls.set;

  const circular = {};
  circular.self = circular;
  await assert.rejects(
    () => storage.set({ nonArchive: 'x', [RUNTIME_KEY]: circular }),
    error => error.code === 'ARCHIVE_ENCRYPT_FAILED');

  assert.equal(calls.set, writesBefore); // raw.set never called
  assert.equal(store.has('nonArchive'), false); // non-archive value not persisted either
  assert.deepEqual(store.get(RUNTIME_KEY), beforeRuntime);
  assert.deepEqual(store.get(PARTITIONS_KEY), beforePartitions);

  // A provider failure mid-batch also writes nothing and leaks no secret text.
  const failingProvider = async () => {
    throw new Error('secret internal detail');
  };
  const blocked = createEncryptedArchiveStorage(raw, {
    getKey: failingProvider, cryptoApi: webcrypto });
  await assert.rejects(() => blocked.set({ [RUNTIME_KEY]: { x: 1 } }), error => {
    assert.equal(error.code, 'ARCHIVE_KEY_UNAVAILABLE');
    assert.equal(error.message, 'ARCHIVE_KEY_UNAVAILABLE');
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(calls.set, writesBefore);
  assert.deepEqual(store.get(RUNTIME_KEY), beforeRuntime);
});

test('handles a >1 MiB non-ASCII value', async () => {
  const { storage } = setup();
  const uid = 'account-big';
  const key = conversationKey(uid, 'record:1');
  const big = '数据'.repeat(300000); // > 1 MiB once UTF-8 encoded
  assert.ok(Buffer.byteLength(big, 'utf8') > 1024 * 1024);

  await storage.set({ [key]: big });
  const got = await storage.get([key]);
  assert.equal(got[key], big);
});

test('deleting account A does not disturb account B', async () => {
  const { store, calls, storage } = setup();
  const headerA = conversationKey('account-a', 'header');
  const versionsA = conversationKey('account-a', 'versions');
  const headerB = conversationKey('account-b', 'header');

  await storage.set({ [headerA]: { a: 1 }, [versionsA]: { a: 2 }, [headerB]: { b: 1 } });

  await storage.remove([headerA, versionsA]);
  assert.equal(calls.remove, 1);
  assert.equal(store.has(headerA), false);
  assert.equal(store.has(versionsA), false);
  assert.equal(store.has(headerB), true);

  const got = await storage.get([headerA, headerB]);
  assert.equal(got[headerA], undefined);
  assert.deepEqual(got[headerB], { b: 1 });
});

test('get forwards object-of-defaults semantics and exposes bound getBytesInUse', async () => {
  const { raw, storage } = setup();
  assert.equal(typeof storage.getBytesInUse, 'function');

  const headerB = conversationKey('account-b', 'header');
  // Absent protected key with a default: Chrome returns the default verbatim.
  const got = await storage.get({ [headerB]: { fallback: true }, someOther: 7 });
  assert.deepEqual(got[headerB], { fallback: true });
  assert.equal(got.someOther, 7);

  let passedKeys;
  raw.getBytesInUse = async keys => { passedKeys = keys; return 42; };
  const bytes = await storage.getBytesInUse([RUNTIME_KEY]);
  assert.equal(bytes, 42);
  assert.deepEqual(passedKeys, [RUNTIME_KEY]);
});
