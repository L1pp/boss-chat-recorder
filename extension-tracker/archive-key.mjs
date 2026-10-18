import { createEncryptedArchiveStorage } from './encrypted-storage.mjs';

const DATABASE = 'bossReadonlyTracker.archiveKey.v1';
const STORE = 'keys';
const ENTRY = 'archive';
const failure = code => Object.assign(new Error(code), { code });

function validEntry(value) {
  return value && typeof value.keyId === 'string' && value.keyId.length > 0 &&
    value.key?.type === 'secret' && value.key.algorithm?.name === 'AES-GCM' &&
    value.key.algorithm?.length === 256 && value.key.extractable === false &&
    value.key.usages?.includes('encrypt') && value.key.usages?.includes('decrypt');
}

// One non-exportable key per extension profile. No password, server or key rotation.
export function createArchiveKeyProvider({ indexedDB = globalThis.indexedDB,
  cryptoApi = globalThis.crypto } = {}) {
  let databasePromise;
  let cached;
  let creation;

  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        if (!indexedDB?.open) { reject(failure('ARCHIVE_KEY_UNAVAILABLE')); return; }
        let request, failed = false;
        const unavailable = () => { failed = true; reject(failure('ARCHIVE_KEY_UNAVAILABLE')); };
        try { request = indexedDB.open(DATABASE, 1); }
        catch { reject(failure('ARCHIVE_KEY_UNAVAILABLE')); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onerror = unavailable;
        request.onblocked = unavailable;
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => { db.close(); databasePromise = undefined; cached = undefined; };
          resolve(db);
        };
      });
      databasePromise.catch(() => { databasePromise = undefined; });
    }
    return databasePromise;
  }

  async function stored(candidate = null) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let invalid = false;
      try {
        transaction = db.transaction(STORE, candidate ? 'readwrite' : 'readonly');
        const store = transaction.objectStore(STORE);
        const request = store.get(ENTRY);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing !== undefined && !validEntry(existing)) {
            invalid = true;
            transaction.abort();
          } else if (existing) result = existing;
          else if (candidate) {
            // The read and add share one readwrite transaction. Another provider
            // must read the committed winner rather than replace its key.
            result = candidate;
            store.add(candidate, ENTRY);
          }
        };
        transaction.oncomplete = () => resolve(result || null);
        transaction.onerror = transaction.onabort = () => reject(failure(
          invalid ? 'ARCHIVE_KEY_INVALID' : 'ARCHIVE_KEY_UNAVAILABLE'));
      } catch { reject(failure('ARCHIVE_KEY_UNAVAILABLE')); }
    });
  }

  async function loadOrCreate() {
    const existing = await stored();
    if (existing) return existing;
    if (!cryptoApi?.subtle || !cryptoApi.randomUUID) throw failure('ARCHIVE_CRYPTO_UNAVAILABLE');
    let candidate;
    try {
      // Never await WebCrypto inside an IndexedDB transaction.
      candidate = { keyId: cryptoApi.randomUUID(), key: await cryptoApi.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) };
    } catch { throw failure('ARCHIVE_CRYPTO_UNAVAILABLE'); }
    return stored(candidate);
  }

  return async function getKey({ create = false, keyId } = {}) {
    let entry = cached;
    if (!entry && create) {
      if (!creation) {
        creation = loadOrCreate();
        creation.catch(() => {}).finally(() => { creation = undefined; });
      }
      entry = await creation;
    } else if (!entry) entry = await stored();
    if (!entry) throw failure('ARCHIVE_KEY_MISSING');
    if (!validEntry(entry)) throw failure('ARCHIVE_KEY_INVALID');
    if (keyId !== undefined && entry.keyId !== keyId) throw failure('ARCHIVE_KEY_MISMATCH');
    cached = entry;
    return entry;
  };
}

// Only the account store receives this adapter. Popup summaries, the request
// scheduler and development pairing remain on their existing storage paths.
export function createProtectedAccountStorage(chromeApi, options = {}) {
  const raw = chromeApi.storage.local;
  const getKey = options.getKey || createArchiveKeyProvider(options);
  const encrypted = createEncryptedArchiveStorage(raw, { getKey, cryptoApi: options.cryptoApi });
  const ready = Promise.resolve().then(async () => {
    if (typeof raw.setAccessLevel !== 'function') throw failure('ARCHIVE_ACCESS_UNAVAILABLE');
    try { await raw.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); }
    catch { throw failure('ARCHIVE_ACCESS_UNAVAILABLE'); }
  });
  // Construction is synchronous; report a failure through the first storage
  // operation instead of leaving an unhandled rejection during worker startup.
  ready.catch(() => {});
  return {
    async get(keys) { await ready; return encrypted.get(keys); },
    async set(values) { await ready; return encrypted.set(values); },
    async remove(keys) { await ready; return encrypted.remove(keys); },
    ...(raw.getBytesInUse ? { getBytesInUse: raw.getBytesInUse.bind(raw) } : {}),
  };
}
