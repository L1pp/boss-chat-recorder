import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_STORE_KEY, ACCOUNT_RUNTIME_KEY, createAccountStore } from '../extension-tracker/account-store.mjs';
import { CONVERSATION_BODY_PREFIX } from '../extension-tracker/conversation-store.mjs';
import { createExtensionMessageHandler, POPUP_VIEW_KEY, SITE_REQUEST_SLOT_KEY } from '../extension-tracker/service-worker.js';

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const EXTENSION_ID = 'minimal-runtime-test';
const popupSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` };

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageArea(values) {
  return {
    async get(key) {
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
      const result = {};
      for (const name of key || []) if (Object.hasOwn(values, name)) result[name] = clone(values[name]);
      return result;
    },
    async set(record) {
      for (const [key, value] of Object.entries(record)) values[key] = clone(value);
    },
  };
}

function makeHarness({ now = () => Date.now(), requestIntervalMs = 10_000 } = {}) {
  const localValues = {};
  const sessionValues = {};
  const pages = new Map();
  const tabs = new Map();
  const badge = new Map();
  const storage = {
    local: createStorageArea(localValues),
    session: createStorageArea(sessionValues),
  };
  const chromeApi = {
    runtime: { id: EXTENSION_ID, getManifest: () => ({ version: '0.8.4', name: 'BOSS沟通记录' }) },
    storage,
    action: {
      async setBadgeText({ tabId, text }) { badge.set(tabId, { ...(badge.get(tabId) || {}), text }); },
      async setTitle({ tabId, title }) { badge.set(tabId, { ...(badge.get(tabId) || {}), title }); },
    },
    tabs: { async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('TAB_NOT_AVAILABLE');
      return clone(tab);
    } },
    scripting: {
      async executeScript({ target, files, func, args = [] }) {
        const page = pages.get(target?.tabId);
        if (!page) throw new Error('TAB_NOT_AVAILABLE');
        if (files) {
          page.loadedFiles.push(...files);
          return [{ result: null }];
        }
        if (func?.name === 'pageReadAccount') {
          page.accountReads++;
          if (page.accountReadError) return [{ result: { ok: false, error: page.accountReadError } }];
          return [{ result: { ok: true, value: { uid: page.uid } } }];
        }
        if (func?.name === 'pageStartCollection') {
          const options = clone(args[0]);
          page.startCount++;
          page.startOptions = options;
          const progress = { kind: 'api_v1', runId: `run-${options.accountUid}-${target.tabId}-${page.startCount}`,
            accountUid: options.accountUid, collectionToken: options.collectionToken, status: 'running',
            state: 'running', active: true, phase: 'discovering', discovered: 0, completed: 0,
            failed: 0, messageCount: 0, historyResults: {}, updatedAt: new Date().toISOString() };
          page.collector = { accountUid: options.accountUid, collectionToken: options.collectionToken, progress };
          return [{ result: clone(progress) }];
        }
        if (func?.name === 'pageCollectorStatus') return [{ result: clone(page.collector?.progress || null) }];
        if (func?.name === 'pageStopCollectionBound') {
          if (page.collector?.accountUid !== args[0] || page.collector?.collectionToken !== args[1]) {
            return [{ result: null }];
          }
          page.stopCalls.push(page.collector.collectionToken);
          page.collector.progress = { ...page.collector.progress,
            status: 'stopped', state: 'stopped', active: false, finalizing: false,
            finishedAt: new Date().toISOString() };
          return [{ result: clone(page.collector.progress) }];
        }
        throw new Error(`Unexpected injected function: ${func?.name}`);
      },
    },
  };
  const handler = createExtensionMessageHandler(chromeApi, { requestIntervalMs, now });
  const store = createAccountStore(chromeApi);

  function addPage(tabId, uid) {
    const page = { uid, accountReads: 0, accountReadError: null, loadedFiles: [], collector: null,
      startOptions: null, startCount: 0, stopCalls: [] };
    pages.set(tabId, page);
    tabs.set(tabId, { id: tabId, url: CHAT_URL });
    return page;
  }

  return { chromeApi, localValues, sessionValues, pages, tabs, badge, handler, store, addPage };
}

function pageSender(tabId) {
  return { id: EXTENSION_ID, url: CHAT_URL, tab: { id: tabId, url: CHAT_URL } };
}

async function ui(harness, type, tabId, fields = {}) {
  const message = { type, ...fields };
  if (tabId !== undefined && tabId !== null) message.tabId = tabId;
  return harness.handler(message, popupSender);
}

async function start(harness, tabId, accountUid, type = 'START_UPDATE') {
  return ui(harness, type, tabId, { expectedAccountUid: accountUid, mode: 'incremental' });
}

test('running checkpoints and polling never read or write the chat body', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const started = await start(h, 1, 'accountA');
  assert.equal(started.ok, true, JSON.stringify(started));
  let reads = 0, writes = 0, runtimeReads = 0, runtimeWrites = 0;
  const originalGet = h.chromeApi.storage.local.get;
  const originalSet = h.chromeApi.storage.local.set;
  h.chromeApi.storage.local.get = async key => {
    if (key === ACCOUNT_STORE_KEY) reads++;
    if (key === ACCOUNT_RUNTIME_KEY) runtimeReads++;
    return originalGet(key);
  };
  h.chromeApi.storage.local.set = async values => {
    if (Object.hasOwn(values, ACCOUNT_STORE_KEY)) writes++;
    if (Object.hasOwn(values, ACCOUNT_RUNTIME_KEY)) runtimeWrites++;
    return originalSet(values);
  };
  const scope = { accountUid: 'accountA', collectionToken: started.progress.collectionToken };
  const progress = { ...page.collector.progress, phase: 'history', discovered: 1, completed: 0 };
  const saved = await h.handler({ type: 'BULK_PROGRESS', ...scope, progress }, pageSender(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 }, 'progress must not move the chat body');
  assert.deepEqual({ runtimeReads, runtimeWrites }, { runtimeReads: 1, runtimeWrites: 1 });

  reads = writes = runtimeReads = runtimeWrites = 0;
  const snapshot = await h.handler({ type: 'BULK_SNAPSHOTS', ...scope,
    snapshots: [historySnapshot('accountA', 'm1', 'synthetic private message')] }, pageSender(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 }, 'snapshots must not move the legacy whole body');
  assert.equal(JSON.stringify(snapshot).includes('synthetic private message'), false);

  reads = writes = runtimeReads = runtimeWrites = 0;
  const polled = await ui(h, 'GET_BULK_PROGRESS', 1, { expectedAccountUid: 'accountA' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(polled.ok, true, JSON.stringify(polled));
  assert.equal(polled.summary.messageCount, 1);
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 });
  assert.deepEqual({ runtimeReads, runtimeWrites }, { runtimeReads: 1, runtimeWrites: 0 });
  assert.equal(page.accountReads, 1, 'local polling must not add a website identity request');
});

test('a failed snapshot commit leaves stored messages intact and can be retried once', async () => {
  const h = makeHarness();
  h.addPage(1, 'accountA');
  const started = await start(h, 1, 'accountA');
  const message = { type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken,
    snapshots: [historySnapshot('accountA', 'retry-mid', 'synthetic retry message')] };
  const originalSet = h.chromeApi.storage.local.set;
  const before = structuredClone(h.localValues[ACCOUNT_STORE_KEY]);
  h.chromeApi.storage.local.set = async values => {
    if (Object.keys(values).some(key => key.startsWith(CONVERSATION_BODY_PREFIX))) {
      throw new Error('SYNTHETIC_STORAGE_FAILURE');
    }
    return originalSet(values);
  };
  const failed = await h.handler(message, pageSender(1));
  assert.equal(failed.ok, false);
  assert.deepEqual(h.localValues[ACCOUNT_STORE_KEY], before);
  h.chromeApi.storage.local.set = originalSet;
  const retried = await h.handler(message, pageSender(1));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.newMessageCount, 1);
  assert.equal(retried.summary.messageCount, 1);
});

function historySnapshot(accountUid, messageId, contentText) {
  return {
    status: 'readable_chat_dom', captureMode: 'bulk_history', captureTransport: 'history_api',
    source: 'same_origin_history_api', selfUid: accountUid, bossId: `hr-${accountUid}`,
    page: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat',
      capturedAt: new Date().toISOString() },
    list: { rows: [{ active: true, bossId: `hr-${accountUid}`, company: '演示公司', hrName: '演示 HR' }] },
    messages: { items: [{ messageId, kind: 'text', direction: 'hr', contentText, text: contentText,
      sentAtISO: new Date().toISOString() }] },
    historyCoverage: { availableHistoryComplete: true, startReached: true, hasMore: false },
  };
}

test('popup and archive routes use an explicit local account and do not probe BOSS', async () => {
  const h = makeHarness();
  const pageA = h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');

  const selected = await ui(h, 'GET_STATE', undefined, { expectedAccountUid: 'accountA' });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.accountUid, 'accountA');
  assert.deepEqual(Object.keys(h.localValues[POPUP_VIEW_KEY]).sort(),
    ['accountUid', 'progress', 'summary', 'updatedAt', 'verificationRequired', 'verificationRetrying'].sort());
  assert.equal(pageA.accountReads, 0);

  const bSelected = await ui(h, 'GET_STATE', undefined, { expectedAccountUid: 'accountB' });
  assert.equal(bSelected.accountUid, 'accountB');
  assert.equal((await h.store.getAccount('accountA')).accountUid, 'accountA');
  assert.equal(pageA.accountReads, 0);

  const aStart = await start(h, 1, 'accountA');
  assert.equal(aStart.ok, true, JSON.stringify(aStart));
  assert.equal(pageA.accountReads, 1, 'one fresh UID read is allowed when starting a run');
  const polled = await ui(h, 'GET_BULK_PROGRESS', 1, { expectedAccountUid: 'accountA' });
  assert.equal(polled.ok, true, JSON.stringify(polled));
  const stopped = await ui(h, 'STOP_UPDATE', 1, { expectedAccountUid: 'accountA' });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const ai = await ui(h, 'EXPORT_AI_INPUT', undefined, { expectedAccountUid: 'accountA', scope: 'all' });
  const backup = await ui(h, 'EXPORT_ACCOUNT_BACKUP', undefined, { expectedAccountUid: 'accountA' });
  assert.equal(ai.accountUid, 'accountA');
  assert.equal(backup.accountUid, 'accountA');
  const cleared = await ui(h, 'CLEAR_ACCOUNT', 1, { expectedAccountUid: 'accountA' });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(pageA.accountReads, 1, 'stop and exports use local partitions only');
});

test('one fresh UID mismatch invalidates the old token and starts only the actual account partition', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountB');
  await h.store.getOrCreateAccount('accountA');
  await h.store.setTabBinding(1, 'accountA', 'old-account-a-token');
  await h.store.updateBoundAccount({ tabId: 1, accountUid: 'accountA', collectionToken: 'old-account-a-token' }, partition => {
    partition.runtime.progressByTab['1'] = { kind: 'api_v1', accountUid: 'accountA',
      collectionToken: 'old-account-a-token', status: 'running', state: 'running', active: true };
  });
  page.collector = null;

  const result = await start(h, 1, 'accountA');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.accountUid, 'accountB');
  assert.equal(result.progress.accountUid, 'accountB');
  assert.equal(result.view.accountUid, 'accountB');
  assert.equal(h.localValues[POPUP_VIEW_KEY].accountUid, 'accountB');
  assert.equal(page.accountReads, 1);
  assert.equal(page.startCount, 1);
  assert.equal((await h.store.getTabBinding(1)).accountUid, 'accountB');
  assert.equal((await h.store.getAccount('accountA')).state.messages &&
    Object.keys((await h.store.getAccount('accountA')).state.messages).length, 0);

  await h.store.updateAccount('accountA', partition => {
    partition.runtime.verificationRequired = { required: true, accountUid: 'accountA', tabId: 1,
      collectionToken: 'old-gate-token', retrying: false };
  });
  const resume = await start(h, 1, 'accountA', 'RESUME_AFTER_VERIFICATION');
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal(resume.accountUid, 'accountB');
  assert.equal(resume.progress.collectionToken, result.progress.collectionToken,
    'the compatibility alias reuses the ordinary START live-token path');
  assert.equal(page.startCount, 1);
  assert.equal(page.accountReads, 1, 'the existing B task is returned without a second UID request');
  assert.equal((await h.store.getAccount('accountA')).runtime.verificationRequired.required, true);
});

test('collector progress and snapshots use tab/token/native identity and stale account updates cannot replace the popup view', async () => {
  const h = makeHarness();
  const pageA = h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  const startedA = await start(h, 1, 'accountA');
  assert.equal(startedA.ok, true, JSON.stringify(startedA));
  const token = startedA.progress.collectionToken;
  await ui(h, 'GET_STATE', undefined, { expectedAccountUid: 'accountB' });

  const progress = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA', collectionToken: token,
    progress: { ...startedA.progress, status: 'running', state: 'running', active: true, completed: 1 } }, pageSender(1));
  assert.equal(progress.ok, true, JSON.stringify(progress));
  assert.equal(pageA.accountReads, 1, 'collector checkpoints do not probe userinfo');
  assert.equal(h.localValues[POPUP_VIEW_KEY].accountUid, 'accountB');

  const wrongIdentity = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA', collectionToken: token,
    snapshots: [historySnapshot('accountB', 'wrong-account-message', '不应写入')] }, pageSender(1));
  assert.equal(wrongIdentity.error, 'SNAPSHOT_ACCOUNT_MISMATCH');
  const saved = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA', collectionToken: token,
    snapshots: [historySnapshot('accountA', 'a-message', '只属于 accountA')] }, pageSender(1));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(pageA.accountReads, 1);
  assert.equal(Object.keys((await h.store.getAccount('accountA')).state.messages).length, 1);
  assert.equal(h.localValues[POPUP_VIEW_KEY].accountUid, 'accountB', 'late A activity must not replace B view');
});

test('a first start without a cached UID probes once, while local GET_STATE can reopen the cached archive', async () => {
  const h = makeHarness();
  const page = h.addPage(4, 'accountC');
  const first = await ui(h, 'START_UPDATE', 4, { mode: 'incremental' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(page.accountReads, 1);
  assert.equal(h.localValues[POPUP_VIEW_KEY].accountUid, 'accountC');

  page.uid = 'accountD';
  const reopened = await ui(h, 'GET_STATE', undefined);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.accountUid, 'accountC');
  assert.equal(page.accountReads, 1, 'cached archive selection does not check current site login');
});

test('a missing popup cache is initialized from the most recently updated local partition', async () => {
  const h = makeHarness();
  const page = h.addPage(5, 'accountA');
  const started = await start(h, 5, 'accountA');
  assert.equal(started.ok, true, JSON.stringify(started));
  const saved = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken,
    snapshots: [historySnapshot('accountA', 'retained-message', '保留在本机的历史') ] }, pageSender(5));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  delete h.localValues[POPUP_VIEW_KEY];

  page.uid = 'accountB';
  const reopened = await ui(h, 'GET_STATE', undefined);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.accountUid, 'accountA');
  assert.equal(reopened.summary.contactCount, 1);
  assert.equal(reopened.summary.messageCount, 1);
  assert.equal(h.localValues[POPUP_VIEW_KEY].accountUid, 'accountA');
  assert.equal(page.accountReads, 1, 'cache recovery reads local partitions without checking BOSS');
  assert.equal(h.localValues[ACCOUNT_STORE_KEY].accounts['account:accountA'].accountUid, 'accountA');
});

test('SITE_REQUEST_SLOT grants one shared 10-second slot and persists the next time in session storage', async () => {
  let clock = 50_000;
  const h = makeHarness({ now: () => clock });
  h.addPage(1, 'accountA');
  const requests = [
    h.handler({ type: 'SITE_REQUEST_SLOT', endpoint: '/wapi/zpuser/wap/getUserInfo.json' }, pageSender(1)),
    h.handler({ type: 'SITE_REQUEST_SLOT', endpoint: '/wapi/zprelation/friend/geekFilterByLabel' }, pageSender(1)),
  ];
  const [first, second] = await Promise.all(requests);
  assert.deepEqual([first.waitMs, second.waitMs].sort((a, b) => a - b), [0, 10_000]);
  assert.equal(h.sessionValues[SITE_REQUEST_SLOT_KEY].nextRequestAt, 60_000);

  clock = 51_500;
  const waiting = await h.handler({ type: 'SITE_REQUEST_SLOT', endpoint: '/wapi/zpchat/geek/historyMsg' }, pageSender(1));
  assert.equal(waiting.waitMs, 8_500);
  assert.equal(h.sessionValues[SITE_REQUEST_SLOT_KEY].nextRequestAt, 60_000,
    'waiting does not reserve a later slot');

  const restartedWorker = createExtensionMessageHandler(h.chromeApi, { now: () => clock });
  const afterRestart = await restartedWorker({ type: 'SITE_REQUEST_SLOT',
    endpoint: '/wapi/zpchat/geek/historyMsg' }, pageSender(1));
  assert.equal(afterRestart.waitMs, 8_500);
  clock = 60_000;
  const granted = await restartedWorker({ type: 'SITE_REQUEST_SLOT',
    endpoint: '/wapi/zpchat/geek/historyMsg' }, pageSender(1));
  assert.equal(granted.waitMs, 0);
  assert.equal(h.sessionValues[SITE_REQUEST_SLOT_KEY].nextRequestAt, 70_000);

  const denied = await restartedWorker({ type: 'SITE_REQUEST_SLOT', endpoint: '/wapi/other/path' }, pageSender(1));
  assert.equal(denied.error, 'SITE_REQUEST_PATH_NOT_ALLOWED');
});

