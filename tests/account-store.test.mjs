import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_STORE_KEY,
  ACCOUNT_RUNTIME_KEY,
  accountPartitionKey,
  createAccountStore,
  createAccountPartition,
  normalizeAccountUid,
} from '../extension-tracker/account-store.mjs';

function makeStorage(seed = {}) {
  const values = structuredClone(seed);
  const reads = [];
  const writes = [];
  const local = {
    async get(key) {
      reads.push(key);
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
      const result = {};
      for (const item of key || []) if (Object.hasOwn(values, item)) result[item] = structuredClone(values[item]);
      return result;
    },
    async set(record) {
      writes.push(Object.keys(record));
      await new Promise(resolve => setTimeout(resolve, 1));
      for (const [key, value] of Object.entries(record)) values[key] = structuredClone(value);
    },
  };
  return { local, values, reads, writes };
}

test('UID partitions keep same HR identity, MID, runtime progress, and baseline separate', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  const sameIdentity = '["boss","shared-hr"]';

  await Promise.all(['accountA', 'accountB'].map(accountUid => store.updateAccount(accountUid, partition => {
    partition.state.contacts[sameIdentity] = { identity: { bossId: 'shared-hr' }, note: accountUid };
    partition.state.messages['message:"shared-mid"'] = {
      messageId: 'shared-mid', identityKey: sameIdentity, contentText: accountUid,
    };
    partition.runtime.progressByTab[accountUid === 'accountA' ? '1' : '2'] = {
      kind: 'api_v1', runId: `run-${accountUid}`, status: 'completed',
    };
    partition.baseline.previousProgress = { runId: `baseline-${accountUid}`, contacts: [{ uid: accountUid }] };
  })));

  const [a, b] = await Promise.all([store.getAccount('accountA'), store.getAccount('accountB')]);
  assert.equal(a.state.contacts[sameIdentity].note, 'accountA');
  assert.equal(b.state.contacts[sameIdentity].note, 'accountB');
  assert.equal(a.state.messages['message:"shared-mid"'].contentText, 'accountA');
  assert.equal(b.state.messages['message:"shared-mid"'].contentText, 'accountB');
  assert.equal(a.runtime.progressByTab['1'].runId, 'run-accountA');
  assert.equal(b.runtime.progressByTab['2'].runId, 'run-accountB');
  assert.equal(a.baseline.previousProgress.runId, 'baseline-accountA');
  assert.equal(b.baseline.previousProgress.runId, 'baseline-accountB');
  assert.notEqual(accountPartitionKey('accountA'), accountPartitionKey('accountB'));
});

test('storage transactions serialize concurrent updates without losing either account', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  const work = [];
  for (let index = 0; index < 12; index++) {
    const accountUid = index % 2 ? 'accountA' : 'accountB';
    work.push(store.updateAccount(accountUid, partition => {
      partition.runtime.updateCount = (partition.runtime.updateCount || 0) + 1;
    }));
  }
  await Promise.all(work);
  assert.equal((await store.getAccount('accountA')).runtime.updateCount, 6);
  assert.equal((await store.getAccount('accountB')).runtime.updateCount, 6);
});

test('worker restart can verify persisted tab bindings and account clear revokes every matching tab', async () => {
  const storage = makeStorage();
  const first = createAccountStore({ storage: { local: storage.local } });
  await first.getOrCreateAccount('accountA');
  await first.getOrCreateAccount('accountB');
  await first.setTabBinding(10, 'accountA', 'token-account-a-0001');
  await first.setTabBinding(11, 'accountA', 'token-account-a-0002');
  await first.setTabBinding(12, 'accountB', 'token-account-b-0001');

  const afterRestart = createAccountStore({ storage: { local: storage.local } });
  assert.deepEqual(await afterRestart.getTabBinding(10), {
    accountUid: 'accountA', collectionToken: 'token-account-a-0001',
  });
  const resumed = await afterRestart.updateBoundAccount({ tabId: 10, accountUid: 'accountA',
    collectionToken: 'token-account-a-0001' }, partition => {
    partition.runtime.progressByTab['10'] = { runId: 'resumed-after-restart', status: 'running' };
    return partition.runtime.progressByTab['10'];
  });
  assert.equal(resumed.accepted, true);

  const cleared = await afterRestart.clearAccount('accountA');
  assert.equal(cleared.removed, true);
  assert.deepEqual(cleared.invalidatedTabIds.sort((a, b) => a - b), [10, 11]);
  assert.equal(await afterRestart.getAccount('accountA'), null);
  assert.equal((await afterRestart.getAccount('accountB')).accountUid, 'accountB');
  assert.equal(await afterRestart.getTabBinding(10), null);
  const stale = await afterRestart.updateBoundAccount({ tabId: 10, accountUid: 'accountA',
    collectionToken: 'token-account-a-0001' }, partition => { partition.state.contacts.injected = {}; });
  assert.deepEqual(stale, { accepted: false, reason: 'COLLECTION_TOKEN_REVOKED' });
  assert.equal(await afterRestart.getAccount('accountA'), null);
});

test('unsafe or unknown UIDs fail closed and legacy v2 data is left untouched', async () => {
  const legacyState = { schemaVersion: 2, contacts: { private: { name: 'legacy' } } };
  const storage = makeStorage({ 'bossReadonlyTracker.v2': legacyState });
  const store = createAccountStore({ storage: { local: storage.local } });
  assert.equal(normalizeAccountUid(null), null);
  assert.equal(normalizeAccountUid(0), null);
  assert.equal(normalizeAccountUid('0'), null);
  assert.equal(normalizeAccountUid('00'), null);
  assert.equal(normalizeAccountUid('unsafe uid'), null);
  assert.equal(normalizeAccountUid(' user_123 '), null);
  assert.equal(normalizeAccountUid('demo-user-1'), 'demo-user-1');

  const fresh = await store.getOrCreateAccount('new-account');
  assert.deepEqual(fresh.state.contacts, {});
  assert.equal(Object.hasOwn(storage.values, ACCOUNT_STORE_KEY), true);
  assert.deepEqual(storage.values['bossReadonlyTracker.v2'], legacyState);
  assert.equal(storage.reads.some(key => key === 'bossReadonlyTracker.v2' ||
    (Array.isArray(key) && key.includes('bossReadonlyTracker.v2'))), false);
  assert.throws(() => store.getOrCreateAccount(''), /ACCOUNT_IDENTITY_UNAVAILABLE/);
});

test('returned accounts remain independent of storage and subsequent reads', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  const created = await store.getOrCreateAccount('accountA');
  created.state.contacts.unsaved = { note: 'caller only' };
  created.runtime.logs.push({ event: 'caller only' });
  created.baseline.previousProgress = { runId: 'caller only' };
  const first = await store.getAccount('accountA');
  assert.deepEqual(first.state.contacts, {});
  assert.deepEqual(first.runtime.logs, []);
  assert.equal(first.baseline.previousProgress, null);
  first.state.messages.unsaved = { messageId: 'not persisted' };
  first.runtime.progressByTab['1'] = { status: 'caller only' };
  first.baseline.previousProgress = { runId: 'not persisted' };
  const second = await store.getOrCreateAccount('accountA');
  assert.deepEqual(second.state.messages, {});
  assert.deepEqual(second.runtime.progressByTab, {});
  assert.equal(second.baseline.previousProgress, null);
  assert.deepEqual(storage.values[ACCOUNT_STORE_KEY].accounts[accountPartitionKey('accountA')].state.messages, {});
});

test('getAccountContext reads the account and tab binding once without rewriting an existing partition', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  await store.setTabBinding(7, 'accountA', 'token-account-a-context');
  const readsBefore = storage.reads.length, writesBefore = storage.writes.length;
  const context = await store.getAccountContext('accountA', 7);
  assert.equal(storage.reads.slice(readsBefore).includes(ACCOUNT_STORE_KEY), false);
  assert.equal(storage.writes.length, writesBefore);
  assert.equal(context.partition.accountUid, 'accountA');
  assert.deepEqual(context.binding, { accountUid: 'accountA', collectionToken: 'token-account-a-context' });
  context.partition.runtime.logs.push({ event: 'not persisted' });
  context.binding.collectionToken = 'caller mutation';
  const fresh = await store.getAccountContext('accountA', 7);
  assert.deepEqual(fresh.partition.runtime.logs, []);
  assert.equal(fresh.binding.collectionToken, 'token-account-a-context');
});

test('getAccountContext creates only the requested account and preserves a different account binding', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  await store.setTabBinding(7, 'accountA', 'token-account-a-context');
  const readsBefore = storage.reads.length, writesBefore = storage.writes.length;
  const context = await store.getAccountContext('accountB', 7);
  assert.equal(storage.reads.slice(readsBefore).filter(key => key === ACCOUNT_STORE_KEY).length, 1);
  assert.deepEqual(storage.writes.slice(writesBefore), [[ACCOUNT_STORE_KEY], [ACCOUNT_RUNTIME_KEY]]);
  assert.equal(context.partition.accountUid, 'accountB');
  assert.equal(context.binding.accountUid, 'accountA');
  assert.deepEqual(context.partition.state.contacts, {});
  assert.equal((await store.getAccount('accountA')).accountUid, 'accountA');
  const unbound = await store.getAccountContext('accountB', undefined);
  assert.equal(unbound.binding, null);
});

test('a bound update returns the submitted partition while storage and its result value remain independent', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  await store.setTabBinding(7, 'accountA', 'token-account-a-context');
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'token-account-a-context' };
  let updaterValue;
  const result = await store.updateBoundAccount(scope, partition => {
    partition.runtime.progressByTab['7'] = { status: 'completed', pageCount: 2 };
    partition.baseline.previousProgress = { runId: 'submitted-run' };
    updaterValue = partition.runtime.progressByTab['7'];
    return updaterValue;
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.value, { status: 'completed', pageCount: 2 });
  assert.equal(result.partition.runtime.progressByTab['7'].status, 'completed');
  assert.equal(result.partition.baseline.previousProgress.runId, 'submitted-run');
  updaterValue.pageCount = 99;
  assert.equal(result.value.pageCount, 2);
  result.value.status = 'caller only';
  result.partition.runtime.progressByTab['7'].status = 'caller only';
  result.partition.baseline.previousProgress.runId = 'caller only';
  const stored = await store.getAccount('accountA');
  assert.equal(stored.runtime.progressByTab['7'].pageCount, 2);
  assert.equal(stored.runtime.progressByTab['7'].status, 'completed');
  assert.equal(stored.baseline.previousProgress.runId, 'submitted-run');
});

test('runtime updates and worker restart do not touch an existing 17 MiB chat body', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  await store.updateAccount('accountA', partition => {
    partition.state.contacts.hr = { note: 'synthetic' };
    partition.state.messages.mid = { messageId: 'mid' };
    partition.state.rawSources.hr = { fixture: 'x'.repeat(17 * 1024 * 1024) };
  });
  await store.setTabBinding(7, 'accountA', 'token-account-a-runtime');
  const bodyBefore = storage.values[ACCOUNT_STORE_KEY];
  const originalGet = storage.local.get, originalSet = storage.local.set;
  storage.local.get = async key => {
    assert.notEqual(key, ACCOUNT_STORE_KEY, 'runtime operations must never request the body');
    return originalGet(key);
  };
  storage.local.set = async values => {
    assert.equal(Object.hasOwn(values, ACCOUNT_STORE_KEY), false, 'runtime operations must never rewrite the body');
    return originalSet(values);
  };
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'token-account-a-runtime' };
  const result = await store.updateBoundRuntime(scope, partition => {
    partition.runtime.progressByTab['7'] = { status: 'running', completed: 1 };
    return partition.runtime.progressByTab['7'];
  });
  assert.equal(result.accepted, true);
  assert.equal(result.partition.summary.contactCount, 1);
  assert.equal(result.partition.summary.messageCount, 1);
  assert.equal(Object.hasOwn(result.partition, 'state'), false);
  assert.ok(JSON.stringify(storage.values[ACCOUNT_RUNTIME_KEY]).length < 5000);
  const restarted = createAccountStore({ storage: { local: storage.local } });
  const context = await restarted.getRuntimeContext('accountA', 7);
  assert.equal(context.partition.runtime.progressByTab['7'].completed, 1);
  assert.equal(context.binding.collectionToken, scope.collectionToken);
  assert.equal(storage.values[ACCOUNT_STORE_KEY], bodyBefore);
});

test('runtime initialization preserves legacy bodies and revoked bindings never return from legacy metadata', async () => {
  const partition = createAccountPartition('accountA');
  partition.state.messages.mid = { messageId: 'mid', contentText: 'synthetic body' };
  partition.runtime.progressByTab['7'] = { status: 'running' };
  const legacy = { schemaVersion: 1, accounts: { 'account:accountA': partition },
    tabBindings: { '7': { accountUid: 'accountA', collectionToken: 'legacy-runtime-token' } } };
  const storage = makeStorage({ [ACCOUNT_STORE_KEY]: legacy });
  const store = createAccountStore({ storage: { local: storage.local } });
  const context = await store.getRuntimeContext('accountA', 7);
  assert.equal(context.partition.summary.messageCount, 1);
  assert.deepEqual(storage.values[ACCOUNT_STORE_KEY], legacy);
  assert.equal(await store.removeTabBinding(7, context.binding), true);
  assert.deepEqual(storage.values[ACCOUNT_STORE_KEY], legacy, 'the old body is preserved, including stale legacy bindings');
  const restarted = createAccountStore({ storage: { local: storage.local } });
  assert.equal(await restarted.getTabBinding(7), null);
  const late = await restarted.updateBoundRuntime({ tabId: 7, accountUid: 'accountA',
    collectionToken: 'legacy-runtime-token' }, () => { throw new Error('must not run'); });
  assert.equal(late.reason, 'COLLECTION_TOKEN_REVOKED');
  assert.equal((await restarted.getAccount('accountA')).state.messages.mid.contentText, 'synthetic body');
});

test('body commit precedes runtime summary and a failed runtime publish is safe to retry', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'token-body-before-summary' };
  await store.setTabBinding(7, scope.accountUid, scope.collectionToken);
  const originalSet = storage.local.set;
  let failPublish = true;
  storage.local.set = async values => {
    if (failPublish && Object.hasOwn(values, ACCOUNT_RUNTIME_KEY)) throw new Error('SYNTHETIC_RUNTIME_PUBLISH_FAILURE');
    return originalSet(values);
  };
  const merge = partition => {
    const inserted = !partition.state.messages.mid;
    partition.state.messages.mid = { messageId: 'mid', contentText: 'preserved after late failure' };
    return { newMessageCount: inserted ? 1 : 0 };
  };
  await assert.rejects(store.updateBoundAccount(scope, merge), /SYNTHETIC_RUNTIME_PUBLISH_FAILURE/);
  assert.equal((await store.getAccount('accountA')).state.messages.mid.messageId, 'mid');
  assert.deepEqual(storage.values[ACCOUNT_STORE_KEY].accounts['account:accountA'].state.messages, {},
    'the original body remains the pre-sharding copy');
  assert.equal((await store.getRuntimeContext('accountA', 7)).partition.summary.messageCount, 0);
  failPublish = false;
  const retry = await store.updateBoundAccount(scope, merge);
  assert.equal(retry.value.newMessageCount, 0);
  assert.equal((await store.getRuntimeContext('accountA', 7)).partition.summary.messageCount, 1);
  assert.equal(Object.keys((await store.getAccount('accountA')).state.messages).length, 1);
});

test('a new account body survives its first failed runtime publish and later writes by another account', async () => {
  const storage = makeStorage();
  const store = createAccountStore({ storage: { local: storage.local } });
  await store.getRuntimeRoot();
  const originalSet = storage.local.set;
  let failPublish = true;
  storage.local.set = async values => {
    if (failPublish && Object.hasOwn(values, ACCOUNT_RUNTIME_KEY)) throw new Error('SYNTHETIC_FIRST_PUBLISH_FAILURE');
    return originalSet(values);
  };
  await assert.rejects(store.updateAccount('newAccount', partition => {
    partition.state.messages.mid = { messageId: 'mid', contentText: 'must survive' };
    partition.runtime.progressByTab['7'] = { status: 'completed', runId: 'must-not-revive' };
    partition.baseline.previousProgress = { runId: 'must-not-revive' };
  }), /SYNTHETIC_FIRST_PUBLISH_FAILURE/);
  const preserved = await store.getAccount('newAccount');
  assert.equal(preserved.state.messages.mid.contentText, 'must survive');
  assert.deepEqual(preserved.runtime.progressByTab, {});
  assert.equal(preserved.baseline.previousProgress, null);
  failPublish = false;
  await store.updateAccount('otherAccount', partition => { partition.state.contacts.other = {}; });
  assert.equal((await store.getAccount('newAccount')).state.messages.mid.contentText, 'must survive');
  assert.equal((await store.getRuntimeContext('newAccount', 7)).partition.summary.messageCount, 1);
  assert.equal(await store.getTabBinding(7), null);
});
