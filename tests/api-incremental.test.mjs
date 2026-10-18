import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiBulkCollector } from '../scripts/extension-api-bulk.mjs';

const key = id => JSON.stringify(['boss', String(id)]);
const legacyKey = name => JSON.stringify(['Company', name, 'Existing role']);
const friend = (id, updateTime = 100) => ({ encryptFriendId: id, brandName: 'Company', name: id,
  bossTitle: 'API role', updateTime });
const contact = (id, updateTime = 100) => ({ bossId: id, encryptBossId: id, company: 'Company',
  hrName: id, hrRole: 'Existing role', provisionalIdentityKey: legacyKey(id), rawFriend: friend(id, updateTime) });
const saved = (overrides = {}) => ({ kind: 'api_v1', apiRevision: 2, accountUid: 'account-A', runId: 'baseline-run',
  startedAt: '2026-10-13T00:00:00.000Z', status: 'completed', state: 'completed',
  contacts: [contact('A')], completedApiKeys: ['A'], observedApiMessageKeys: ['A\n1'], messageCount: 1,
  historyResults: { [legacyKey('A')]: { bossId: 'A', availableHistoryComplete: true, messageCount: 1 } },
  ...overrides });

async function run({ previous, friends, ids = {}, accountUid = 'account-A',
  listParams = { labelId: '0', encryptSystemId: 'demo-system' },
  stored = { profiles: { main: { contacts: { a: { identity: contact('A') } } } } } }) {
  const requests = [], snapshots = [], existing = new Set(['A\n1']);
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const collector = createApiBulkCollector({ accountUid, collectionToken: 'synthetic-collection-token',
    listParams, origin: 'https://www.zhipin.com',
    document: { visibilityState: 'hidden', hasFocus: () => false },
    storedContacts: stored,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, zpData: { friendList: friends } }) }),
    readHistory: async ({ bossId, onPage }) => {
      requests.push(bossId);
      const messages = (ids[bossId] || ['1']).map(messageId => ({ messageId, direction: 'hr', contentText: messageId }));
      await onPage({ page: { number: 1 }, messages, historyCoverage: { availableHistoryComplete: true },
        snapshot: { page: {} } });
      return { availableHistoryComplete: true, completeReason: 'api_has_more_false',
        messages, pages: [{ number: 1, hasMore: false, messageCount: messages.length }] };
    },
    send: async message => {
      if (message.type === 'BULK_SNAPSHOTS') {
        snapshots.push(...message.snapshots);
        let newMessageCount = 0;
        for (const snapshot of message.snapshots) for (const item of snapshot.messages.items) {
          const id = `${snapshot.bossId}\n${item.messageId}`;
          if (!existing.has(id)) { existing.add(id); newMessageCount++; }
        }
        return { ok: true, newMessageCount };
      }
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) resolveFinished(message.progress);
      return { ok: true };
    },
  });
  const started = collector.start(previous);
  return { started, progress: await finished, requests, snapshots };
}

test('completed baseline becomes a new incremental run and unchanged native updateTime needs no history requests', async () => {
  const { started, progress, requests } = await run({ previous: saved(), friends: [friend('A', '100')] });
  assert.equal(started.runMode, 'incremental');
  assert.notEqual(started.runId, 'baseline-run');
  assert.notEqual(started.startedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(progress.status, 'completed');
  assert.equal(progress.availableRecordsComplete, true);
  assert.equal(progress.scannedCount, 1);
  assert.equal(progress.coveredCount, 1);
  assert.equal(progress.selectedCount, 0);
  assert.equal(progress.skippedUnchangedCount, 1);
  assert.equal(progress.messageCount, 0);
  assert.equal(progress.newMessageCount, 0);
  assert.deepEqual(requests, []);
  assert.equal(progress.contacts[0].hrRole, 'Existing role');
  assert.equal(progress.contacts[0].provisionalIdentityKey, key('A'));
  assert.equal(progress.historyResults[key('A')].availableHistoryComplete, true);
});

test('new contact is selected while previous available history retains coverage', async () => {
  const { progress, requests } = await run({ previous: saved(), friends: [friend('A'), friend('B')], ids: { B: ['8'] } });
  assert.deepEqual(requests, ['B']);
  assert.equal(progress.selectedCount, 1);
  assert.equal(progress.skippedUnchangedCount, 1);
  assert.equal(progress.refreshedCount, 1);
  assert.equal(progress.coveredCount, 2);
  assert.equal(progress.newMessageCount, 1);
  assert.equal(progress.historyResults[key('A')].availableHistoryComplete, true);
});

test('changed native updateTime refreshes full currently available pages and counts only stored new IDs', async () => {
  const { progress, requests, snapshots } = await run({ previous: saved(), friends: [friend('A', 101)], ids: { A: ['1', '2'] } });
  assert.deepEqual(requests, ['A']);
  assert.equal(progress.selectedCount, 1);
  assert.equal(progress.refreshedCount, 1);
  assert.equal(progress.messageCount, 2);
  assert.equal(progress.newMessageCount, 1);
  assert.equal(progress.historyResults[key('A')].friendUpdateTime, 101);
  assert.equal(progress.historyResults[key('A')].availableHistoryComplete, true);
  assert.equal(snapshots[0].bulkRunMode, 'incremental');
  assert.equal(snapshots[0].list.rows[0].rawFriend.updateTime, 101);
});

test('unfinished failed contact resumes the same run and is retried even when metadata is unchanged', async () => {
  const previous = saved({ status: 'interrupted', state: 'interrupted', completedApiKeys: [],
    runMode: 'incremental', selectedApiKeys: ['A'], newMessageCount: 2, observedApiMessageKeys: [],
    historyResults: { [legacyKey('A')]: { bossId: 'A', availableHistoryComplete: false, error: { code: 'request_failed' } } } });
  const { started, progress, requests } = await run({ previous, friends: [friend('A')], ids: { A: ['1', '2'] } });
  assert.equal(started.runId, 'baseline-run');
  assert.equal(started.startedAt, previous.startedAt);
  assert.equal(started.resumed, true);
  assert.deepEqual(requests, ['A']);
  assert.equal(progress.status, 'completed');
  assert.equal(progress.failed, 0);
  assert.equal(progress.newMessageCount, 3);
});

test('same-name native accounts use different stable keys without borrowing another known account role', async () => {
  const first = { ...friend('encrypted-demo-1'), friendId: 50101, brandName: 'Demo Systems', name: 'Chen HR' };
  const second = { ...friend('encrypted-demo-2'), friendId: 50102, brandName: 'Demo Systems', name: 'Chen HR' };
  const oldTuple = JSON.stringify(['Demo Systems', 'Chen HR', 'Recruiter']);
  const stored = { contacts: { [oldTuple]: { identity: {
    uid: '50101', bossId: 'encrypted-demo-1', company: 'Demo Systems', hrName: 'Chen HR',
    hrRole: 'Recruiter', provisionalIdentityKey: oldTuple,
  } } } };
  const { progress, requests, snapshots } = await run({ previous: null, friends: [first, second], stored });
  assert.deepEqual(requests, ['encrypted-demo-1', 'encrypted-demo-2']);
  assert.deepEqual(progress.contacts.map(row => row.provisionalIdentityKey), [key(50101), key(50102)]);
  assert.equal(progress.contacts[0].hrRole, 'Recruiter');
  assert.equal(progress.contacts[1].hrRole, 'API role');
  assert.deepEqual(snapshots.map(row => row.list.rows[0].provisionalIdentityKey), [key(50101), key(50102)]);
  assert.equal(progress.completedKeys.length, 2);
});

test('unowned or different-account previous state is not reused as a baseline', async () => {
  const priorA = saved();
  const { started, progress, requests } = await run({ previous: priorA, accountUid: 'account-B',
    friends: [friend('A', '100')] });
  assert.equal(started.accountUid, 'account-B');
  assert.equal(started.runMode, 'baseline');
  assert.equal(progress.resumed, false);
  assert.deepEqual(requests, ['A']);
  assert.equal(progress.historyResults[key('A')].availableHistoryComplete, true);
});
