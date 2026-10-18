import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createArchiveKeyProvider, createProtectedAccountStorage } from '../extension-tracker/archive-key.mjs';
import { createAccountStore, ACCOUNT_STORE_KEY, ACCOUNT_RUNTIME_KEY } from '../extension-tracker/account-store.mjs';

// Event-driven IndexedDB test double. Transactions serialize per object store,
// commit staged values only on complete, and structured-clone actual CryptoKeys.
function keyDatabase() {
  const records = new Map();
  let created = false, tail = Promise.resolve(), failCommit = false;
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore() { created = true; },
    close() {},
    transaction(_name, mode) {
      const jobs = [];
      let aborted = false;
      const tx = {
        abort() { aborted = true; },
        objectStore() {
          return {
            get(key) { const request = {}; jobs.push({ kind: 'get', key, request }); return request; },
            add(value, key) { jobs.push({ kind: 'add', key, value: structuredClone(value) }); },
          };
        },
      };
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      setImmediate(async () => {
        await previous;
        const staged = new Map(records);
        for (const job of jobs) {
          if (aborted) break;
          if (job.kind === 'get') {
            job.request.result = structuredClone(staged.get(job.key));
            job.request.onsuccess?.();
          } else if (staged.has(job.key)) aborted = true;
          else staged.set(job.key, job.value);
        }
        if (failCommit && mode === 'readwrite') { failCommit = false; aborted = true; }
        if (aborted) tx.onabort?.();
        else {
          if (mode === 'readwrite') {
            records.clear();
            for (const [key, value] of staged) records.set(key, value);
          }
          tx.oncomplete?.();
        }
        release();
      });
      return tx;
    },
  };
  return {
    records,
    failNextCommit() { failCommit = true; },
    indexedDB: { open() {
      const request = {};
      setImmediate(() => {
        request.result = db;
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    } },
  };
}

function localStorage() {
  const values = {};
  const access = [];
  return { values, access, raw: {
    async get(keys) {
      const names = typeof keys === 'string' ? [keys] : keys;
      assert.ok(Array.isArray(names), 'account operations never enumerate unrelated storage');
      return Object.fromEntries(names.filter(k => Object.hasOwn(values, k)).map(k => [k, structuredClone(values[k])]));
    },
    async set(items) { Object.assign(values, structuredClone(items)); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key]; },
    async setAccessLevel(value) { access.push(value); },
  } };
}

test('profile key is non-exportable and survives a provider restart without recreation', async () => {
  const database = keyDatabase();
  const options = { indexedDB: database.indexedDB, cryptoApi: webcrypto };
  const first = createArchiveKeyProvider(options);
  await assert.rejects(first({ create: false }), { code: 'ARCHIVE_KEY_MISSING' });
  assert.equal(database.records.size, 0);
  const [a, b] = await Promise.all([first({ create: true }), first({ create: true })]);
  assert.equal(a.keyId, b.keyId);
  assert.equal(a.key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', a.key));
  const restart = createArchiveKeyProvider(options);
  const restored = await restart({ create: false, keyId: a.keyId });
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.key, new TextEncoder().encode('合成正文'));
  const clear = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, restored.key, encrypted);
  assert.equal(new TextDecoder().decode(clear), '合成正文');
  assert.equal(database.records.size, 1);
});

test('independent concurrent providers keep the same transaction-committed key', async () => {
  const database = keyDatabase();
  const options = { indexedDB: database.indexedDB, cryptoApi: webcrypto };
  const providers = [createArchiveKeyProvider(options), createArchiveKeyProvider(options), createArchiveKeyProvider(options)];
  const entries = await Promise.all(providers.map(provider => provider({ create: true })));
  assert.equal(new Set(entries.map(entry => entry.keyId)).size, 1);
  assert.equal(database.records.size, 1);
  assert.equal(entries[0].keyId, database.records.get('archive').keyId);
});

test('failed key commit is not cached and an invalid stored key is never replaced', async () => {
  const database = keyDatabase();
  const options = { indexedDB: database.indexedDB, cryptoApi: webcrypto };
  const provider = createArchiveKeyProvider(options);
  database.failNextCommit();
  await assert.rejects(provider({ create: true }), { code: 'ARCHIVE_KEY_UNAVAILABLE' });
  assert.equal(database.records.size, 0);
  assert.ok((await provider({ create: true })).keyId);
  database.records.set('archive', { keyId: 'damaged', key: 'synthetic-invalid-key' });
  const restarted = createArchiveKeyProvider(options);
  await assert.rejects(restarted({ create: true }), { code: 'ARCHIVE_KEY_INVALID' });
  assert.equal(database.records.get('archive').key, 'synthetic-invalid-key');
});

test('missing or mismatched keys fail without automatic replacement', async () => {
  const database = keyDatabase();
  const options = { indexedDB: database.indexedDB, cryptoApi: webcrypto };
  const key = await createArchiveKeyProvider(options)({ create: true });
  await assert.rejects(createArchiveKeyProvider(options)({ create: false, keyId: 'wrong' }), { code: 'ARCHIVE_KEY_MISMATCH' });
  assert.equal(database.records.get('archive').keyId, key.keyId);
  database.records.clear();
  await assert.rejects(createArchiveKeyProvider(options)({ create: false, keyId: key.keyId }), { code: 'ARCHIVE_KEY_MISSING' });
  assert.equal(database.records.size, 0);
  await assert.rejects(createArchiveKeyProvider({ indexedDB: null })({ create: true }), { code: 'ARCHIVE_KEY_UNAVAILABLE' });
});

test('encrypted account store retains partitioning, sharded commits, exports and targeted clear', async () => {
  const database = keyDatabase();
  const memory = localStorage();
  const chromeApi = { storage: { local: memory.raw } };
  const options = { indexedDB: database.indexedDB, cryptoApi: webcrypto };
  const encrypted = createProtectedAccountStorage(chromeApi, options);
  const store = createAccountStore(chromeApi, { storage: encrypted });
  for (const uid of ['accountA', 'accountB']) {
    await store.updateAccount(uid, partition => {
      partition.state.contacts.hr = { identity: { bossId: 'same-hr', hrName: `私有联系人-${uid}` } };
    });
    await store.prepareAccountBody(uid);
  }
  assert.deepEqual(memory.access, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal(memory.values[ACCOUNT_STORE_KEY].__bossArchiveEncrypted, 1);
  assert.equal(memory.values[ACCOUNT_RUNTIME_KEY].__bossArchiveEncrypted, 1);
  assert.ok(!JSON.stringify(memory.values).includes('私有联系人'));
  const restarted = createAccountStore(chromeApi, { storage: createProtectedAccountStorage(chromeApi, options) });
  assert.equal((await restarted.getAccount('accountA')).state.contacts.hr.identity.hrName, '私有联系人-accountA');
  await restarted.clearAccount('accountA');
  assert.equal(await restarted.getAccount('accountA'), null);
  assert.equal((await restarted.getAccount('accountB')).state.contacts.hr.identity.hrName, '私有联系人-accountB');
  assert.equal(database.records.size, 1, 'clearing an account preserves the shared profile key');
});

test('storage access restriction failure keeps the existing database untouched', async () => {
  const memory = localStorage();
  memory.raw.setAccessLevel = async () => { throw new Error('synthetic private detail'); };
  let keyCalls = 0;
  const store = createProtectedAccountStorage({ storage: { local: memory.raw } }, {
    cryptoApi: webcrypto, getKey: async () => { keyCalls++; throw new Error('unused'); },
  });
  await assert.rejects(store.set({ [ACCOUNT_RUNTIME_KEY]: { schemaVersion: 1 } }), { code: 'ARCHIVE_ACCESS_UNAVAILABLE' });
  assert.equal(keyCalls, 0);
  assert.deepEqual(memory.values, {});
});
