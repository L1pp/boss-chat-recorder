import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ACCOUNT_STORE_KEY, ACCOUNT_RUNTIME_KEY, createAccountStore } from '../extension-tracker/account-store.mjs';
import { createExtensionMessageHandler, POPUP_VIEW_KEY } from '../extension-tracker/service-worker.js';

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const popupSender = { id: 'showcase-test', url: 'chrome-extension://showcase-test/popup.html' };
const pageContexts = new WeakMap();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeHarness({ legacy = null } = {}) {
  const values = legacy ? { 'bossReadonlyTracker.v2': clone(legacy) } : {};
  const pages = new Map();
  const tabs = new Map();
  let handler;
  const storage = {
    async get(key) {
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
      const result = {};
      for (const name of key || []) if (Object.hasOwn(values, name)) result[name] = clone(values[name]);
      return result;
    },
    async set(record) {
      await new Promise(resolve => setTimeout(resolve, 1));
      for (const [key, value] of Object.entries(record)) values[key] = clone(value);
    },
  };
  const chromeApi = {
    runtime: { id: 'showcase-test', getManifest: () => ({ version: '0.8.4' }) },
    storage: { local: storage },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('TAB_NOT_AVAILABLE');
        return clone(tab);
      },
    },
    scripting: {
      async executeScript({ target, files, func, args = [] }) {
        const page = pages.get(target?.tabId);
        if (!page) throw new Error('TAB_NOT_AVAILABLE');
        if (files) {
          page.loadedFiles.push(...files);
          return [{ result: null }];
        }
        if (func?.name === 'pageReadAccount') {
          page.accountReadCount++;
          if (page.readAccountHook) return [{ result: await page.readAccountHook() }];
          return [{ result: page.uid ? { ok: true, value: { uid: page.uid } }
            : { ok: true, value: null } }];
        }
        if (func?.name === 'pageStartCollection') {
          const options = clone(args[0]);
          page.startCount++;
          page.startOptions = options;
          const root = values[ACCOUNT_RUNTIME_KEY];
          const binding = root?.tabBindings?.[String(target.tabId)] || null;
          page.bindingSeenAtStart = clone(binding);
          page.collector = {
            accountUid: options.accountUid,
            collectionToken: options.collectionToken,
            progress: { kind: 'api_v1', runId: `run-${options.accountUid}-${target.tabId}`,
              accountUid: options.accountUid, collectionToken: options.collectionToken,
              status: 'running', state: 'running', active: true, discovered: 0, completed: 0,
              historyResults: {}, updatedAt: new Date().toISOString() },
          };
          if (page.emitFirstProgress) {
            page.emitFirstProgress = false;
            page.firstProgressResult = await handler({ type: 'BULK_PROGRESS', accountUid: options.accountUid,
              collectionToken: options.collectionToken, progress: clone(page.collector.progress) }, pageSender(target.tabId));
          }
          page.startEntered?.(page.collector.progress);
          if (page.startGate) await page.startGate;
          return [{ result: clone(page.collector.progress) }];
        }
        if (func?.name === 'pageCollectorStatus') return [{ result: clone(page.collector?.progress || null) }];
        if (func?.name === 'pageStopCollectionBound') {
          const [accountUid, collectionToken] = args;
          if (!page.collector || page.collector.accountUid !== accountUid ||
              page.collector.collectionToken !== collectionToken) return [{ result: null }];
          page.stopCalls.push(collectionToken);
          page.collector.progress = { ...page.collector.progress, status: 'interrupted', state: 'interrupted',
            active: false, finalizing: true, stopRequested: true, errorCode: 'BULK_STOPPED' };
          return [{ result: clone(page.collector.progress) }];
        }
        if (func?.name === 'pageStopCollection') {
          if (!page.collector) return [{ result: null }];
          page.stopCalls.push(page.collector.collectionToken);
          page.collector.progress = { ...page.collector.progress, status: 'stopped', state: 'stopped', active: false };
          return [{ result: clone(page.collector.progress) }];
        }
        throw new Error(`Unexpected injected function: ${func?.name}`);
      },
    },
  };

  function addPage(tabId, uid) {
    const page = { uid, loadedFiles: [], startOptions: null, bindingSeenAtStart: null, collector: null,
      startGate: null, startEntered: null, stopCalls: [], readAccountHook: null, accountReadCount: 0,
      startCount: 0, emitFirstProgress: false, firstProgressResult: null };
    pages.set(tabId, page);
    tabs.set(tabId, { id: tabId, url: CHAT_URL });
    return page;
  }

  handler = createExtensionMessageHandler(chromeApi, { requestIntervalMs: 0, now: () => Date.now() });
  pageContexts.set(handler, pages);
  const createHandler = () => {
    const next = createExtensionMessageHandler(chromeApi, { requestIntervalMs: 0, now: () => Date.now() });
    pageContexts.set(next, pages);
    return next;
  };
  return { chromeApi, pages, tabs, values, addPage,
    store: createAccountStore(chromeApi), handler, createHandler };
}

function pageSender(tabId) {
  return { id: 'showcase-test', url: CHAT_URL, tab: { id: tabId, url: CHAT_URL } };
}

function snapshot(selfUid, contentText) {
  return {
    selfUid,
    captureMode: 'api_history', captureTransport: 'history_api',
    page: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat',
      capturedAt: '2026-10-17T12:00:00.000Z' },
    list: { rows: [{ active: true, bossId: 'same-native-hr', company: '演示公司',
      hrName: '同一位 HR', hrRole: '招聘者', jobTitle: '软件工程师' }] },
    messages: { items: [{ messageId: 'same-mid', kind: 'text', direction: 'hr', contentText,
      text: contentText, sentAtISO: '2026-10-17T11:58:00.000Z' }] },
    historyCoverage: { availableHistoryComplete: true, startReached: true, hasMore: false },
  };
}

async function ui(handler, type, tabId, fields = {}) {
  const page = pageContexts.get(handler)?.get(tabId);
  const expectedAccountUid = fields.expectedAccountUid ?? page?.uid;
  const payload = { type, tabId, ...fields };
  if (type !== 'GET_STATE' && expectedAccountUid !== undefined) payload.expectedAccountUid = expectedAccountUid;
  return handler(payload, popupSender);
}

async function start(handler, tabId, mode = 'incremental', expectedAccountUid = undefined) {
  const fields = { mode };
  if (expectedAccountUid !== undefined) fields.expectedAccountUid = expectedAccountUid;
  const result = await ui(handler, 'START_UPDATE', tabId, fields);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test('two logged-in UIDs retain identical HR IDs and MIDs in separate state, exports, and baselines', async () => {
  const h = makeHarness();
  h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  const aStarted = await start(h.handler, 1);
  const firstAState = await ui(h.handler, 'GET_STATE', 1);
  assert.equal(firstAState.accountUid, 'accountA');
  assert.equal(Object.hasOwn(firstAState, 'state'), false);
  const bStarted = await start(h.handler, 2);
  const firstBState = await ui(h.handler, 'GET_STATE', 2);
  assert.equal(firstBState.accountUid, 'accountB');
  assert.equal(h.pages.get(1).bindingSeenAtStart?.collectionToken, aStarted.progress.collectionToken);
  assert.equal(h.pages.get(2).bindingSeenAtStart?.collectionToken, bStarted.progress.collectionToken);
  assert.equal(h.pages.get(1).startOptions.accountUid, 'accountA');
  assert.equal(h.pages.get(2).startOptions.accountUid, 'accountB');
  assert.equal(h.pages.get(1).startOptions.storedContacts.length, 0);
  assert.equal(h.pages.get(1).accountReadCount, 1);
  assert.equal(h.pages.get(2).accountReadCount, 1);

  for (const [tabId, accountUid, token] of [
    [1, 'accountA', aStarted.progress.collectionToken],
    [2, 'accountB', bStarted.progress.collectionToken],
  ]) {
    const progress = await h.handler({ type: 'BULK_PROGRESS', accountUid, collectionToken: token,
      progress: { kind: 'api_v1', runId: `run-${accountUid}`, status: 'completed', state: 'completed',
        active: false, selectedCount: 1, historyResults: {} } }, pageSender(tabId));
    assert.equal(progress.ok, true, JSON.stringify(progress));
    const saved = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid, collectionToken: token,
      sessionId: `run-${accountUid}`, snapshots: [snapshot(accountUid, `只属于 ${accountUid} 的消息`)] }, pageSender(tabId));
    assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  assert.equal(h.pages.get(1).accountReadCount, 1, 'collector messages must not refetch account identity');
  assert.equal(h.pages.get(2).accountReadCount, 1, 'collector messages must not refetch account identity');

  const a = await h.store.getAccount('accountA');
  const b = await h.store.getAccount('accountB');
  assert.equal(Object.keys(a.state.contacts).length, 1);
  assert.equal(Object.keys(b.state.contacts).length, 1);
  assert.equal(Object.keys(a.state.messages).length, 1);
  assert.equal(Object.keys(b.state.messages).length, 1);
  assert.equal(Object.values(a.state.messages)[0].contentText, '只属于 accountA 的消息');
  assert.equal(Object.values(b.state.messages)[0].contentText, '只属于 accountB 的消息');
  assert.equal(a.baseline.previousProgress.runId, 'run-accountA');
  assert.equal(b.baseline.previousProgress.runId, 'run-accountB');

  await start(h.handler, 1, 'incremental', 'accountA');
  const aiA = await ui(h.handler, 'EXPORT_AI_INPUT', 1, { scope: 'all', expectedAccountUid: 'accountA' });
  const backupA = await ui(h.handler, 'EXPORT_ACCOUNT_BACKUP', 1, { expectedAccountUid: 'accountA' });
  await start(h.handler, 2, 'incremental', 'accountB');
  const aiB = await ui(h.handler, 'EXPORT_AI_INPUT', 2, { scope: 'all', expectedAccountUid: 'accountB' });
  const backupB = await ui(h.handler, 'EXPORT_ACCOUNT_BACKUP', 2, { expectedAccountUid: 'accountB' });
  assert.equal(aiA.analysisInput.accountUid, 'accountA');
  assert.equal(aiB.analysisInput.accountUid, 'accountB');
  assert.deepEqual(aiA.analysisInput.conversations.flatMap(item => item.messages.map(message => message.text)),
    ['只属于 accountA 的消息']);
  assert.deepEqual(aiB.analysisInput.conversations.flatMap(item => item.messages.map(message => message.text)),
    ['只属于 accountB 的消息']);
  assert.equal(backupA.backup.accountUid, 'accountA');
  assert.equal(backupB.backup.accountUid, 'accountB');
  assert.equal(backupA.backup.conversations[0].messages[0].contentText, '只属于 accountA 的消息');
  assert.equal(backupB.backup.conversations[0].messages[0].contentText, '只属于 accountB 的消息');
});

test('tab tokens survive worker restart, reject cross-tab and late messages, and account switch/unknown fail closed', async () => {
  const h = makeHarness();
  h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  const startedA = await start(h.handler, 1);
  const startedB = await start(h.handler, 2);

  const restartedWorker = h.createHandler();
  const resumed = await restartedWorker({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: startedA.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'after-restart', status: 'running', active: true } }, pageSender(1));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(h.pages.get(1).accountReadCount, 1, 'a persisted token is sufficient after worker restart');

  const wrongTab = await restartedWorker({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: startedA.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'wrong-tab', status: 'completed' } }, pageSender(2));
  assert.equal(wrongTab.error, 'COLLECTION_TOKEN_REVOKED');

  const savedBBaseline = await restartedWorker({ type: 'BULK_PROGRESS', accountUid: 'accountB',
    collectionToken: startedB.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'b-baseline', status: 'completed', state: 'completed', active: false } }, pageSender(2));
  assert.equal(savedBBaseline.ok, true, JSON.stringify(savedBBaseline));
  h.pages.get(1).collector = null;
  h.pages.get(1).uid = 'accountB';
  const switched = await start(restartedWorker, 1, 'incremental', 'accountA');
  assert.equal(switched.accountUid, 'accountB');
  assert.equal(h.pages.get(1).accountReadCount, 2, 'one START performs one fresh UID read');
  assert.equal(h.pages.get(1).startOptions.accountUid, 'accountB');
  assert.equal(h.pages.get(1).startOptions.previous.runId, 'b-baseline', 'A baseline must not be reused for B');
  assert.equal((await h.store.getTabBinding(1)).accountUid, 'accountB');

  const staleInB = await restartedWorker({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: startedA.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'after-switch', status: 'completed' } }, pageSender(1));
  assert.equal(staleInB.error, 'COLLECTION_TOKEN_REVOKED');
  const current = await ui(restartedWorker, 'GET_STATE', 1);
  assert.equal(current.accountUid, 'accountB');
  assert.equal(current.summary.contactCount, 0);
  assert.equal(h.pages.get(1).accountReadCount, 2, 'GET_STATE reads the local archive view only');
  assert.equal((await h.store.getAccount('accountA')).baseline.previousProgress.runId, 'after-restart');
  h.pages.get(1).uid = 'accountA';
  const staleAfterReturn = await restartedWorker({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: startedA.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'after-return', status: 'completed' } }, pageSender(1));
  assert.equal(staleAfterReturn.error, 'COLLECTION_TOKEN_REVOKED');
  assert.equal(h.pages.get(1).accountReadCount, 2, 'a stale collector message does not re-probe the site');

  h.pages.get(1).uid = 'accountB';
  const replacementB = await start(restartedWorker, 1, 'incremental', 'accountB');
  assert.equal(replacementB.accountUid, 'accountB');
  const readsBeforeUnknown = h.pages.get(1).accountReadCount;
  h.pages.get(1).uid = null;
  const unknown = await ui(restartedWorker, 'GET_STATE', 1);
  assert.equal(unknown.accountUid, 'accountB', 'popup state names the local archive account');
  assert.equal(h.pages.get(1).accountReadCount, readsBeforeUnknown);
  h.pages.get(1).collector = null;
  const unknownStart = await ui(restartedWorker, 'START_UPDATE', 1,
    { mode: 'incremental', expectedAccountUid: 'accountB' });
  assert.equal(unknownStart.error, 'ACCOUNT_IDENTITY_UNAVAILABLE');
  assert.equal(h.pages.get(1).accountReadCount, readsBeforeUnknown + 1);

  h.pages.get(1).uid = 'accountB';
  const lateB = await restartedWorker({ type: 'BULK_SNAPSHOTS', accountUid: 'accountB',
    collectionToken: replacementB.progress.collectionToken, sessionId: 'late',
    snapshots: [snapshot('accountB', '不可写入的迟到消息')] }, pageSender(1));
  assert.equal(lateB.error, 'COLLECTION_TOKEN_REVOKED');
});

test('clearing one account removes only its state and invalidates all of its tab tokens without migrating legacy data', async () => {
  const legacy = { schemaVersion: 2, contacts: { old: { identity: { hrName: '私有旧数据' } } } };
  const h = makeHarness({ legacy });
  h.addPage(1, 'accountA');
  h.addPage(2, 'accountA');
  h.addPage(3, 'accountB');
  const a1 = await start(h.handler, 1);
  const a2 = await start(h.handler, 2);
  const b = await start(h.handler, 3);
  await h.store.updateAccount('accountA', partition => {
    partition.state.contacts.private = { identity: { bossId: 'a-only' } };
    partition.runtime.progressByTab['1'].status = 'running';
  });
  await h.store.updateAccount('accountB', partition => {
    partition.state.contacts.private = { identity: { bossId: 'b-only' } };
  });

  const accountAReadCount = h.pages.get(1).accountReadCount;
  const a1Selected = await start(h.handler, 1, 'incremental', 'accountA');
  assert.equal(a1Selected.accountUid, 'accountA');
  const readsBeforeClear = h.pages.get(1).accountReadCount;
  assert.equal(readsBeforeClear, accountAReadCount, 'an already running token is reused without another UID request');
  h.pages.get(1).uid = 'accountB';
  const clear = await ui(h.handler, 'CLEAR_ACCOUNT', 1, { expectedAccountUid: 'accountA' });
  assert.equal(clear.ok, true, JSON.stringify(clear));
  assert.equal(clear.accountUid, 'accountA');
  assert.deepEqual(clear.invalidatedTabIds.sort((x, y) => x - y), [1, 2]);
  assert.equal(h.pages.get(1).accountReadCount, readsBeforeClear, 'CLEAR_ACCOUNT only targets the selected local archive');
  assert.equal(await h.store.getAccount('accountA'), null);
  assert.equal((await h.store.getAccount('accountB')).state.contacts.private.identity.bossId, 'b-only');
  assert.equal(h.values['bossReadonlyTracker.v2'].contacts.old.identity.hrName, '私有旧数据');
  assert.equal(h.values[ACCOUNT_STORE_KEY].accounts['account:accountA'], undefined);

  const late = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: a1.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'late-after-clear', status: 'completed' } }, pageSender(1));
  assert.equal(late.error, 'COLLECTION_TOKEN_REVOKED');
  assert.equal(await h.store.getAccount('accountA'), null);
  const bState = await h.store.getAccount('accountB');
  assert.equal(bState.accountUid, 'accountB');
  assert.equal(Object.keys(bState.state.contacts).length, 1);
  assert.equal(typeof a2.progress.collectionToken, 'string');
  assert.equal(typeof b.progress.collectionToken, 'string');

  const lateSelected = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: a1Selected.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'after-clear-selected', status: 'completed' } }, pageSender(1));
  assert.equal(lateSelected.error, 'COLLECTION_TOKEN_REVOKED');
});

test('local UI actions do not probe the site; only START reads the account and switches the archive view', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const emptyView = await ui(h.handler, 'GET_STATE', 1);
  assert.equal(emptyView.error, 'ACCOUNT_UID_REQUIRED');
  assert.equal(page.accountReadCount, 0);

  const missingTab = await h.handler({ type: 'START_UPDATE', mode: 'incremental' }, popupSender);
  assert.equal(missingTab.error, 'TAB_ID_REQUIRED');
  assert.equal(page.accountReadCount, 0);

  const started = await start(h.handler, 1);
  assert.equal(started.accountUid, 'accountA');
  assert.equal(page.accountReadCount, 1);
  const localReads = [
    await ui(h.handler, 'GET_STATE', 1),
    await ui(h.handler, 'GET_BULK_PROGRESS', 1),
    await ui(h.handler, 'EXPORT_AI_INPUT', 1, { scope: 'all' }),
    await ui(h.handler, 'EXPORT_ACCOUNT_BACKUP', 1),
  ];
  assert.ok(localReads.every(result => result.ok), JSON.stringify(localReads));
  const snapshotResult = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken, sessionId: started.progress.runId,
    snapshots: [snapshot('accountA', '同账号本地合成记录')] }, pageSender(1));
  assert.equal(snapshotResult.ok, true, JSON.stringify(snapshotResult));
  const stopped = await ui(h.handler, 'STOP_UPDATE', 1);
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const stopCheckpoint = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken,
    progress: { kind: 'api_v1', runId: started.progress.runId, status: 'stopped', state: 'stopped',
      active: false, finalizing: false, finishedAt: new Date().toISOString() } }, pageSender(1));
  assert.equal(stopCheckpoint.ok, true, JSON.stringify(stopCheckpoint));
  assert.equal(page.accountReadCount, 1, 'GET_STATE/progress/exports/snapshots/STOP are local to the account partition');

  page.uid = 'accountB';
  const cached = await ui(h.handler, 'GET_STATE', 1);
  assert.equal(cached.accountUid, 'accountA', 'the popup view identifies the local archive, not the live site account');
  assert.equal(page.accountReadCount, 1);
  const switched = await start(h.handler, 1, 'incremental', 'accountA');
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.accountUid, 'accountB', 'one explicit START resolves the current site UID and selects B');
  assert.equal(page.accountReadCount, 2, 'one START performs exactly one account read');
  assert.equal(page.startOptions.accountUid, 'accountB');
  assert.equal(page.startOptions.previous, null, 'A baseline cannot be borrowed by B');
  assert.equal(Object.keys(h.values[ACCOUNT_STORE_KEY].accounts).length, 2);
});

test('START can receive the collector first checkpoint while executeScript is still resolving',
  { timeout: 5000 }, async () => {
    const h = makeHarness();
    const page = h.addPage(1, 'accountA');
    page.emitFirstProgress = true;

    const started = await start(h.handler, 1);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(page.accountReadCount, 1);
    assert.equal(page.firstProgressResult?.ok, true, JSON.stringify(page.firstProgressResult));
    assert.equal(page.firstProgressResult.progress.collectionToken, started.progress.collectionToken);
    assert.equal(page.startCount, 1);
    const account = await h.store.getAccount('accountA');
    assert.equal(account.runtime.progressByTab['1'].collectionToken, started.progress.collectionToken);
    assert.equal(account.runtime.progressByTab['1'].status, 'running');
    assert.equal((await h.store.getTabBinding(1)).collectionToken, started.progress.collectionToken);
  });

test('the registered onMessage listener keeps the async sendResponse channel open for storage messages',
  { timeout: 5000 }, async () => {
    let listener;
    const localValues = {};
    const extensionId = 'listener-contract-test';
    globalThis.chrome = {
      runtime: { id: extensionId, getManifest: () => ({ version: '0.8.5' }), onMessage: {
        addListener(callback) { listener = callback; },
      } },
      storage: { local: {
        async get(key) { return Object.hasOwn(localValues, key) ? { [key]: structuredClone(localValues[key]) } : {}; },
        async set(values) { Object.assign(localValues, structuredClone(values)); },
      } },
      tabs: { async get() { throw new Error('unused'); } },
      scripting: { async executeScript() { throw new Error('unused'); } },
    };
    try {
      await import(`../extension-tracker/service-worker.js?listener-contract=${Date.now()}`);
      assert.equal(typeof listener, 'function');
      let resolveResponse;
      const responsePromise = new Promise(resolve => { resolveResponse = resolve; });
      const result = listener({ type: 'SITE_REQUEST_SLOT', endpoint: '/wapi/zpchat/geek/historyMsg' },
        { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }, resolveResponse);
      assert.equal(result, true, 'Chrome listener must return true while the promise-backed response is pending');
      const response = await responsePromise;
      assert.deepEqual(response, { ok: true, waitMs: 0 });
    } finally {
      delete globalThis.chrome;
    }
  });

test('same-tab concurrent starts and stop serialize around the page collector and token binding', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  let enteredResolve, releaseStart;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  page.startEntered = () => { enteredResolve(); page.startEntered = null; };
  page.startGate = new Promise(resolve => { releaseStart = resolve; });

  const firstStart = ui(h.handler, 'START_UPDATE', 1, { mode: 'incremental' });
  await entered;
  const secondStart = ui(h.handler, 'START_UPDATE', 1, { mode: 'full' });
  const stop = ui(h.handler, 'STOP_UPDATE', 1);
  releaseStart();
  page.startGate = null;
  const [first, second, stopped] = await Promise.all([firstStart, secondStart, stop]);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(second.progress.collectionToken, first.progress.collectionToken,
    'the second click reuses the still-running token');
  assert.equal(page.startCount, 1);
  const binding = await h.store.getTabBinding(1);
  assert.equal(binding.collectionToken, first.progress.collectionToken);
  assert.equal(page.collector.collectionToken, first.progress.collectionToken);
  assert.deepEqual(page.stopCalls, [first.progress.collectionToken]);
  assert.equal(stopped.progress.collectionToken, second.progress.collectionToken);
  assert.equal(stopped.progress.status, 'stopping');
  assert.equal(stopped.progress.active, true);
  const restartDuringDrain = await ui(h.handler, 'START_UPDATE', 1, { mode: 'incremental' });
  assert.equal(restartDuringDrain.error, 'COLLECTION_FINALIZING');
  assert.equal((await h.store.getTabBinding(1)).collectionToken, second.progress.collectionToken);

  const lateFirst = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: first.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'late-first-run', status: 'completed' } }, pageSender(1));
  assert.equal(lateFirst.ok, true, JSON.stringify(lateFirst));
  const drainedPage = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: second.progress.collectionToken, sessionId: second.progress.runId,
    snapshots: [snapshot('accountA', '停止收尾阶段已读取的消息')] }, pageSender(1));
  assert.equal(drainedPage.ok, true, JSON.stringify(drainedPage));
  assert.equal(Object.keys((await h.store.getAccount('accountA')).state.messages).length, 1);
  const currentToken = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: second.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'stopped-run-final', status: 'stopped', active: false,
      finishedAt: new Date().toISOString() } }, pageSender(1));
  assert.equal(currentToken.ok, true, JSON.stringify(currentToken));
  assert.equal(await h.store.getTabBinding(1), null);
  const lateSecond = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: second.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'after-final-stop', status: 'completed', active: false } }, pageSender(1));
  assert.equal(lateSecond.error, 'COLLECTION_TOKEN_REVOKED');
});

test('collector storage acknowledgements are independent of a pending action badge update',
  { timeout: 5000 }, async () => {
    const h = makeHarness();
    h.addPage(1, 'accountA');
    const started = await start(h.handler, 1);
    let releaseBadge, badgeStartedResolve;
    let badgeSettled = false;
    const badgeStarted = new Promise(resolve => { badgeStartedResolve = resolve; });
    h.chromeApi.action = { setBadgeText: () => new Promise(resolve => {
      badgeStartedResolve();
      releaseBadge = () => { badgeSettled = true; resolve(); };
    }),
      async setTitle() {} };

    const progressAck = h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
      collectionToken: started.progress.collectionToken,
      progress: { ...started.progress, runId: 'checkpoint-badge-hang', status: 'interrupted',
        state: 'interrupted', active: false, finalizing: true,
        errorCode: 'SITE_VERIFICATION_REQUIRED' } }, pageSender(1));

    let persisted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const root = h.values[ACCOUNT_RUNTIME_KEY];
      const progress = root?.accounts?.['account:accountA']?.runtime?.progressByTab?.['1'];
      if (progress?.runId === 'checkpoint-badge-hang') { persisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true, 'the terminal checkpoint must reach local storage before badge settling');

    try {
      await badgeStarted;
      const snapshotAck = h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
        collectionToken: started.progress.collectionToken,
        snapshots: [snapshot('accountA', 'badge-hang-message')] }, pageSender(1));
      const snapshotResult = await Promise.race([
        snapshotAck,
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'SNAPSHOT_ACK_TIMEOUT' }), 300)),
      ]);
      assert.equal(snapshotResult.ok, true, JSON.stringify(snapshotResult));
      assert.equal(badgeSettled, false, 'both storage responses are checked while the badge remains pending');

      const progressResult = await Promise.race([
        progressAck,
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'PROGRESS_ACK_TIMEOUT' }), 100)),
      ]);
      assert.equal(progressResult.ok, true,
        'BULK_PROGRESS acknowledgement should return once storage commits, without waiting for UI badge APIs');
    } finally {
      releaseBadge?.();
      await progressAck.catch(() => {});
    }
  });

test('collector storage acknowledgements are independent of a pending popup cache write',
  { timeout: 5000 }, async () => {
    const h = makeHarness();
    h.addPage(1, 'accountA');
    const started = await start(h.handler, 1);
    await new Promise(resolve => setTimeout(resolve, 20));

    const originalSet = h.chromeApi.storage.local.set.bind(h.chromeApi.storage.local);
    let releasePopupWrite, popupWriteStartedResolve;
    let popupWriteSettled = false;
    const popupWriteStarted = new Promise(resolve => { popupWriteStartedResolve = resolve; });
    h.chromeApi.storage.local.set = record => {
      if (!Object.hasOwn(record, POPUP_VIEW_KEY)) return originalSet(record);
      popupWriteStartedResolve();
      return new Promise(resolve => {
        releasePopupWrite = () => {
          popupWriteSettled = true;
          originalSet(record).then(resolve);
        };
      });
    };

    const progressAck = h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
      collectionToken: started.progress.collectionToken,
      progress: { ...started.progress, runId: 'checkpoint-popup-hang', status: 'running',
        state: 'running', active: true } }, pageSender(1));

    let persisted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const root = h.values[ACCOUNT_RUNTIME_KEY];
      const progress = root?.accounts?.['account:accountA']?.runtime?.progressByTab?.['1'];
      if (progress?.runId === 'checkpoint-popup-hang') { persisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true, 'the collector checkpoint must commit before popup cache work starts');

    try {
      await popupWriteStarted;
      const snapshotAck = h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
        collectionToken: started.progress.collectionToken,
        snapshots: [snapshot('accountA', 'popup-hang-message')] }, pageSender(1));
      const snapshotResult = await Promise.race([
        snapshotAck,
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'SNAPSHOT_ACK_TIMEOUT' }), 300)),
      ]);
      assert.equal(snapshotResult.ok, true, JSON.stringify(snapshotResult));

      const progressResult = await Promise.race([
        progressAck,
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'PROGRESS_ACK_TIMEOUT' }), 100)),
      ]);
      assert.equal(progressResult.ok, true,
        'BULK_PROGRESS acknowledgement should not wait for the derived popup cache write');
      assert.equal(popupWriteSettled, false, 'ACKs complete while the popup cache write remains pending');
    } finally {
      releasePopupWrite?.();
      await Promise.allSettled([progressAck]);
    }
  });

test('GET_BULK_PROGRESS persists a matching live terminal status under its token before returning it', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const started = await start(h.handler, 1);
  page.collector.progress = { ...page.collector.progress, status: 'failed', state: 'failed', active: false,
    errorCode: 'SITE_NON_JSON_RESPONSE', errorDetails: '网站返回了 HTML 页面，而不是 JSON。',
    error: '网站返回了 HTML 页面，而不是 JSON。', finishedAt: new Date().toISOString() };

  const result = await ui(h.handler, 'GET_BULK_PROGRESS', 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.accountUid, 'accountA');
  assert.equal(result.progress.status, 'failed');
  assert.equal(result.progress.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal(Object.hasOwn(result.progress, 'collectionToken'), false, 'popup progress does not expose collector tokens');
  assert.equal(Object.hasOwn(result.progress, 'accountUid'), false, 'account identity is carried by the local view');
  const account = await h.store.getAccount('accountA');
  assert.equal(account.runtime.progressByTab['1'].status, 'failed');
  assert.equal(account.runtime.progressByTab['1'].collectionToken, started.progress.collectionToken);
  assert.equal(account.baseline.previousProgress.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal(await h.store.getTabBinding(1), null);
  assert.equal(page.accountReadCount, 1, 'GET_BULK_PROGRESS does not refetch the BOSS account');
});

test('a terminal collector checkpoint cannot be overwritten by a delayed initial START_UPDATE response', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  let enteredResolve, releaseStart;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const gate = new Promise(resolve => { releaseStart = resolve; });
  page.startEntered = () => enteredResolve();
  page.startGate = gate;

  const starting = ui(h.handler, 'START_UPDATE', 1);
  await entered;
  const collectionToken = page.bindingSeenAtStart.collectionToken;
  const finalProgress = { ...page.collector.progress, status: 'failed', state: 'failed', active: false,
    errorCode: 'SITE_NON_JSON_RESPONSE', errorDetails: { httpStatus: 200, contentType: 'text/html' },
    finalizing: false, finishedAt: new Date().toISOString() };
  page.collector.progress = finalProgress;
  const terminal = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA', collectionToken,
    progress: finalProgress }, pageSender(1));
  assert.equal(terminal.ok, true, JSON.stringify(terminal));
  assert.equal(await h.store.getTabBinding(1) !== null, true, 'START owns the token until its initial response is saved');

  releaseStart();
  page.startGate = null;
  const started = await starting;
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.progress.status, 'failed');
  assert.equal(started.progress.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal((await h.store.getAccount('accountA')).baseline.previousProgress.status, 'failed');
  assert.equal(await h.store.getTabBinding(1), null);
});

test('a missing page collector becomes interrupted, preserves saved messages, and rejects late token writes', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  const started = await start(h.handler, 1);
  await start(h.handler, 2);
  const saved = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken, sessionId: started.progress.runId,
    snapshots: [snapshot('accountA', '已保存的合成消息')] }, pageSender(1));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  page.collector = null;

  const result = await ui(h.handler, 'GET_BULK_PROGRESS', 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.progress.status, 'interrupted');
  assert.equal(result.progress.active, false);
  assert.equal(result.progress.errorCode, 'COLLECTOR_UNAVAILABLE');
  const accountA = await h.store.getAccount('accountA');
  assert.equal(accountA.baseline.previousProgress.status, 'interrupted');
  assert.equal(Object.keys(accountA.state.messages).length, 1);
  assert.equal(Object.values(accountA.state.messages)[0].contentText, '已保存的合成消息');
  assert.equal(await h.store.getTabBinding(1), null);
  assert.equal((await h.store.getAccount('accountB')).baseline.previousProgress.status, 'running');

  const late = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'late', status: 'completed', active: false } }, pageSender(1));
  assert.equal(late.error, 'COLLECTION_TOKEN_REVOKED');
  assert.equal(Object.keys((await h.store.getAccount('accountA')).state.messages).length, 1);
});

test('the live finalizing marker holds a stopped token until the final checkpoint arrives', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const started = await start(h.handler, 1);
  page.collector.progress = { ...page.collector.progress, status: 'stopped', state: 'stopped',
    active: false, finalizing: true, stopRequested: true };

  const draining = await ui(h.handler, 'GET_BULK_PROGRESS', 1);
  assert.equal(draining.progress.status, 'stopping');
  assert.equal(draining.progress.active, true);
  assert.equal(draining.progress.finalizing, true);
  assert.equal((await h.store.getTabBinding(1)).collectionToken, started.progress.collectionToken);
  const retry = await ui(h.handler, 'START_UPDATE', 1, { mode: 'incremental' });
  assert.equal(retry.error, 'COLLECTION_FINALIZING');

  page.collector.progress = { ...page.collector.progress, status: 'stopped', state: 'stopped', active: false,
    finalizing: false, finishedAt: new Date().toISOString() };
  const final = await ui(h.handler, 'GET_BULK_PROGRESS', 1);
  assert.equal(final.progress.status, 'stopped');
  assert.equal(final.progress.finalizing, false);
  assert.equal(await h.store.getTabBinding(1), null);
});

test('STOP_UPDATE marks this account stopped and revokes its token when the tab is unavailable', async () => {
  const h = makeHarness();
  h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  const started = await start(h.handler, 1);
  await start(h.handler, 2);
  const saved = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken, sessionId: started.progress.runId,
    snapshots: [snapshot('accountA', '停止前已保存')] }, pageSender(1));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  h.tabs.delete(1);
  h.pages.delete(1);

  const stopped = await ui(h.handler, 'STOP_UPDATE', 1, { expectedAccountUid: 'accountA' });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.progress.status, 'stopped');
  assert.equal(stopped.progress.active, false);
  assert.equal(await h.store.getTabBinding(1), null);
  const accountA = await h.store.getAccount('accountA');
  assert.equal(accountA.baseline.previousProgress.status, 'stopped');
  assert.equal(Object.keys(accountA.state.messages).length, 1);
  assert.equal((await h.store.getAccount('accountB')).baseline.previousProgress.status, 'running');

  const late = await h.handler({ type: 'BULK_SNAPSHOTS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken, sessionId: 'late',
    snapshots: [snapshot('accountA', '不可写入的迟到消息')] }, pageSender(1));
  assert.equal(late.error, 'COLLECTION_TOKEN_REVOKED');
  assert.equal(Object.keys((await h.store.getAccount('accountA')).state.messages).length, 1);
});

test('the next START resolves A-to-B once, switches local view, and permanently revokes the old A token', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const first = await start(h.handler, 1);
  const aBaseline = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: first.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'a-baseline', status: 'completed', state: 'completed', active: false } }, pageSender(1));
  assert.equal(aBaseline.ok, true, JSON.stringify(aBaseline));
  h.addPage(2, 'accountB');
  const startedB = await start(h.handler, 2);
  const bBaseline = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountB',
    collectionToken: startedB.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'b-baseline', status: 'completed', state: 'completed', active: false } }, pageSender(2));
  assert.equal(bBaseline.ok, true, JSON.stringify(bBaseline));

  page.collector = null;
  page.uid = 'accountB';
  const readCountBeforeSwitch = page.accountReadCount;
  const switched = await start(h.handler, 1, 'incremental', 'accountA');
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.accountUid, 'accountB');
  assert.equal(page.accountReadCount, readCountBeforeSwitch + 1);
  assert.equal(page.startOptions.accountUid, 'accountB');
  assert.equal(page.startOptions.previous.runId, 'b-baseline');
  assert.notEqual(page.startOptions.previous.runId, 'a-baseline');
  assert.equal((await h.store.getTabBinding(1)).accountUid, 'accountB');

  const oldTokenInB = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: first.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'stale-in-b', status: 'completed' } }, pageSender(1));
  assert.equal(oldTokenInB.error, 'COLLECTION_TOKEN_REVOKED');
  const cachedB = await ui(h.handler, 'GET_STATE', 1);
  assert.equal(cachedB.accountUid, 'accountB');
  assert.equal(page.accountReadCount, readCountBeforeSwitch + 1);

  page.uid = 'accountA';
  const cachedAfterReturn = await ui(h.handler, 'GET_STATE', 1);
  assert.equal(cachedAfterReturn.accountUid, 'accountB', 'GET_STATE follows local popupView, not the site login');
  const oldTokenAfterReturn = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: first.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'stale-after-return', status: 'completed' } }, pageSender(1));
  assert.equal(oldTokenAfterReturn.error, 'COLLECTION_TOKEN_REVOKED');

  const localCount = page.accountReadCount;
  page.uid = null;
  assert.equal((await ui(h.handler, 'GET_STATE', 1)).accountUid, 'accountB');
  assert.equal(page.accountReadCount, localCount, 'an unknown site session does not cause background identity polling');
});

test('a clear submitted behind a slow start runs after it and cannot be overtaken by the delayed probe', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  let enteredResolve, releaseProbe;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const gate = new Promise(resolve => { releaseProbe = resolve; });
  page.readAccountHook = async () => {
    page.readAccountHook = null;
    enteredResolve();
    await gate;
    return { ok: true, value: { uid: 'accountA' } };
  };

  const starting = ui(h.handler, 'START_UPDATE', 1);
  await entered;
  const clearing = ui(h.handler, 'CLEAR_ACCOUNT', 1);
  releaseProbe();
  const [started, cleared] = await Promise.all([starting, clearing]);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.accountUid, 'accountA');
  assert.equal(await h.store.getAccount('accountA'), null);
  assert.equal(await h.store.getTabBinding(1), null);

  const late = await h.handler({ type: 'BULK_PROGRESS', accountUid: 'accountA',
    collectionToken: started.progress.collectionToken,
    progress: { kind: 'api_v1', runId: 'post-clear', status: 'completed' } }, pageSender(1));
  assert.equal(late.error, 'COLLECTION_TOKEN_REVOKED');
});

test('clear targets the confirmed local archive even when the live site account has changed', async () => {
  const h = makeHarness();
  const pageA = h.addPage(1, 'accountA');
  h.addPage(2, 'accountB');
  await start(h.handler, 1);
  await start(h.handler, 2);
  await h.store.updateAccount('accountA', partition => {
    partition.state.contacts.a = { identity: { bossId: 'a-only' } };
  });
  await h.store.updateAccount('accountB', partition => {
    partition.state.contacts.b = { identity: { bossId: 'b-only' } };
  });

  await start(h.handler, 1, 'incremental', 'accountA');
  const beforeClearReads = pageA.accountReadCount;
  pageA.uid = 'accountB';
  const attempted = await ui(h.handler, 'CLEAR_ACCOUNT', 1, { expectedAccountUid: 'accountA' });
  assert.equal(attempted.ok, true, JSON.stringify(attempted));
  assert.equal(attempted.accountUid, 'accountA');
  assert.equal(pageA.accountReadCount, beforeClearReads, 'local account clearing does not query the site');
  assert.equal(await h.store.getAccount('accountA'), null);
  assert.equal((await h.store.getAccount('accountB')).state.contacts.b.identity.bossId, 'b-only');

  const missingExpected = await h.handler({ type: 'CLEAR_ACCOUNT', tabId: 1 }, popupSender);
  assert.equal(missingExpected.error, 'EXPECTED_ACCOUNT_UID_REQUIRED');
});

test('popup freezes the selected local archive UID before tab lookup and ignores a late clear result', async () => {
  const elements = new Map();
  const ids = ['#account', '#contact-count', '#message-count', '#progress', '#status', '#refresh',
    '#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup', '#clear'];
  for (const id of ids) elements.set(id, {
    id, textContent: '', disabled: true, listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
  });
  let queryCount = 0, releaseClearTabQuery, clearTabQueryStarted, clearMessage = null, notifyClearMessage;
  const queryGate = new Promise(resolve => { releaseClearTabQuery = resolve; });
  const queryStarted = new Promise(resolve => { clearTabQueryStarted = resolve; });
  const clearSent = new Promise(resolve => { notifyClearMessage = resolve; });
  const storageKey = 'bossReadonlyTracker.popupView.v1';
  const view = (accountUid, contactCount, messageCount) => ({ accountUid,
    summary: { contactCount, messageCount, unidentifiedObservationCount: 0 }, progress: null,
    verificationRequired: false, verificationRetrying: false, updatedAt: new Date().toISOString() });
  let localView = view('accountA', 4, 40);
  const source = readFileSync(new URL('../extension-tracker/popup.js', import.meta.url), 'utf8');
  const context = {
    document: {
      querySelector: selector => elements.get(selector) || null,
      querySelectorAll: selector => selector === '.actions button'
        ? ['#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup']
          .map(id => elements.get(id)) : [],
      createElement: () => ({ append() {}, click() {}, remove() {} }),
      body: { append() {} },
    },
    window: { confirm: () => true, addEventListener() {} },
    chrome: {
      tabs: { query: async () => {
        queryCount++;
        if (queryCount === 1) { clearTabQueryStarted(); return queryGate; }
        return [{ id: 1 }];
      } },
      storage: { local: { get: async key => key === storageKey ? { [storageKey]: structuredClone(localView) } : {} } },
      runtime: { sendMessage: async message => {
        if (message.type === 'CLEAR_ACCOUNT') {
          clearMessage = structuredClone(message);
          notifyClearMessage();
          return { ok: true, accountUid: 'accountA', cleared: true,
            summary: { contactCount: 0, messageCount: 0, unidentifiedObservationCount: 0 },
            view: view('accountA', 0, 0) };
        }
        throw new Error(`Unexpected popup request ${message.type}`);
      } },
    },
    setTimeout: (handler, delay) => {
      if (delay === 5000 || delay === 10000) return `timer-${delay}`;
      return setTimeout(handler, delay);
    },
    clearTimeout: timer => { if (typeof timer !== 'string') clearTimeout(timer); },
    URL,
    Blob,
  };
  vm.runInNewContext(source, context, { filename: 'popup.js' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(elements.get('#account').textContent, 'accountA');

  elements.get('#clear').listeners.get('click')();
  await queryStarted;
  localView = view('accountB', 2, 20);
  await elements.get('#refresh').listeners.get('click')();
  assert.equal(elements.get('#account').textContent, 'accountB');
  assert.equal(elements.get('#contact-count').textContent, '2');

  releaseClearTabQuery([{ id: 1 }]);
  await clearSent;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(clearMessage.expectedAccountUid, 'accountA');
  assert.equal(clearMessage.type, 'CLEAR_ACCOUNT');
  assert.equal(queryCount, 1);
  assert.equal(elements.get('#account').textContent, 'accountB');
  assert.equal(elements.get('#contact-count').textContent, '2');
  assert.equal(elements.get('#clear').disabled, false);
});
