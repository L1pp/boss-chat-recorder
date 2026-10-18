/**
 * Standalone WebCrypto storage adapter for the protected BOSS archive keys.
 *
 * The adapter wraps a Chrome-compatible storage area (`raw`) and transparently
 * encrypts/decrypts only the protected archive keys using AES-256-GCM. The
 * CryptoKey is always supplied by the host through the injected async
 * `getKey` provider; this module never generates or persists keys itself.
 *
 * This file has no imports and no import-time side effects. It performs no
 * network access, no password UI, and requests no new permissions.
 */

const ACCOUNT_PARTITIONS_KEY = 'bossReadonlyTracker.accountPartitions.v1';
const ACCOUNT_RUNTIME_KEY = 'bossReadonlyTracker.accountRuntime.v1';
const CONVERSATIONS_PREFIX = 'bossReadonlyTracker.conversations.v1:';

const ENVELOPE_VERSION = 1;
const ENVELOPE_FIELD = '__bossArchiveEncrypted';
const IV_LENGTH = 12;
const TAG_LENGTH = 128;
const TAG_LENGTH_BYTES = TAG_LENGTH / 8;
const AAD_PREFIX = 'boss-archive:v1:';
const GCM = { name: 'AES-GCM' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * True when the storage key belongs to the encrypted archive surface.
 * The conversations key is matched by its documented prefix so that every
 * per-account / per-record child key is protected.
 */
export function isProtectedArchiveKey(key) {
  if (typeof key !== 'string') return false;
  return key === ACCOUNT_PARTITIONS_KEY ||
    key === ACCOUNT_RUNTIME_KEY ||
    key.startsWith(CONVERSATIONS_PREFIX);
}

function archiveError(code) {
  // The message is the opaque static code only. Never carry provider text or
  // secret material across the adapter boundary.
  const error = new Error(code);
  error.code = code;
  return error;
}

function encodeBase64(bytes) {
  // Encode in fixed-size chunks so large values (>= 1 MiB) never require a
  // single `String.fromCharCode(...bytes)` spread of the whole array.
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function decodeBase64(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  }
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function looksLikeEnvelope(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.hasOwn(value, ENVELOPE_FIELD);
}

function readEnvelope(value) {
  if (value[ENVELOPE_FIELD] !== ENVELOPE_VERSION) throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  const { keyId, iv, ciphertext } = value;
  if (typeof keyId !== 'string' || keyId.length === 0) throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  const ivBytes = decodeBase64(iv);
  if (ivBytes.length !== IV_LENGTH) throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  const ciphertextBytes = decodeBase64(ciphertext);
  if (ciphertextBytes.length < TAG_LENGTH_BYTES) throw archiveError('ARCHIVE_CIPHERTEXT_INVALID');
  return { keyId, ivBytes, ciphertextBytes };
}

function additionalData(keyId, storageKey) {
  return encoder.encode(`${AAD_PREFIX}${keyId}:${storageKey}`);
}

export function createEncryptedArchiveStorage(raw, { getKey, cryptoApi = globalThis.crypto } = {}) {
  if (!raw || typeof raw.get !== 'function' || typeof raw.set !== 'function') {
    throw new TypeError('STORAGE_AREA_REQUIRED');
  }
  if (typeof getKey !== 'function') throw new TypeError('KEY_PROVIDER_REQUIRED');
  if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new TypeError('WEBCRYPTO_REQUIRED');
  }

  async function requestKey(params) {
    let info;
    try {
      info = await getKey(params);
    } catch (error) {
      // Preserve only static ARCHIVE_* codes; never forward the raw message.
      const fallback = params.create ? 'ARCHIVE_KEY_UNAVAILABLE' : 'ARCHIVE_KEY_MISSING';
      const code = typeof error?.code === 'string' && /^ARCHIVE_[A-Z0-9_]{1,64}$/u.test(error.code)
        ? error.code : fallback;
      throw archiveError(code);
    }
    if (!info || typeof info.keyId !== 'string' || info.keyId.length === 0 ||
        info.key === null || typeof info.key !== 'object') {
      throw archiveError(params.create ? 'ARCHIVE_KEY_UNAVAILABLE' : 'ARCHIVE_KEY_MISSING');
    }
    return { keyId: info.keyId, key: info.key };
  }

  async function encryptValue(storageKey, value, keyInfo) {
    try {
      const iv = new Uint8Array(IV_LENGTH);
      // A fresh random IV for every value on every write.
      cryptoApi.getRandomValues(iv);
      const plaintext = encoder.encode(JSON.stringify(value));
      const buffer = await cryptoApi.subtle.encrypt(
        { ...GCM, iv, additionalData: additionalData(keyInfo.keyId, storageKey), tagLength: TAG_LENGTH },
        keyInfo.key, plaintext);
      return {
        [ENVELOPE_FIELD]: ENVELOPE_VERSION,
        keyId: keyInfo.keyId,
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(buffer)),
      };
    } catch {
      throw archiveError('ARCHIVE_ENCRYPT_FAILED');
    }
  }

  async function decryptValue(storageKey, envelope) {
    const keyInfo = await requestKey({ create: false, keyId: envelope.keyId });
    if (keyInfo.keyId !== envelope.keyId) throw archiveError('ARCHIVE_KEY_MISMATCH');
    let plaintext;
    try {
      plaintext = await cryptoApi.subtle.decrypt(
        { ...GCM, iv: envelope.ivBytes,
          additionalData: additionalData(envelope.keyId, storageKey), tagLength: TAG_LENGTH },
        keyInfo.key, envelope.ciphertextBytes);
    } catch {
      throw archiveError('ARCHIVE_DECRYPT_FAILED');
    }
    try {
      return JSON.parse(decoder.decode(plaintext));
    } catch {
      throw archiveError('ARCHIVE_DECRYPT_FAILED');
    }
  }

  async function set(items) {
    if (items === null || typeof items !== 'object') throw new TypeError('STORAGE_ITEMS_REQUIRED');
    const names = Object.keys(items);
    const protectedNames = names.filter(name => items[name] !== undefined && isProtectedArchiveKey(name));
    // One provider call per batch; the same key encrypts every value, but each
    // value still gets its own random IV.
    const keyInfo = protectedNames.length > 0 ? await requestKey({ create: true }) : null;
    // Encrypt the whole batch before touching storage. A mid-batch failure
    // leaves `raw` untouched: no plaintext is written and no old value removed.
    const next = {};
    for (const name of names) {
      const value = items[name];
      next[name] = value !== undefined && isProtectedArchiveKey(name)
        ? await encryptValue(name, value, keyInfo)
        : value;
    }
    await raw.set(next);
  }

  async function get(keys) {
    // Pass the original argument straight through: string, array, object of
    // defaults, or no argument at all (read everything).
    const stored = keys === undefined ? await raw.get() : await raw.get(keys);
    if (stored === null || typeof stored !== 'object') return stored;
    const next = {};
    for (const [name, value] of Object.entries(stored)) {
      if (isProtectedArchiveKey(name) && looksLikeEnvelope(value)) {
        next[name] = await decryptValue(name, readEnvelope(value));
      } else {
        // Legacy plaintext (or non-archive values) pass through untouched; a
        // get never migrates or rewrites stored data.
        next[name] = value;
      }
    }
    return next;
  }

  async function remove(keys) {
    if (typeof raw.remove !== 'function') throw new TypeError('STORAGE_REMOVE_UNAVAILABLE');
    return raw.remove(keys);
  }

  const api = { get, set, remove };
  if (typeof raw.getBytesInUse === 'function') {
    api.getBytesInUse = keys => raw.getBytesInUse(keys);
  }
  return api;
}
