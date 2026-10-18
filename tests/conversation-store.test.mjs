import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStore, ACCOUNT_STORE_KEY, ACCOUNT_RUNTIME_KEY } from '../extension-tracker/account-store.mjs';
import { conversationHeaderKey, CONVERSATION_BODY_PREFIX } from '../extension-tracker/conversation-store.mjs';
import { mergeSnapshot, canonicalIdentityKey } from '../extension-tracker/model.mjs';

function fixture() {
  const values = {}, reads = [], writes = [];
  const local = {
    async get(key) {
      reads.push(key);
      const names = typeof key === 'string' ? [key] : key || [];
      return Object.fromEntries(names.filter(name => Object.hasOwn(values, name))
        .map(name => [name, structuredClone(values[name])]));
    },
    async set(record) {
      writes.push(structuredClone(record));
      Object.assign(values, structuredClone(record));
    },
  };
  const chromeApi = { storage: { local } };
  return { values, reads, writes, local, chromeApi, store: createAccountStore(chromeApi) };
}

test('a selected conversation update never reads or writes the large legacy body or unrelated conversation', async () => {
  const f = fixture();
  await f.store.updateAccount('accountA', partition => {
    partition.state.contacts.a = { originConfidence: 'confirmed' };
    partition.state.contacts.b = {};
    partition.state.messages.a = { identityKey: 'a', messageId: 'shared' };
    partition.state.messages.b = { identityKey: 'b', messageId: 'shared' };
    partition.state.rawSources.b = { syntheticLargeSource: 'x'.repeat(22 * 1024 * 1024) };
  });
  const original = structuredClone(f.values[ACCOUNT_STORE_KEY]);
  await f.store.setTabBinding(7, 'accountA', 'account-a-shard-token');
  assert.deepEqual(f.values[ACCOUNT_STORE_KEY], original);
  const refs = f.values[conversationHeaderKey('accountA')].refs;
  const otherVersion = refs.b;
  f.reads.length = f.writes.length = 0;
  const update = await f.store.updateBoundConversations({ tabId: 7, accountUid: 'accountA',
    collectionToken: 'account-a-shard-token' }, ['a'], partition => {
    assert.deepEqual(Object.keys(partition.state.contacts), ['a']);
    partition.state.messages.new = { identityKey: 'a', messageId: 'new' };
    return { summary: { messageCount: -1 } };
  });
  assert.equal(update.accepted, true);
  assert.equal(update.value.summary.contactCount, 2);
  assert.equal(update.value.summary.messageCount, 3);
  assert.equal(update.value.summary.originConfirmedCount, 1);
  assert.equal(Object.hasOwn(update.partition, 'state'), false);
  assert.equal(f.reads.some(key => key === ACCOUNT_STORE_KEY), false);
  assert.equal(JSON.stringify(f.reads).includes(otherVersion), false);
  assert.equal(f.writes.some(record => Object.hasOwn(record, ACCOUNT_STORE_KEY)), false);
  assert.ok(Math.max(...f.writes.map(record => JSON.stringify(record).length)) < 10000);
  assert.equal(f.values[conversationHeaderKey('accountA')].refs.b, otherVersion);
  const restarted = createAccountStore(f.chromeApi);
  const full = await restarted.getAccount('accountA');
  assert.equal(Object.keys(full.state.messages).length, 3);
  assert.equal(full.state.rawSources.b.syntheticLargeSource.length, 22 * 1024 * 1024);
});

test('failed header commit keeps the previous version readable and retry adds the message once', async () => {
  const f = fixture();
  await f.store.setTabBinding(7, 'accountA', 'account-a-shard-token');
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'account-a-shard-token' };
  const originalSet = f.local.set;
  const oldHeader = structuredClone(f.values[conversationHeaderKey('accountA')]);
  f.local.set = async values => {
    if (Object.hasOwn(values, conversationHeaderKey('accountA'))) throw new Error('SYNTHETIC_HEADER_FAILURE');
    return originalSet(values);
  };
  const merge = partition => {
    const inserted = !partition.state.messages.mid;
    partition.state.contacts.a = {};
    partition.state.messages.mid = { identityKey: 'a', messageId: 'mid' };
    return { newMessageCount: inserted ? 1 : 0, summary: {} };
  };
  await assert.rejects(f.store.updateBoundConversations(scope, ['a'], merge), /SYNTHETIC_HEADER_FAILURE/);
  assert.deepEqual(f.values[conversationHeaderKey('accountA')], oldHeader);
  assert.deepEqual((await f.store.getAccount('accountA')).state.messages, {});
  f.local.set = originalSet;
  const retry = await f.store.updateBoundConversations(scope, ['a'], merge);
  assert.equal(retry.value.newMessageCount, 1);
  assert.equal(retry.value.summary.messageCount, 1);
  assert.equal(Object.keys((await f.store.getAccount('accountA')).state.messages).length, 1);
});

test('same IDs across UIDs stay isolated and clearing one UID also clears unpublished versions', async () => {
  const f = fixture();
  for (const uid of ['1', '10']) {
    await f.store.setTabBinding(Number(uid), uid, `shard-token-account-${uid}`);
    await f.store.updateBoundConversations({ tabId: Number(uid), accountUid: uid,
      collectionToken: `shard-token-account-${uid}` }, ['same'], partition => {
      partition.state.contacts.same = { note: uid };
      partition.state.messages.mid = { identityKey: 'same', messageId: 'mid', contentText: uid };
      return { summary: {} };
    });
  }
  const header = conversationHeaderKey('1');
  const originalSet = f.local.set;
  f.local.set = async values => {
    if (Object.hasOwn(values, header)) throw new Error('SYNTHETIC_ORPHAN');
    return originalSet(values);
  };
  await assert.rejects(f.store.updateBoundConversations({ tabId: 1, accountUid: '1',
    collectionToken: 'shard-token-account-1' }, ['same'], partition => {
    partition.state.messages.extra = { identityKey: 'same', messageId: 'extra' };
  }), /SYNTHETIC_ORPHAN/);
  f.local.set = originalSet;
  await f.store.clearAccount('1');
  assert.equal(await f.store.getAccount('1'), null);
  assert.equal(await f.store.getTabBinding(1), null);
  for (const [key, value] of Object.entries(f.values)) {
    if (key.startsWith(`${CONVERSATION_BODY_PREFIX}1:`)) assert.equal(value, null);
  }
  const other = await createAccountStore(f.chromeApi).getAccount('10');
  assert.equal(other.state.messages.mid.contentText, '10');
  assert.equal(other.state.contacts.same.note, '10');
});

test('an activated header is authoritative and a missing header never falls back to the preserved legacy body', async () => {
  const f = fixture();
  await f.store.updateAccount('accountA', partition => { partition.state.contacts.old = {}; });
  await f.store.setTabBinding(7, 'accountA', 'account-a-shard-token');
  assert.equal(f.values[ACCOUNT_RUNTIME_KEY].accounts['account:accountA'].bodyStore.version, 1);
  delete f.values[conversationHeaderKey('accountA')];
  await assert.rejects(f.store.getAccount('accountA'), /CONVERSATION_BODY_INVALID/);
  assert.equal(Object.hasOwn(f.values[ACCOUNT_STORE_KEY].accounts['account:accountA'].state.contacts, 'old'), true);
});

test('partial retry takes global counts from the committed header when runtime publication failed', async () => {
  const f = fixture();
  await f.store.updateAccount('accountA', partition => {
    for (const id of ['a', 'b']) {
      partition.state.contacts[id] = {};
      partition.state.messages[id] = { identityKey: id, messageId: id };
    }
  });
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'account-a-shard-token' };
  await f.store.setTabBinding(scope.tabId, scope.accountUid, scope.collectionToken);
  const originalSet = f.local.set;
  let failRuntime = true;
  f.local.set = async values => {
    if (failRuntime && Object.hasOwn(values, ACCOUNT_RUNTIME_KEY)) throw new Error('SYNTHETIC_LATE_RUNTIME_FAILURE');
    return originalSet(values);
  };
  const merge = partition => {
    const inserted = !partition.state.messages.new;
    partition.state.messages.new = { identityKey: 'a', messageId: 'new' };
    return { newMessageCount: inserted ? 1 : 0, summary: {} };
  };
  await assert.rejects(f.store.updateBoundConversations(scope, ['a'], merge), /SYNTHETIC_LATE_RUNTIME_FAILURE/);
  assert.equal((await f.store.getRuntimeContext('accountA', 7)).partition.summary.messageCount, 2);
  assert.equal(Object.keys((await f.store.getAccount('accountA')).state.messages).length, 3);
  failRuntime = false;
  const retry = await f.store.updateBoundConversations(scope, ['a'], merge);
  assert.equal(retry.value.newMessageCount, 0);
  assert.equal(retry.value.summary.contactCount, 2);
  assert.equal(retry.value.summary.messageCount, 3);
});

test('failed initial preparation preserves the legacy account and only enables shards after a successful retry', async () => {
  const f = fixture();
  await f.store.updateAccount('accountA', partition => {
    partition.state.contacts.a = {};
    partition.state.messages.mid = { identityKey: 'a', messageId: 'mid' };
    partition.state.futureField = { keep: ['original'] };
  });
  const original = structuredClone(f.values[ACCOUNT_STORE_KEY]);
  const originalSet = f.local.set;
  f.local.set = async values => {
    if (Object.hasOwn(values, conversationHeaderKey('accountA'))) throw new Error('SYNTHETIC_PREPARATION_FAILURE');
    return originalSet(values);
  };
  await assert.rejects(f.store.prepareAccountBody('accountA'), /SYNTHETIC_PREPARATION_FAILURE/);
  assert.deepEqual(f.values[ACCOUNT_STORE_KEY], original);
  assert.equal(f.values[ACCOUNT_RUNTIME_KEY].accounts['account:accountA'].bodyStore, undefined);
  assert.equal((await f.store.getAccount('accountA')).state.messages.mid.messageId, 'mid');
  f.local.set = originalSet;
  await f.store.prepareAccountBody('accountA');
  assert.equal(f.values[ACCOUNT_RUNTIME_KEY].accounts['account:accountA'].bodyStore.version, 1);
  assert.deepEqual((await f.store.getAccount('accountA')).state,
    original.accounts['account:accountA'].state);
});

test('real snapshot merging keeps identical MIDs in different conversations separate within one account', async () => {
  const f = fixture();
  const scope = { tabId: 7, accountUid: 'accountA', collectionToken: 'account-a-shard-token' };
  await f.store.setTabBinding(scope.tabId, scope.accountUid, scope.collectionToken);
  for (const bossId of ['hrA', 'hrB', 'hrA']) {
    const row = { bossId, active: true, hrName: bossId };
    const identity = canonicalIdentityKey(row);
    const result = await f.store.updateBoundConversations(scope, [identity], partition => {
      const merged = mergeSnapshot(partition.state, {
        status: 'readable_chat_dom', captureMode: 'bulk_history',
        page: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat',
          capturedAt: new Date().toISOString() },
        list: { rows: [row] }, messages: { items: [{ messageId: 'same-mid', text: bossId, direction: 'hr' }] },
      }, { copyState: false });
      partition.state = merged.state;
      return { newMessageCount: merged.newMessageCount, summary: merged.summary };
    });
    assert.equal(result.accepted, true);
  }
  const full = await f.store.getAccount('accountA');
  assert.equal(full.summary.contactCount, 2);
  assert.equal(full.summary.messageCount, 2);
  assert.equal(Object.keys(full.state.messages).length, 2);
  assert.deepEqual(Object.values(full.state.messages).map(message => message.text).sort(), ['hrA', 'hrB']);
});
