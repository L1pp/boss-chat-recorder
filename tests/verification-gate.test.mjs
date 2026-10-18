import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStore } from '../extension-tracker/account-store.mjs';
import { createExtensionMessageHandler } from '../extension-tracker/service-worker.js';

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const popupSender = { id: 'verification-test', url: 'chrome-extension://verification-test/popup.html' };

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeHarness() {
  const values = {};
  const pages = new Map();
  const tabs = new Map();
  const badges = new Map();
  const storage = {
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
  const chromeApi = {
    runtime: { id: 'verification-test', getManifest: () => ({ version: '0.8.5', name: 'BOSS沟通记录' }) },
    storage: { local: storage },
    tabs: { async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('TAB_NOT_AVAILABLE');
      return clone(tab);
    } },
    action: {
      async setBadgeText({ tabId, text }) { badges.set(tabId, { ...(badges.get(tabId) || {}), text }); },
      async setTitle({ tabId, title }) { badges.set(tabId, { ...(badges.get(tabId) || {}), title }); },
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
          if (page.verificationRequiredForAccount) {
            return [{ result: { ok: false, error: 'SITE_VERIFICATION_REQUIRED' } }];
          }
          return [{ result: { ok: true, value: { uid: page.uid } } }];
        }
        if (func?.name === 'pageStartCollection') {
          const options = clone(args[0]);
          page.startOptions = options;
          page.startCount++;
          const progress = { kind: 'api_v1', runId: `run-${options.accountUid}-${target.tabId}-${page.startCount}`,
            accountUid: options.accountUid, collectionToken: options.collectionToken,
            status: 'running', state: 'running', active: true, discovered: 0, completed: 0,
            historyResults: {}, updatedAt: new Date().toISOString() };
          page.collector = { accountUid: options.accountUid, collectionToken: options.collectionToken, progress };
          return [{ result: clone(progress) }];
        }
        if (func?.name === 'pageCollectorStatus') return [{ result: clone(page.collector?.progress || null) }];
        if (func?.name === 'pageStopCollectionBound') {
          if (page.collector?.accountUid !== args[0] || page.collector?.collectionToken !== args[1]) {
            return [{ result: null }];
          }
          page.stopCalls.push(page.collector.collectionToken);
          page.collector.progress = { ...page.collector.progress, status: 'stopped', state: 'stopped',
            active: false, finalizing: false, finishedAt: new Date().toISOString() };
          return [{ result: clone(page.collector.progress) }];
        }
        throw new Error(`Unexpected injected function: ${func?.name}`);
      },
    },
  };

  const handler = createExtensionMessageHandler(chromeApi, { requestIntervalMs: 0 });
  function addPage(tabId, uid) {
    const page = { uid, accountReadCount: 0, startCount: 0, startOptions: null, collector: null,
      stopCalls: [], loadedFiles: [], verificationRequiredForAccount: false };
    pages.set(tabId, page);
    tabs.set(tabId, { id: tabId, url: CHAT_URL });
    return page;
  }
  return { chromeApi, values, pages, tabs, badges, addPage, handler,
    store: createAccountStore(chromeApi) };
}

function pageSender(tabId) {
  return { id: 'verification-test', url: CHAT_URL, tab: { id: tabId, url: CHAT_URL } };
}

async function ui(harness, type, tabId, fields = {}) {
  const page = harness.pages.get(tabId);
  const message = { type, ...fields };
  if (tabId !== undefined) message.tabId = tabId;
  if (type !== 'GET_STATE' && page && message.expectedAccountUid === undefined) {
    message.expectedAccountUid = page.uid;
  }
  return harness.handler(message, popupSender);
}

async function start(harness, tabId, type = 'START_UPDATE') {
  const result = await ui(harness, type, tabId, { mode: 'incremental' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function snapshot(accountUid, messageId, contentText) {
  return {
    selfUid: accountUid, captureMode: 'api_history', captureTransport: 'history_api',
    page: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat',
      capturedAt: new Date().toISOString() },
    list: { rows: [{ active: true, bossId: `hr-${accountUid}`, company: '演示公司', hrName: '演示 HR' }] },
    messages: { items: [{ messageId, kind: 'text', direction: 'hr', contentText, text: contentText,
      sentAtISO: new Date().toISOString() }] },
    historyCoverage: { availableHistoryComplete: true, startReached: true, hasMore: false },
  };
}

async function sendProgress(harness, tabId, accountUid, token, progress) {
  const page = harness.pages.get(tabId);
  if (page.collector?.collectionToken === token) page.collector.progress = clone(progress);
  return harness.handler({ type: 'BULK_PROGRESS', accountUid, collectionToken: token, progress }, pageSender(tabId));
}

async function sendHistory(harness, tabId, accountUid, token, messageId, contentText) {
  return harness.handler({ type: 'BULK_SNAPSHOTS', accountUid, collectionToken: token,
    snapshots: [snapshot(accountUid, messageId, contentText)] }, pageSender(tabId));
}

test('verification is a terminal progress error; the user can continue through the same START path', async () => {
  const h = makeHarness();
  const page = h.addPage(1, 'accountA');
  const first = await start(h, 1);
  const saved = await sendHistory(h, 1, 'accountA', first.progress.collectionToken,
    'before-verification', '验证前已保存');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const completed = await sendProgress(h, 1, 'accountA', first.progress.collectionToken,
    { ...page.collector.progress, status: 'completed', state: 'completed', active: false,
      finishedAt: new Date().toISOString() });
  assert.equal(completed.ok, true, JSON.stringify(completed));

  const blockedRun = await start(h, 1);
  const paused = await sendProgress(h, 1, 'accountA', blockedRun.progress.collectionToken,
    { ...blockedRun.progress, status: 'failed', state: 'failed', active: false,
      errorCode: 'SITE_VERIFICATION_REQUIRED', error: '请先完成验证。',
      finishedAt: new Date().toISOString() });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  let state = await ui(h, 'GET_STATE', 1);
  assert.equal(state.verificationRequired, true);
  assert.equal(state.verificationRetrying, false);
  assert.equal(state.progress.errorCode, 'SITE_VERIFICATION_REQUIRED');
  assert.equal(Object.hasOwn((await h.store.getAccount('accountA')).runtime, 'verificationRequired'), false,
    'new runs do not create a separate verification gate');
  assert.equal(h.badges.get(1).text, '验');
  assert.equal(page.startCount, 2, 'a verification response does not start another collection');

  const continued = await start(h, 1, 'RESUME_AFTER_VERIFICATION');
  assert.notEqual(continued.progress.collectionToken, blockedRun.progress.collectionToken);
  state = await ui(h, 'GET_STATE', 1);
  assert.equal(state.verificationRequired, false);
  assert.equal(state.verificationRetrying, false);
  assert.equal(h.badges.get(1).text, '');
  assert.equal(Object.keys((await h.store.getAccount('accountA')).state.messages).length, 1,
    'manual continuation keeps previously saved messages');

  const repeatedPause = await sendProgress(h, 1, 'accountA', continued.progress.collectionToken,
    { ...continued.progress, status: 'failed', state: 'failed', active: false,
      errorCode: 'SITE_VERIFICATION_REQUIRED', finishedAt: new Date().toISOString() });
  assert.equal(repeatedPause.ok, true, JSON.stringify(repeatedPause));
  state = await ui(h, 'GET_BULK_PROGRESS', 1);
  assert.equal(state.verificationRequired, true, 'the next verification error pauses the new run again');
  assert.equal(state.verificationRetrying, false);
  assert.equal(page.startCount, 3, 'the worker never retries after the verification response');
});

test('START returns the same live token without another account request, while a new manual START clears only stale legacy metadata', async () => {
  const h = makeHarness();
  const pageA = h.addPage(1, 'accountA');
  const pageB = h.addPage(2, 'accountB');
  const startedA = await start(h, 1);
  const reusedA = await start(h, 1);
  assert.equal(reusedA.progress.collectionToken, startedA.progress.collectionToken);
  assert.equal(pageA.startCount, 1);
  assert.equal(pageA.accountReadCount, 1, 'an existing live run is checked locally before userinfo');

  await h.store.updateAccount('accountA', partition => {
    partition.runtime.verificationRequired = { required: true, accountUid: 'accountA', retrying: true };
  });
  await h.store.updateAccount('accountB', partition => {
    partition.runtime.verificationRequired = { required: true, accountUid: 'accountB', retrying: true };
  });
  const aBefore = await h.store.getAccount('accountA');
  const bBefore = await h.store.getAccount('accountB');
  const aMessage = await sendHistory(h, 1, 'accountA', startedA.progress.collectionToken,
    'kept-a', 'A账号本地记录');
  assert.equal(aMessage.ok, true, JSON.stringify(aMessage));

  const startedB = await start(h, 2);
  assert.equal(startedB.accountUid, 'accountB');
  const aAfter = await h.store.getAccount('accountA');
  const bAfter = await h.store.getAccount('accountB');
  assert.equal(Object.keys(aAfter.state.messages).length, 1);
  assert.equal(Object.hasOwn(aAfter.runtime, 'verificationRequired'), true,
    'starting another account cannot clear A legacy metadata');
  assert.equal(Object.hasOwn(bAfter.runtime, 'verificationRequired'), false,
    'a manual new start clears only that account’s old compatibility marker');
  assert.ok(bAfter.baseline.previousProgress);
  assert.equal(pageB.accountReadCount, 1);
  assert.equal(aBefore.accountUid, 'accountA');
  assert.equal(bBefore.accountUid, 'accountB');
});

test('an identity probe blocked by a verification page reports only the error and does not create a cached-account pause', async () => {
  const h = makeHarness();
  const page = h.addPage(3, 'accountC');
  await h.store.getOrCreateAccount('accountC');
  await ui(h, 'GET_STATE', 3, { expectedAccountUid: 'accountC' });
  page.verificationRequiredForAccount = true;

  const result = await ui(h, 'START_UPDATE', 3);
  assert.equal(result.error, 'SITE_VERIFICATION_REQUIRED');
  assert.equal(Object.hasOwn(result, 'accountUid'), false);
  assert.equal((await h.store.getAccount('accountC')).runtime.verificationRequired, undefined);
  assert.equal(page.startCount, 0);
});

