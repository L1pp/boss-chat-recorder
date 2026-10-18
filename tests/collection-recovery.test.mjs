import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiBulkCollector } from '../scripts/extension-api-bulk.mjs';
import { readAvailableConversationHistory } from '../scripts/history-api-reader.mjs';

const key = id => JSON.stringify(['boss', `peer-${id}`]);
const friend = (id, updateTime = 100) => ({ encryptFriendId: `enc-${id}`, friendId: `peer-${id}`,
  brandName: 'Demo Studio', name: `Synthetic HR ${id}`, bossTitle: 'Recruiter', updateTime });
const savedContact = id => ({ uid: `peer-${id}`, bossId: `enc-${id}`, encryptBossId: `enc-${id}`,
  company: 'Demo Studio', hrName: `Synthetic HR ${id}`, hrRole: 'Recruiter',
  provisionalIdentityKey: key(id), rawFriend: friend(id) });
const listPayload = friends => ({ code: 0, zpData: { friendList: friends } });
const jsonResponse = payload => ({ ok: true, status: 200,
  headers: { get: () => 'application/json' }, json: async () => payload });

function startCollector({ previous = null, friends = [], fetchImpl, readHistory, storageTimeoutMs = 100,
  requestTimeoutMs = 100, sendOverride } = {}) {
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const sent = [], snapshots = [];
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'recovery-token',
    previous, listParams: { labelId: '0', encryptSystemId: 'synthetic' },
    origin: 'https://www.zhipin.com',
    fetchImpl: fetchImpl || (async () => jsonResponse(listPayload(friends))),
    readHistory: readHistory || (async () => ({ availableHistoryComplete: true, messages: [], pages: [] })),
    requestTimeoutMs, storageTimeoutMs,
    send: (message, options) => {
      sent.push(message);
      if (message.type === 'BULK_SNAPSHOTS') snapshots.push(...message.snapshots);
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return sendOverride ? sendOverride(message, options) : { ok: true };
    },
  });
  const started = collector.start(previous);
  return { started, finished, sent, snapshots, collector };
}

function interruptedBaseline() {
  const contacts = Array.from({ length: 10 }, (_, index) => savedContact(index));
  return { kind: 'api_v1', apiRevision: 5, accountUid: 'account-A', collectionToken: 'previous-token',
    runId: 'baseline-run', runMode: 'baseline', status: 'interrupted', state: 'interrupted',
    startedAt: '2026-10-17T00:00:00.000Z', contacts,
    completedApiKeys: contacts.map(row => row.bossId), completedKeys: contacts.map(row => row.provisionalIdentityKey),
    selectedApiKeys: contacts.map(row => row.bossId), observedApiMessageKeys: contacts.map(row => `${row.bossId}\nold`),
    messageCount: 10,
    historyResults: Object.fromEntries(contacts.map(row => [row.provisionalIdentityKey, {
      bossId: row.bossId, availableHistoryComplete: true, friendUpdateTime: 100, messageCount: 1,
    }])),
  };
}

test('HTML on a later history page saves earlier valid pages and pauses before the next contact', async () => {
  const friends = [friend(20), friend(21)];
  const historyCalls = [];
  const fakeFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/wapi/zprelation/friend/geekFilterByLabel') return jsonResponse(listPayload(friends));
    historyCalls.push({ path, signal: init.signal });
    if (historyCalls.length === 1) return jsonResponse({ code: 0, zpData: {
      hasMore: true, minMsgId: '900', messages: [{ mid: '900', type: 3,
        from: { uid: 'peer-20' }, to: { uid: 'account-A' }, body: { type: 1, text: 'Synthetic history page' } }],
    } });
    return new Response('<!doctype html><html><title>Verification</title></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  };
  let calls = 0;
  const run = startCollector({ friends, fetchImpl: fakeFetch,
    readHistory: options => {
      calls++;
      return readAvailableConversationHistory(options);
    } });
  const progress = await run.finished;
  assert.equal(calls, 1);
  assert.equal(historyCalls.length, 2);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal(progress.completed, 0);
  assert.deepEqual(progress.completedApiKeys, []);
  assert.equal(run.snapshots.length, 1);
  assert.equal(run.snapshots[0].messages.items.length, 1);
  const historyResult = progress.historyResults[key(20)];
  assert.equal(historyResult.availableHistoryComplete, false);
  assert.equal(historyResult.error.code, 'SITE_NON_JSON_RESPONSE');
  assert.equal(historyResult.error.details.endpoint, '/wapi/zpchat/geek/historyMsg');
  assert.doesNotMatch(JSON.stringify(historyResult.error.details), /enc-20|account-A|900|bossId|\?/u);
});

test('a nonzero JSON API code also pauses the full round without showing the response message', async () => {
  const friends = [friend(22), friend(23)];
  let historyCalls = 0;
  const fakeFetch = async url => {
    if (new URL(url).pathname === '/wapi/zprelation/friend/geekFilterByLabel') return jsonResponse(listPayload(friends));
    historyCalls++;
    return jsonResponse({ code: 429, message: 'private verification payload', zpData: { messages: [] } });
  };
  const run = startCollector({ friends, fetchImpl: fakeFetch,
    readHistory: options => readAvailableConversationHistory(options) });
  const progress = await run.finished;
  assert.equal(historyCalls, 1);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.errorCode, 'SITE_API_ERROR');
  assert.equal(progress.completed, 0);
  assert.equal(progress.historyResults[key(22)].error.code, 'SITE_API_ERROR');
  assert.equal(progress.errorDetails.endpoint, '/wapi/zpchat/geek/historyMsg');
  assert.doesNotMatch(`${progress.error} ${JSON.stringify(progress.errorDetails)}`, /private verification payload|enc-22|\?/u);
});

test('stop aborts an in-flight list request and returns a terminal inactive status', async () => {
  let requestStarted;
  const startedRequest = new Promise(resolve => { requestStarted = resolve; });
  const run = startCollector({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    requestStarted();
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) });
  await startedRequest;
  const stopped = run.collector.stop();
  assert.equal(stopped.active, false);
  const progress = await run.finished;
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.errorCode, 'BULK_STOPPED');
});

test('stop best-effort saves a valid page already queued in memory', async () => {
  const friendRow = friend(40);
  let pageTwoStarted;
  const waitingForPageTwo = new Promise(resolve => { pageTwoStarted = resolve; });
  let historyRequest = 0;
  const run = startCollector({ friends: [friendRow], fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/wapi/zprelation/friend/geekFilterByLabel') {
      return jsonResponse(listPayload([friendRow]));
    }
    historyRequest++;
    if (historyRequest === 1) return jsonResponse({ code: 0, zpData: {
      hasMore: true, minMsgId: '1400', messages: [{ mid: '1400', type: 3,
        from: { uid: 'peer-40' }, to: { uid: 'account-A' }, body: { type: 1, text: 'Queued synthetic page' } }],
    } });
    pageTwoStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  }, readHistory: options => readAvailableConversationHistory(options) });
  await waitingForPageTwo;
  run.collector.stop();
  const progress = await run.finished;
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.completed, 0);
  assert.deepEqual(progress.completedApiKeys, []);
  assert.equal(run.snapshots.length, 1);
  assert.equal(run.snapshots[0].messages.items[0].contentText, 'Queued synthetic page');
});

test('a site request timeout interrupts the whole round with safe endpoint details', async () => {
  let historyCalls = 0;
  const run = startCollector({ friends: [friend(30)], requestTimeoutMs: 15,
    fetchImpl: async () => new Promise(() => {}),
    readHistory: async () => { historyCalls++; return { availableHistoryComplete: true, messages: [], pages: [] }; } });
  const progress = await run.finished;
  assert.equal(historyCalls, 0);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.errorCode, 'SITE_REQUEST_TIMEOUT');
  assert.equal(progress.errorDetails.endpoint, '/wapi/zprelation/friend/geekFilterByLabel');
  assert.equal(progress.errorDetails.timeoutMs, 15);
  assert.doesNotMatch(JSON.stringify(progress.errorDetails), /synthetic|token|account-A|\?/u);
});

test('an apiRevision 5 baseline keeps its ten completed contacts when list reading fails, then resumes only unfinished contacts', async () => {
  const previous = interruptedBaseline();
  const first = startCollector({ previous, fetchImpl: async () => new Response('<!doctype html><html>Login</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }) });
  assert.equal(first.started.completedApiKeys.length, 10);
  assert.equal(first.started.contacts.length, 10);
  const interrupted = await first.finished;
  assert.equal(interrupted.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal(interrupted.contacts.length, 10);
  assert.equal(interrupted.completedApiKeys.length, 10);

  const friends = [...Array.from({ length: 10 }, (_, index) => friend(index)), friend(10)];
  const readIds = [];
  const resumed = startCollector({ previous: interrupted, friends,
    readHistory: async ({ bossId }) => {
      readIds.push(bossId);
      return { availableHistoryComplete: true, completeReason: 'api_has_more_false', messages: [], pages: [] };
    } });
  const completed = await resumed.finished;
  assert.equal(resumed.started.runMode, 'baseline');
  assert.equal(resumed.started.resumed, true);
  assert.deepEqual(readIds, ['enc-10']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completed, 11);
  assert.equal(completed.skippedUnchangedCount, 10);
});

test('a final checkpoint timeout leaves the collector locally terminal instead of running forever', async () => {
  const run = startCollector({ storageTimeoutMs: 15, sendOverride: () => new Promise(() => {}) });
  await delay(80);
  const progress = run.collector.status();
  assert.equal(progress.active, false);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.state, 'interrupted');
  assert.equal(progress.errorCode, 'BULK_CHECKPOINT_FAILED');
});

test('real storage activity keeps a multi-step commit alive beyond the total timeout budget', async () => {
  let completedSends = 0;
  const run = startCollector({ storageTimeoutMs: 80, sendOverride: (_message, { onActivity }) =>
    new Promise(resolve => {
      setTimeout(onActivity, 30);
      setTimeout(onActivity, 60);
      setTimeout(onActivity, 90);
      setTimeout(onActivity, 120);
      setTimeout(() => { completedSends++; resolve({ ok: true }); }, 150);
    }) });
  const progress = await run.finished;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.errorCode, null);
  assert.ok(completedSends >= 2, 'each completed storage send lasted longer than its inactivity budget');
});

test('a silent storage channel still expires and cancels its connection', async () => {
  let cancelled = 0;
  const run = startCollector({ storageTimeoutMs: 20, sendOverride: () => {
    const pending = new Promise(() => {});
    pending.cancel = () => { cancelled++; };
    return pending;
  } });
  const progress = await run.finished;
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.errorCode, 'BULK_STORAGE_TIMEOUT');
  assert.ok(cancelled >= 1);
});
