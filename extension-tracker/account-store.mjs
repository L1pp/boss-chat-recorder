import { createEmptyState, normalizeState, summarizeState } from './model.mjs';
import { createConversationBodyStore } from './conversation-store.mjs';

export const ACCOUNT_STORE_KEY = 'bossReadonlyTracker.accountPartitions.v1';
export const ACCOUNT_RUNTIME_KEY = 'bossReadonlyTracker.accountRuntime.v1';
export const ACCOUNT_STORE_SCHEMA_VERSION = 1;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** Accept only a stable, storage-safe BOSS user identifier. */
export function normalizeAccountUid(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value) || /^0+$/u.test(value)) return null;
  return value;
}

export function accountPartitionKey(value) {
  const accountUid = normalizeAccountUid(value);
  if (!accountUid) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
  // Prefixing and encoding prevents special object-property names from becoming keys.
  return `account:${encodeURIComponent(accountUid)}`;
}

function emptyRuntime() {
  return { progressByTab: {}, sourceStatus: {}, logs: [] };
}

export function createAccountPartition(accountUid, { now } = {}) {
  const uid = normalizeAccountUid(accountUid);
  if (!uid) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
  return {
    schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION,
    accountUid: uid,
    state: createEmptyState(now ? { now } : {}),
    runtime: emptyRuntime(),
    // The prior API run and the identity-keyed contact baseline are account-local.
    baseline: { previousProgress: null },
  };
}

function normalizePartition(value, accountUid) {
  if (!object(value) || value.schemaVersion !== ACCOUNT_STORE_SCHEMA_VERSION || value.accountUid !== accountUid) {
    throw new Error('ACCOUNT_PARTITION_INVALID');
  }
  const runtime = object(value.runtime) ? value.runtime : {};
  const baseline = object(value.baseline) ? value.baseline : {};
  // Chrome storage.get has already deserialized an independent object for this
  // transaction. Normalize that owned copy without cloning the account library
  // or repeatedly copying its state, runtime, and baseline.
  value.state = normalizeState(object(value.state) ? value.state : createEmptyState(), { copy: false });
  runtime.progressByTab = object(runtime.progressByTab) ? runtime.progressByTab : {};
  runtime.sourceStatus = object(runtime.sourceStatus) ? runtime.sourceStatus : {};
  runtime.logs = Array.isArray(runtime.logs) ? runtime.logs : [];
  value.runtime = runtime;
  baseline.previousProgress ??= null;
  value.baseline = baseline;
  return value;
}

function emptyRoot() {
  return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION, accounts: {}, tabBindings: {} };
}

function normalizeRoot(value) {
  if (value === undefined || value === null) return emptyRoot();
  if (!object(value) || value.schemaVersion !== ACCOUNT_STORE_SCHEMA_VERSION ||
      !object(value.accounts) || !object(value.tabBindings)) {
    throw new Error('ACCOUNT_STORE_INVALID');
  }
  return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION, accounts: value.accounts,
    tabBindings: value.tabBindings };
}

function validTabId(tabId) {
  return Number.isSafeInteger(tabId) && tabId >= 0;
}

function validToken(token) {
  return typeof token === 'string' && token.length >= 8 && token.length <= 256;
}

function matchesBinding(binding, { tabId, accountUid, collectionToken }) {
  return validTabId(tabId) && object(binding) && binding.accountUid === accountUid &&
    binding.collectionToken === collectionToken;
}

function serialQueue() {
  let tail = Promise.resolve();
  return task => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * Serialized account-partition storage. The legacy bossReadonlyTracker.v2 key is
 * intentionally never read or modified, so old unpartitioned data is not claimed.
 */
export function createAccountStore(chromeApi = globalThis.chrome, { onStorageEvent, storage: providedStorage } = {}) {
  const storage = providedStorage || chromeApi?.storage?.local;
  if (!storage?.get || !storage?.set) throw new Error('CHROME_LOCAL_STORAGE_REQUIRED');
  const enqueue = serialQueue();
  const bodies = createConversationBodyStore(storage, storageOperation);

  async function storageOperation(operation, task) {
    const started = Date.now();
    try { onStorageEvent?.('begin', { operation }); } catch { /* Optional diagnostics. */ }
    try {
      const result = await task();
      try { onStorageEvent?.('end', { operation, ok: true, durationMs: Date.now() - started }); } catch { /* Optional diagnostics. */ }
      return result;
    } catch (error) {
      try { onStorageEvent?.('end', { operation, ok: false, durationMs: Date.now() - started,
        errorCode: error?.code || 'STORAGE_ERROR' }); } catch { /* Optional diagnostics. */ }
      throw error;
    }
  }

  function runtimePartition(partition) {
    normalizePartition(partition, partition.accountUid);
    return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION, accountUid: partition.accountUid,
      runtime: partition.runtime, baseline: partition.baseline,
      summary: partition.bodyStore ? partition.summary : summarizeState(partition.state),
      ...(partition.bodyStore ? { bodyStore: partition.bodyStore } : {}) };
  }

  function runtimeLookup(root, accountUid) {
    const partition = root.accounts[accountPartitionKey(accountUid)];
    if (partition === undefined) return null;
    if (!object(partition) || partition.schemaVersion !== ACCOUNT_STORE_SCHEMA_VERSION ||
        partition.accountUid !== accountUid) throw new Error('ACCOUNT_PARTITION_INVALID');
    return partition;
  }

  function runtimeRoot(root) {
    return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION,
      accounts: Object.fromEntries(Object.entries(root.accounts).map(([key, partition]) =>
        [key, runtimePartition(partition)])), tabBindings: root.tabBindings };
  }

  async function writeRuntime(root) {
    await storageOperation('runtime.set', () => storage.set({ [ACCOUNT_RUNTIME_KEY]: root }));
  }

  async function readRuntime(seed = null) {
    const stored = await storageOperation('runtime.get', () => storage.get(ACCOUNT_RUNTIME_KEY));
    if (stored?.[ACCOUNT_RUNTIME_KEY] !== undefined) return normalizeRoot(stored[ACCOUNT_RUNTIME_KEY]);
    // Bootstrap only an absent runtime key. The original body remains intact;
    // an initialized runtime key is authoritative, including cleared accounts.
    if (!seed) {
      const body = await storageOperation('account.get', () => storage.get(ACCOUNT_STORE_KEY));
      seed = normalizeRoot(body?.[ACCOUNT_STORE_KEY]);
    }
    const root = runtimeRoot(seed);
    await writeRuntime(root);
    return root;
  }

  async function readRoot() {
    const stored = await storageOperation('account.get', () => storage.get(ACCOUNT_STORE_KEY));
    const root = normalizeRoot(stored?.[ACCOUNT_STORE_KEY]);
    const live = await readRuntime(root);
    for (const [key, partition] of Object.entries(root.accounts)) {
      const metadata = live.accounts[key];
      // A body commit can succeed before its first metadata publish fails.
      // Preserve that body, but never revive legacy tokens or progress.
      partition.runtime = metadata?.runtime || emptyRuntime();
      partition.baseline = metadata?.baseline || { previousProgress: null };
      if (metadata?.bodyStore) {
        partition.bodyStore = metadata.bodyStore;
        partition.summary = metadata.summary;
      } else {
        delete partition.bodyStore;
        delete partition.summary;
      }
    }
    root.tabBindings = live.tabBindings;
    return root;
  }

  async function writeRoot(root) {
    await storageOperation('account.set', () => storage.set({ [ACCOUNT_STORE_KEY]: root }));
    // Publish summaries/completion state only after the body commit succeeds.
    await writeRuntime(runtimeRoot(root));
  }

  function uidOrThrow(value) {
    const accountUid = normalizeAccountUid(value);
    if (!accountUid) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
    return accountUid;
  }

  function lookup(root, accountUid) {
    const partition = root.accounts[accountPartitionKey(accountUid)];
    return partition === undefined ? null : normalizePartition(partition, accountUid);
  }

  async function ensure(root, accountUid) {
    const key = accountPartitionKey(accountUid);
    const existing = lookup(root, accountUid);
    if (existing) return { partition: existing, created: false };
    const partition = createAccountPartition(accountUid);
    root.accounts[key] = partition;
    return { partition, created: true };
  }

  async function completePartition(accountUid, create = false) {
    const runtime = await readRuntime();
    const metadata = runtimeLookup(runtime, accountUid);
    if (metadata?.bodyStore) {
      const body = await bodies.read(accountUid);
      return { ...metadata, state: body.state, summary: body.header.summary };
    }
    const root = await readRoot();
    if (!create) return lookup(root, accountUid);
    const { partition, created } = await ensure(root, accountUid);
    if (created) await writeRoot(root);
    return partition;
  }

  async function prepareBody(accountUid, { includeState = false } = {}) {
    let runtime = await readRuntime();
    const existing = runtimeLookup(runtime, accountUid);
    if (existing?.bodyStore) {
      if (!includeState) return runtime;
      const body = await bodies.read(accountUid);
      return { ...existing, state: body.state, summary: body.header.summary };
    }
    const root = await readRoot();
    const { partition, created } = await ensure(root, accountUid);
    if (created) await writeRoot(root);
    // One-time local preparation happens before the page collector is started.
    // The legacy body is retained and the new pointer is published last.
    const header = await bodies.commit(accountUid, partition.state);
    runtime = await readRuntime();
    runtime.accounts[accountPartitionKey(accountUid)] = {
      ...runtimeLookup(runtime, accountUid), bodyStore: { version: 1 }, summary: header.summary,
    };
    await writeRuntime(runtime);
    return includeState ? { ...runtimeLookup(runtime, accountUid), state: partition.state } : runtime;
  }

  async function updateConversationBody(runtime, accountUid, updater, identities = null) {
    const metadata = runtimeLookup(runtime, accountUid);
    const body = await bodies.read(accountUid, identities);
    const partition = { ...metadata, state: body.state, summary: body.header.summary };
    const value = await updater(partition);
    const header = await bodies.commit(accountUid, partition.state, body, { partial: identities !== null });
    const { state, ...saved } = partition;
    saved.summary = header.summary;
    runtime.accounts[accountPartitionKey(accountUid)] = saved;
    await writeRuntime(runtime);
    const result = object(value) && Object.hasOwn(value, 'summary') ? { ...value, summary: header.summary } : value;
    return { accepted: true, value: clone(result),
      partition: identities === null ? { ...saved, state } : saved };
  }

  return {
    prepareAccountBody(accountUidValue) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(() => prepareBody(accountUid, { includeState: true }));
    },

    getRuntimeRoot() {
      return enqueue(() => readRuntime());
    },

    getRuntimeContext(accountUidValue, tabId) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(async () => {
        let root = await readRuntime();
        const key = accountPartitionKey(accountUid);
        if (!root.accounts[key]) {
          const body = await readRoot();
          await ensure(body, accountUid);
          await writeRoot(body);
          root = runtimeRoot(body);
        }
        return { partition: runtimeLookup(root, accountUid),
          binding: validTabId(tabId) ? root.tabBindings[String(tabId)] || null : null };
      });
    },

    updateRuntimeAccount(accountUidValue, updater) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(async () => {
        const root = await readRuntime();
        const partition = runtimeLookup(root, accountUid);
        if (!partition) throw new Error('ACCOUNT_PARTITION_CLEARED');
        const value = await updater(partition);
        await writeRuntime(root);
        return clone(value);
      });
    },

    updateBoundRuntime({ tabId, accountUid: accountUidValue, collectionToken }, updater) {
      const accountUid = uidOrThrow(accountUidValue);
      if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
      if (!validToken(collectionToken)) throw new Error('COLLECTION_TOKEN_INVALID');
      if (typeof updater !== 'function') throw new TypeError('ACCOUNT_UPDATER_REQUIRED');
      return enqueue(async () => {
        const root = await readRuntime();
        if (!matchesBinding(root.tabBindings[String(tabId)], { tabId, accountUid, collectionToken })) {
          return { accepted: false, reason: 'COLLECTION_TOKEN_REVOKED' };
        }
        const partition = runtimeLookup(root, accountUid);
        if (!partition) return { accepted: false, reason: 'ACCOUNT_PARTITION_CLEARED' };
        const value = await updater(partition);
        await writeRuntime(root);
        return { accepted: true, value: clone(value), partition };
      });
    },

    getOrCreateAccount(accountUidValue) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(() => completePartition(accountUid, true));
    },

    getAccount(accountUidValue) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(() => completePartition(accountUid));
    },

    getAccountContext(accountUidValue, tabId) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(async () => {
        const partition = await completePartition(accountUid, true);
        const root = await readRuntime();
        const binding = validTabId(tabId) ? root.tabBindings[String(tabId)] || null : null;
        return { partition, binding };
      });
    },

    updateAccount(accountUidValue, updater) {
      const accountUid = uidOrThrow(accountUidValue);
      if (typeof updater !== 'function') throw new TypeError('ACCOUNT_UPDATER_REQUIRED');
      return enqueue(async () => {
        const runtime = await readRuntime();
        if (runtimeLookup(runtime, accountUid)?.bodyStore) {
          return (await updateConversationBody(runtime, accountUid, updater)).value;
        }
        const root = await readRoot();
        const { partition } = await ensure(root, accountUid);
        const result = await updater(partition);
        root.accounts[accountPartitionKey(accountUid)] = normalizePartition(partition, accountUid);
        await writeRoot(root);
        return clone(result);
      });
    },

    setTabBinding(tabId, accountUidValue, collectionToken) {
      const accountUid = uidOrThrow(accountUidValue);
      if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
      if (!validToken(collectionToken)) throw new Error('COLLECTION_TOKEN_INVALID');
      return enqueue(async () => {
        const root = await prepareBody(accountUid);
        root.tabBindings[String(tabId)] = { accountUid, collectionToken };
        await writeRuntime(root);
        return { accountUid, collectionToken };
      });
    },

    getTabBinding(tabId) {
      if (!validTabId(tabId)) return Promise.resolve(null);
      return enqueue(async () => clone((await readRuntime()).tabBindings[String(tabId)] || null));
    },

    removeTabBinding(tabId, expected = null) {
      if (!validTabId(tabId)) return Promise.resolve(false);
      return enqueue(async () => {
        const root = await readRuntime();
        const current = root.tabBindings[String(tabId)];
        if (!current || (expected && !matchesBinding(current, { tabId, ...expected }))) return false;
        delete root.tabBindings[String(tabId)];
        await writeRuntime(root);
        return true;
      });
    },

    updateBoundAccount({ tabId, accountUid: accountUidValue, collectionToken }, updater) {
      const accountUid = uidOrThrow(accountUidValue);
      if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
      if (!validToken(collectionToken)) throw new Error('COLLECTION_TOKEN_INVALID');
      if (typeof updater !== 'function') throw new TypeError('ACCOUNT_UPDATER_REQUIRED');
      return enqueue(async () => {
        const runtime = await readRuntime();
        if (!matchesBinding(runtime.tabBindings[String(tabId)], { tabId, accountUid, collectionToken })) {
          return { accepted: false, reason: 'COLLECTION_TOKEN_REVOKED' };
        }
        if (runtimeLookup(runtime, accountUid)?.bodyStore) {
          return updateConversationBody(runtime, accountUid, updater);
        }
        const root = await readRoot();
        const binding = root.tabBindings[String(tabId)];
        if (!matchesBinding(binding, { tabId, accountUid, collectionToken })) {
          return { accepted: false, reason: 'COLLECTION_TOKEN_REVOKED' };
        }
        const partition = lookup(root, accountUid);
        // A revoked/cleared account must never be recreated by a late page message.
        if (!partition) return { accepted: false, reason: 'ACCOUNT_PARTITION_CLEARED' };
        const value = await updater(partition);
        root.accounts[accountPartitionKey(accountUid)] = normalizePartition(partition, accountUid);
        await writeRoot(root);
        return { accepted: true, value: clone(value), partition };
      });
    },

    updateBoundConversations({ tabId, accountUid: accountUidValue, collectionToken }, identities, updater) {
      // The model updater touches these identities only, using its existing
      // identity+MID message keys. Arbitrary state edits use the full-state API.
      const accountUid = uidOrThrow(accountUidValue);
      if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
      if (!validToken(collectionToken)) throw new Error('COLLECTION_TOKEN_INVALID');
      if (typeof updater !== 'function') throw new TypeError('ACCOUNT_UPDATER_REQUIRED');
      return enqueue(async () => {
        let root = await readRuntime();
        if (!matchesBinding(root.tabBindings[String(tabId)], { tabId, accountUid, collectionToken })) {
          return { accepted: false, reason: 'COLLECTION_TOKEN_REVOKED' };
        }
        if (!runtimeLookup(root, accountUid)) return { accepted: false, reason: 'ACCOUNT_PARTITION_CLEARED' };
        if (!runtimeLookup(root, accountUid).bodyStore) root = await prepareBody(accountUid);
        return updateConversationBody(root, accountUid, updater, [...new Set(identities)]);
      });
    },

    clearAccount(accountUidValue) {
      const accountUid = uidOrThrow(accountUidValue);
      return enqueue(async () => {
        const root = await readRuntime();
        const stored = await storageOperation('account.get', () => storage.get(ACCOUNT_STORE_KEY));
        const legacy = normalizeRoot(stored?.[ACCOUNT_STORE_KEY]);
        const key = accountPartitionKey(accountUid);
        const removed = Object.hasOwn(root.accounts, key) || Object.hasOwn(legacy.accounts, key);
        delete legacy.accounts[key];
        for (const [tabKey, binding] of Object.entries(legacy.tabBindings)) {
          if (binding?.accountUid === accountUid) delete legacy.tabBindings[tabKey];
        }
        await storageOperation('account.set', () => storage.set({ [ACCOUNT_STORE_KEY]: legacy }));
        await bodies.clear(accountUid);
        delete root.accounts[key];
        const invalidatedTabIds = [];
        for (const [tabKey, binding] of Object.entries(root.tabBindings)) {
          if (binding?.accountUid === accountUid) {
            const tabId = Number(tabKey);
            if (validTabId(tabId)) invalidatedTabIds.push(tabId);
            delete root.tabBindings[tabKey];
          }
        }
        await writeRuntime(root);
        return { accountUid, removed, invalidatedTabIds };
      });
    },
  };
}
