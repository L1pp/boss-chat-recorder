import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as popupI18n from '../extension-tracker/i18n.mjs';

const source = readFileSync(new URL('../extension-tracker/popup.js', import.meta.url), 'utf8')
  .replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/i18n\.mjs['"];?\s*/mu, '');
const html = readFileSync(new URL('../extension-tracker/popup.html', import.meta.url), 'utf8');
const POPUP_VIEW_KEY = 'bossReadonlyTracker.popupView.v1';
const LANGUAGE_KEY = popupI18n.LANGUAGE_STORAGE_KEY;
const initialStorageKeys = [POPUP_VIEW_KEY, LANGUAGE_KEY];
const ids = ['#account', '#account-card', '#contact-count', '#message-count', '#progress-card', '#progress',
  '#status', '#refresh', '#counts', '#first-run-guide', '#export-actions', '#record-tools', '#update-incremental', '#update-full', '#stop',
  '#export-latest', '#export-all', '#backup', '#clear', '#language-select', '#language-status'];

function makePopup({ popupView = null, uiLanguage = 'zh-CN', preference, storageData = {},
  storageSet = async () => {}, storageGet = null, confirm = () => true,
  sendMessage = async () => ({ ok: false, error: 'UNEXPECTED_MESSAGE' }) } = {}) {
  const elements = new Map(ids.map(id => [id, {
    id, textContent: '', disabled: true,
    hidden: ['#account-card', '#progress-card', '#counts', '#first-run-guide', '#update-full', '#stop',
      '#export-actions', '#record-tools'].includes(id),
    listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
  }]));
  const staticElements = [];
  for (const tag of html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*)>/gu)) {
    const attributes = Object.fromEntries([...tag[1].matchAll(/([a-z0-9-]+)="([^"]*)"/gu)]
      .map(match => [match[1], match[2]]));
    if (!Object.keys(attributes).some(name => name.startsWith('data-i18n'))) continue;
    const element = elements.get(`#${attributes.id}`) || {
      textContent: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
    Object.assign(element.attributes, attributes);
    staticElements.push(element);
  }
  const timers = new Map();
  const runtimeMessages = [];
  const storageKeys = [];
  const storageWrites = [];
  if (preference !== undefined) storageData[LANGUAGE_KEY] = preference;
  let nextTimer = 0;
  const context = {
    ...popupI18n,
    document: {
      documentElement: { lang: 'zh-CN' },
      title: '',
      querySelector: selector => elements.get(selector) || null,
      querySelectorAll: selector => selector === '.actions button'
        ? ['#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup']
          .map(id => elements.get(id)) : staticElements.filter(element =>
            Object.hasOwn(element.attributes, selector.slice(1, -1))),
      createElement: () => ({ append() {}, click() {}, remove() {} }),
      body: { append() {} },
    },
    window: { confirm, addEventListener() {} },
    chrome: {
      i18n: { getUILanguage: () => uiLanguage },
      tabs: { query: async () => [{ id: 7 }] },
      runtime: { async sendMessage(message) { runtimeMessages.push(message); return sendMessage(message); } },
      storage: { local: { async get(key) {
        storageKeys.push(Array.isArray(key) ? [...key] : key);
        return storageGet ? storageGet(key) : { ...storageData, [POPUP_VIEW_KEY]: popupView };
      }, async set(record) {
        const value = Object.fromEntries(Object.entries(record));
        storageWrites.push(value);
        await storageSet(value);
        Object.assign(storageData, value);
      } } },
    },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { id, fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    URL,
    Blob,
  };
  vm.runInNewContext(source, context, { filename: 'popup.js' });
  return {
    elements, timers, runtimeMessages, storageKeys, storageWrites, storageData, document: context.document,
    async selectLanguage(value) {
      elements.get('#language-select').value = value;
      await elements.get('#language-select').listeners.get('change')();
    },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    async fireTimer(timer) { timers.delete(timer.id); return timer.fn(); },
  };
}

function view(accountUid, contactCount = 0, messageCount = 0, progress = null,
  updatedAt = '2026-10-17T12:00:00.000Z', history = undefined) {
  return { accountUid, summary: { contactCount, messageCount }, progress,
    hasCollectionHistory: history ?? (Boolean(progress) || contactCount > 0 || messageCount > 0),
    verificationRequired: progress?.verificationRequired ?? false, updatedAt };
}

test('opening and manually refreshing reads only the lightweight local view; polling stays local and UID scoped', async () => {
  let progress = null;
  const popup = makePopup({
    popupView: view('accountA', 2, 8),
    sendMessage: async message => {
      assert.equal(message.type, 'GET_BULK_PROGRESS');
      progress = { kind: 'api_v1', status: 'completed', state: 'completed', active: false };
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 2, messageCount: 8 }, progress };
    },
  });
  await popup.settle();

  assert.deepEqual(popup.storageKeys, [initialStorageKeys]);
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.match(popup.elements.get('#status').textContent, /本地记录缓存/);
  assert.equal(popup.elements.get('#contact-count').textContent, '2');
  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
  assert.equal(popup.elements.get('#account-card').hidden, false);
  assert.equal(popup.elements.get('#progress-card').hidden, false);
  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.elements.get('#export-actions').hidden, false);
  assert.equal(popup.elements.get('#stop').hidden, true, 'idle views do not show an unavailable stop action');
  assert.equal(popup.runtimeMessages.length, 0, 'opening the popup must not send a worker or site request');

  const timer = [...popup.timers.values()].find(item => item.delay === 10000);
  assert.ok(timer);
  await popup.fireTimer(timer);
  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.runtimeMessages[0].type, 'GET_BULK_PROGRESS');
  assert.equal(popup.runtimeMessages[0].expectedAccountUid, 'accountA');

  await popup.elements.get('#refresh').listeners.get('click')();
  assert.deepEqual(popup.storageKeys, [initialStorageKeys, POPUP_VIEW_KEY]);
  assert.equal(popup.runtimeMessages.length, 1, 'manual refresh must reread local cache only');
});

test('first-run view explains collection, hides unrelated controls, then sends the existing incremental start once', async () => {
  const popup = makePopup({ popupView: null,
    sendMessage: async message => {
      if (message.type === 'GET_STATE') return { ok: false, error: 'ACCOUNT_UID_REQUIRED' };
      assert.equal(message.type, 'START_UPDATE');
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
        progress: { kind: 'api_v1', status: 'running', state: 'running', active: true, runId: 'first-run' },
        verificationRequired: false, updatedAt: '2026-10-17T12:10:00.000Z' };
    } });
  await popup.settle();
  assert.equal(popup.elements.get('#update-incremental').textContent, '开始首次采集');
  assert.equal(popup.elements.get('#first-run-guide').hidden, false);
  assert.match(popup.elements.get('#status').textContent, /打开 BOSS 直聘沟通页/);
  assert.equal(popup.elements.get('#account-card').hidden, true);
  assert.equal(popup.elements.get('#progress-card').hidden, true);
  assert.equal(popup.elements.get('#counts').hidden, true);
  assert.equal(popup.elements.get('#update-full').hidden, true);
  assert.equal(popup.elements.get('#stop').hidden, true);
  assert.equal(popup.elements.get('#export-actions').hidden, true);
  assert.equal(popup.elements.get('#record-tools').hidden, true);
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.runtimeMessages[0].type, 'GET_STATE');
  assert.equal(Object.hasOwn(popup.runtimeMessages[0], 'tabId'), false,
    'legacy local initialization does not probe the active tab');
  assert.equal(Object.hasOwn(popup.runtimeMessages[0], 'expectedAccountUid'), false);

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(popup.runtimeMessages.length, 2);
  assert.equal(Object.hasOwn(popup.runtimeMessages[1], 'expectedAccountUid'), false);
  assert.equal(popup.runtimeMessages[1].type, 'START_UPDATE');
  assert.equal(popup.runtimeMessages[1].mode, 'incremental');
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.equal(popup.elements.get('#contact-count').textContent, '0');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.elements.get('#update-incremental').textContent, '正在采集');
  assert.match(popup.elements.get('#progress').textContent, /正在采集/);
  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.runtimeMessages.filter(message => message.type === 'GET_STATE').length, 1,
    'successful first start must not post-read GET_STATE');

  const cachedEmpty = makePopup({ popupView: view('accountA', 0, 0) });
  await cachedEmpty.settle();
  assert.equal(cachedEmpty.elements.get('#first-run-guide').hidden, false);
  assert.equal(cachedEmpty.elements.get('#account-card').hidden, true);
  assert.equal(cachedEmpty.elements.get('#progress-card').hidden, true);
  assert.equal(cachedEmpty.elements.get('#status').textContent, '准备好后，点击下方按钮开始。');
});

test('a failed first START keeps its specific error and allows the same local first-start entry to retry', async () => {
  let getStateCalls = 0;
  let startCalls = 0;
  const popup = makePopup({ popupView: null, sendMessage: async message => {
    if (message.type === 'GET_STATE') {
      getStateCalls++;
      return { ok: false, error: 'ACCOUNT_UID_REQUIRED' };
    }
    assert.equal(message.type, 'START_UPDATE');
    startCalls++;
    if (startCalls === 1) return { ok: false, error: 'UNSUPPORTED_PAGE' };
    return { ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
      progress: { kind: 'api_v1', status: 'running', state: 'running', active: true, runId: 'retry-run' } };
  } });
  await popup.settle();

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.match(popup.elements.get('#status').textContent, /请打开 BOSS 直聘沟通页/);
  assert.equal(popup.elements.get('#first-run-guide').hidden, true,
    'the concrete unsupported-page error replaces the welcome guide');
  assert.equal(popup.elements.get('#update-incremental').textContent, '开始首次采集');
  assert.equal(popup.elements.get('#update-incremental').disabled, false,
    'the failed first start remains retryable after the mutation lock releases');
  assert.equal(getStateCalls, 1);
  assert.equal(startCalls, 1);

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(getStateCalls, 1, 'retry uses the existing start path without another state lookup');
  assert.equal(startCalls, 2);
  assert.equal(popup.runtimeMessages.filter(message => message.type === 'START_UPDATE')
    .every(message => message.mode === 'incremental' && !Object.hasOwn(message, 'expectedAccountUid')), true);
  assert.equal(popup.elements.get('#update-incremental').textContent, '正在采集');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
});

test('existing local polling exits the first-run view for running, verification, paused, and completed states', async () => {
  async function popupAfterFirstRunPoll(progress) {
    const popup = makePopup({ popupView: view('accountA', 0, 0), sendMessage: async message => {
      assert.equal(message.type, 'GET_BULK_PROGRESS');
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 }, progress };
    } });
    await popup.settle();
    assert.equal(popup.elements.get('#first-run-guide').hidden, false);
    assert.equal(popup.elements.get('#progress-card').hidden, true);
    const timer = [...popup.timers.values()].find(item => item.delay === 10000);
    assert.ok(timer);
    await popup.fireTimer(timer);
    assert.deepEqual(popup.runtimeMessages.map(message => message.type), ['GET_BULK_PROGRESS']);
    return popup;
  }

  const running = await popupAfterFirstRunPoll({
    kind: 'api_v1', status: 'running', state: 'running', active: true,
  });
  assert.equal(running.elements.get('#first-run-guide').hidden, true);
  assert.equal(running.elements.get('#progress-card').hidden, false);
  assert.equal(running.elements.get('#stop').hidden, false);
  assert.equal(running.elements.get('#stop').disabled, false);
  assert.equal(running.elements.get('#update-incremental').disabled, true);
  assert.match(running.elements.get('#progress').textContent, /正在采集/);
  assert.match(running.elements.get('#status').textContent, /首次采集已启动/);

  const stopping = await popupAfterFirstRunPoll({
    kind: 'api_v1', status: 'stopping', state: 'stopping', active: true, finalizing: true,
  });
  assert.equal(stopping.elements.get('#first-run-guide').hidden, true);
  assert.equal(stopping.elements.get('#progress-card').hidden, false);
  assert.match(stopping.elements.get('#progress').textContent, /正在保存停止前已读取的内容/);
  assert.match(stopping.elements.get('#status').textContent, /正在保存停止前已读取的内容/);
  assert.equal(stopping.elements.get('#update-incremental').disabled, true);
  assert.equal(stopping.elements.get('#stop').hidden, false);
  assert.equal(stopping.elements.get('#stop').disabled, false);

  const verification = await popupAfterFirstRunPoll({
    kind: 'api_v1', status: 'interrupted', state: 'interrupted', active: false,
    errorCode: 'SITE_VERIFICATION_REQUIRED', verificationRequired: true,
  });
  assert.equal(verification.elements.get('#first-run-guide').hidden, true);
  assert.equal(verification.elements.get('#progress-card').hidden, false);
  assert.equal(verification.elements.get('#update-incremental').textContent, '我已完成验证，继续采集');
  assert.match(verification.elements.get('#status').textContent, /BOSS 要求人工验证/);

  const paused = await popupAfterFirstRunPoll({
    kind: 'api_v1', status: 'paused', state: 'paused', active: false,
  });
  assert.equal(paused.elements.get('#first-run-guide').hidden, true);
  assert.equal(paused.elements.get('#progress-card').hidden, false);
  assert.equal(paused.elements.get('#update-incremental').textContent, '继续上次采集');
  assert.match(paused.elements.get('#status').textContent, /采集已暂停/);

  const completed = await popupAfterFirstRunPoll({
    kind: 'api_v1', status: 'completed', state: 'completed', active: false,
  });
  assert.equal(completed.elements.get('#first-run-guide').hidden, true);
  assert.equal(completed.elements.get('#progress-card').hidden, false);
  assert.equal(completed.elements.get('#contact-count').textContent, '0');
  assert.equal(completed.elements.get('#message-count').textContent, '0');
  assert.equal(completed.elements.get('#update-incremental').textContent, '更新变化会话');
  assert.match(completed.elements.get('#status').textContent, /首次采集已完成/);
});

test('a completed empty collection is history, not a first-run prompt', async () => {
  const popup = makePopup({ popupView: view('accountA', 0, 0,
    { kind: 'api_v1', status: 'completed', state: 'completed', active: false }) });
  await popup.settle();

  assert.equal(popup.elements.get('#contact-count').textContent, '0');
  assert.equal(popup.elements.get('#message-count').textContent, '0');
  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
  assert.equal(popup.elements.get('#export-actions').hidden, false);
});

test('account history keeps a zero-count view out of first-run when this tab has no progress', async () => {
  const popup = makePopup({ popupView: view('accountA', 0, 0, null,
    '2026-10-17T12:00:00.000Z', true), sendMessage: async message => {
    assert.equal(message.type, 'GET_BULK_PROGRESS');
    return { ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
      progress: null, hasCollectionHistory: true };
  } });
  await popup.settle();
  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
  const timer = [...popup.timers.values()].find(item => item.delay === 10000);
  assert.ok(timer);
  await popup.fireTimer(timer);
  assert.equal(popup.runtimeMessages.map(message => message.type).join(','), 'GET_BULK_PROGRESS');
  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.elements.get('#progress-card').hidden, false);
  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
});

test('an old zero-count cache without collection history is unknown, not a confirmed first run', async () => {
  const popup = makePopup({ popupView: {
    accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 }, progress: null,
    verificationRequired: false, updatedAt: '2026-10-17T12:00:00.000Z',
  } });
  await popup.settle();

  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.equal(popup.elements.get('#update-incremental').textContent, '开始采集');
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
});

test('paused, verification, and finalizing states retain their distinct actions', async () => {
  const paused = makePopup({ popupView: view('accountA', 0, 0,
    { kind: 'api_v1', status: 'paused', state: 'paused', active: false }) });
  await paused.settle();
  assert.equal(paused.elements.get('#update-incremental').textContent, '继续上次采集');
  assert.equal(paused.elements.get('#stop').hidden, true);
  assert.equal(paused.elements.get('#first-run-guide').hidden, true);

  const verification = makePopup({ popupView: view('accountA', 0, 0, {
    kind: 'api_v1', status: 'interrupted', state: 'interrupted', active: false,
    errorCode: 'SITE_VERIFICATION_REQUIRED', verificationRequired: true,
  }) });
  await verification.settle();
  assert.equal(verification.elements.get('#update-incremental').textContent, '我已完成验证，继续采集');
  assert.equal(verification.elements.get('#update-full').hidden, true);
  assert.match(verification.elements.get('#progress').textContent, /BOSS 要求人工验证/);

  const finalizing = makePopup({ popupView: view('accountA', 0, 0, {
    kind: 'api_v1', status: 'stopping', state: 'stopping', active: true, finalizing: true,
  }) });
  await finalizing.settle();
  assert.equal(finalizing.elements.get('#update-incremental').textContent, '正在保存采集内容');
  assert.equal(finalizing.elements.get('#update-incremental').disabled, true);
  assert.equal(finalizing.elements.get('#stop').hidden, false);
  assert.equal(finalizing.elements.get('#stop').disabled, false,
    'the existing stop control remains available while accepted records are being saved');
  assert.equal(finalizing.elements.get('#update-full').hidden, true);
});

test('errors and unknown counts are not replaced by first-run zero counts', async () => {
  const failed = makePopup({ popupView: view('accountA', 0, 0, {
    kind: 'api_v1', status: 'failed', state: 'failed', active: false, errorCode: 'ARCHIVE_DECRYPT_FAILED',
  }) });
  await failed.settle();
  assert.equal(failed.elements.get('#first-run-guide').hidden, true);
  assert.match(failed.elements.get('#progress').textContent, /本地归档解密失败/);

  const unknown = makePopup({ popupView: {
    accountUid: 'accountA', summary: { contactCount: null, messageCount: null }, progress: null,
  } });
  await unknown.settle();
  assert.equal(unknown.elements.get('#contact-count').textContent, '—');
  assert.equal(unknown.elements.get('#message-count').textContent, '—');
  assert.equal(unknown.elements.get('#first-run-guide').hidden, true);
});

test('an unsupported page keeps its error state and opening the popup still only performs the existing local lookup', async () => {
  const popup = makePopup({ popupView: null, sendMessage: async message => {
    assert.equal(message.type, 'GET_STATE');
    return { ok: false, error: 'UNSUPPORTED_PAGE' };
  } });
  await popup.settle();

  assert.equal(popup.elements.get('#first-run-guide').hidden, true);
  assert.match(popup.elements.get('#status').textContent, /打开 BOSS 直聘沟通页/);
  assert.deepEqual(popup.runtimeMessages.map(message => message.type), ['GET_STATE']);
  assert.deepEqual(popup.storageKeys, [initialStorageKeys]);
});

test('a view refresh during a pending first start clears its temporary label and keeps the newer account view', async () => {
  let resolveStart;
  const startGate = new Promise(resolve => { resolveStart = resolve; });
  const localView = view('accountA', 0, 0);
  const popup = makePopup({ popupView: localView, sendMessage: async message => {
    assert.equal(message.type, 'START_UPDATE');
    return startGate;
  } });
  await popup.settle();
  assert.equal(popup.elements.get('#first-run-guide').hidden, false);

  const pendingStart = popup.elements.get('#update-incremental').listeners.get('click')();
  await popup.settle();
  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.elements.get('#update-incremental').textContent, '正在启动首次采集…');

  localView.accountUid = 'accountB';
  localView.summary = { contactCount: 4, messageCount: 20 };
  localView.progress = { kind: 'api_v1', status: 'running', state: 'running', active: true };
  localView.verificationRequired = false;
  await popup.elements.get('#refresh').listeners.get('click')();
  assert.equal(popup.elements.get('#account').textContent, 'accountB');
  assert.equal(popup.elements.get('#contact-count').textContent, '4');
  assert.equal(popup.elements.get('#message-count').textContent, '20');
  assert.equal(popup.elements.get('#update-incremental').textContent, '正在更新');

  resolveStart({ ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
    progress: { kind: 'api_v1', status: 'running', state: 'running', active: true } });
  await pendingStart;
  assert.equal(popup.elements.get('#account').textContent, 'accountB',
    'the stale START response cannot replace the refreshed account view');
  assert.equal(popup.elements.get('#contact-count').textContent, '4');
  assert.equal(popup.elements.get('#update-incremental').textContent, '正在更新',
    'the prior first-collection label is scoped to its request and does not leak');
  assert.equal(popup.runtimeMessages.length, 1, 'view refresh and stale response add no request');
});

test('interrupted, stopped, and failed collections can resume at zero or nonzero counts', async () => {
  for (const state of ['interrupted', 'stopped', 'failed']) {
    for (const [contacts, messages] of [[0, 0], [3, 15]]) {
      const popup = makePopup({ popupView: view('accountA', contacts, messages, {
        kind: 'api_v1', status: state, state, active: false,
      }) });
      await popup.settle();
      assert.equal(popup.elements.get('#update-incremental').textContent, '继续上次采集', `${state} ${contacts}/${messages}`);
      assert.equal(popup.elements.get('#update-incremental').disabled, false, `${state} remains retryable`);
      assert.equal(popup.elements.get('#stop').hidden, true, `${state} is no longer running`);
      assert.equal(popup.elements.get('#first-run-guide').hidden, true,
        `${state} has known progress even with zero saved counts`);
    }
  }
});

test('a cached UID is only a preview: one start click follows the fresh account returned by the worker', async () => {
  const running = { kind: 'api_v1', status: 'running', state: 'running', active: true };
  const popup = makePopup({ popupView: view('accountA', 4, 40),
    sendMessage: async message => ({ ok: true, accountUid: 'accountB',
      summary: { contactCount: 1, messageCount: 5 }, progress: running,
      verificationRequired: false,
      view: view('accountB', 1, 5, running) }) });
  await popup.settle();
  await popup.elements.get('#update-incremental').listeners.get('click')();

  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.runtimeMessages[0].type, 'START_UPDATE');
  assert.equal(popup.runtimeMessages[0].expectedAccountUid, 'accountA');
  assert.equal(popup.elements.get('#account').textContent, 'accountB');
  assert.equal(popup.elements.get('#contact-count').textContent, '1');
  assert.match(popup.elements.get('#status').textContent, /已按当前登录账号 accountB 开始采集/);
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.runtimeMessages.length, 1, 'the same click starts using the freshly confirmed account');
});

test('browser language is adapted only when no supported local preference exists', async () => {
  const cases = [
    { uiLanguage: 'en-US', expected: 'en', button: 'Start first collection' },
    { uiLanguage: 'zh-TW', expected: 'zh-CN', button: '开始首次采集' },
    { uiLanguage: 'fr-FR', expected: 'en', button: 'Start first collection' },
    { uiLanguage: '', expected: 'en', button: 'Start first collection' },
    { uiLanguage: 'en-US', preference: 'zh-CN', expected: 'zh-CN', button: '开始首次采集' },
    { uiLanguage: 'zh-CN', preference: 'en', expected: 'en', button: 'Start first collection' },
    { uiLanguage: 'en-US', preference: 'invalid', expected: 'en', button: 'Start first collection' },
  ];
  for (const options of cases) {
    const popup = makePopup({ ...options, popupView: view('accountA', 0, 0) });
    await popup.settle();
    assert.equal(popup.document.documentElement.lang, options.expected);
    assert.equal(popup.document.title, popupI18n.translate(options.expected, 'app.title'));
    assert.equal(popup.elements.get('#language-select').value, options.expected);
    assert.equal(popup.elements.get('#update-incremental').textContent, options.button);
    assert.deepEqual(popup.storageKeys, [initialStorageKeys]);
    assert.equal(popup.storageWrites.length, 0, 'automatic adaptation does not persist or rewrite a preference');
    assert.equal(popup.runtimeMessages.length, 0);
  }
});

test('language changes redraw running progress and cached dates without any collection or view lookup', async () => {
  const progress = { kind: 'api_v1', status: 'running', active: true, runId: 'running-language',
    completed: 3, discovered: 8, refreshedCount: 2, skippedUnchangedCount: 1, failed: 0, newMessageCount: 7 };
  const popup = makePopup({ popupView: view('accountA', 3, 12, progress) });
  await popup.settle();
  const timerIds = [...popup.timers.keys()];
  await popup.selectLanguage('en');
  assert.equal(popup.document.documentElement.lang, 'en');
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Updating…');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.elements.get('#stop').textContent, 'Stop collection');
  assert.equal(popup.elements.get('#stop').hidden, false);
  assert.equal(popup.elements.get('#stop').disabled, false);
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.equal(popup.elements.get('#contact-count').textContent, '3');
  assert.equal(popup.elements.get('#message-count').textContent, '12');
  assert.match(popup.elements.get('#progress').textContent, /Updating · Checked 3\/8 · Updated 2 · Skipped 1 · Failed 0 · New messages 7/u);
  assert.equal(popup.elements.get('#status').textContent,
    popupI18n.translate('en', 'status.cachedAt', { date: popupI18n.formatDate('en', '2026-10-17T12:00:00.000Z') }));
  assert.deepEqual(popup.storageWrites, [{ [LANGUAGE_KEY]: 'en' }]);
  assert.deepEqual(popup.storageKeys, [initialStorageKeys]);
  assert.equal(popup.runtimeMessages.length, 0);
  assert.deepEqual([...popup.timers.keys()], timerIds, 'language switch preserves the existing polling schedule');

  await popup.selectLanguage('zh-CN');
  assert.match(popup.elements.get('#progress').textContent, /正在更新 · 检查 3\/8/u);
  assert.equal(popup.elements.get('#status').textContent,
    popupI18n.translate('zh-CN', 'status.cachedAt', { date: popupI18n.formatDate('zh-CN', '2026-10-17T12:00:00.000Z') }));
});

test('known diagnostic codes translate retained errors; unknown technical diagnostics remain unchanged', async () => {
  const failed = { status: 'failed', active: false, errorCode: 'ARCHIVE_DECRYPT_FAILED',
    errorDetails: '此前保存的中文诊断内容', completed: 3, discovered: 8 };
  const popup = makePopup({ popupView: view('accountA', 3, 12, failed) });
  await popup.settle();
  await popup.selectLanguage('en');
  assert.match(popup.elements.get('#status').textContent, /could not be decrypted/u);
  assert.doesNotMatch(popup.elements.get('#progress').textContent, /此前保存/u);
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Resume collection');
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal(popup.runtimeMessages.length, 0);

  const unknown = makePopup({ uiLanguage: 'en', popupView: view('accountA', 1, 1,
    { status: 'interrupted', active: false, errorCode: 'UNKNOWN_DIAGNOSTIC', errorDetails: 'HTTP 503: diagnostic' }) });
  await unknown.settle();
  assert.equal(unknown.elements.get('#status').textContent, 'HTTP 503: diagnostic');
  await unknown.selectLanguage('zh-CN');
  assert.equal(unknown.elements.get('#status').textContent, 'HTTP 503: diagnostic');
});

test('language selection while START is pending preserves its lock, failure and first-start retry', async () => {
  let finishStart;
  const popup = makePopup({ popupView: view('accountA', 0, 0),
    sendMessage: () => new Promise(resolve => { finishStart = resolve; }) });
  await popup.settle();
  const start = popup.elements.get('#update-incremental').listeners.get('click')();
  await popup.settle();
  await popup.selectLanguage('en');
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Starting first collection…');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.elements.get('#status').textContent, 'Starting first collection…');
  assert.equal(popup.runtimeMessages.length, 1);
  finishStart({ ok: false, error: 'UNSUPPORTED_PAGE' });
  await start;
  assert.equal(popup.elements.get('#status').textContent, 'Open the BOSS chat page before using the extension.');
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Start first collection');
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  await popup.selectLanguage('zh-CN');
  assert.equal(popup.elements.get('#status').textContent, '请打开 BOSS 直聘沟通页后再使用扩展。');
  assert.equal(popup.elements.get('#update-incremental').textContent, '开始首次采集');
  assert.equal(popup.runtimeMessages.length, 1, 'language changes do not retry START');
});

test('language changes do not revive an old account response after an epoch change', async () => {
  let finishStart;
  const localView = view('accountA', 0, 0);
  const popup = makePopup({ popupView: localView,
    sendMessage: () => new Promise(resolve => { finishStart = resolve; }) });
  await popup.settle();
  const start = popup.elements.get('#update-incremental').listeners.get('click')();
  await popup.settle();
  localView.accountUid = 'accountB';
  localView.summary = { contactCount: 2, messageCount: 9 };
  localView.hasCollectionHistory = true;
  await popup.elements.get('#refresh').listeners.get('click')();
  await popup.selectLanguage('en');
  finishStart({ ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
    progress: { status: 'running', active: true } });
  await start;
  assert.equal(popup.elements.get('#account').textContent, 'accountB');
  assert.equal(popup.elements.get('#message-count').textContent, '9');
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Update changed conversations');
  assert.equal(popup.runtimeMessages.length, 1);
});

test('preference writes are local, survive reopening and account clearing, and failures preserve the main status', async () => {
  const storageData = {};
  const popup = makePopup({ popupView: view('accountA', 2, 9), storageData,
    sendMessage: async message => {
      assert.equal(message.type, 'CLEAR_ACCOUNT');
      return { ok: true, cleared: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 },
        progress: null, hasCollectionHistory: false };
    } });
  await popup.settle();
  await popup.selectLanguage('en');
  await popup.elements.get('#clear').listeners.get('click')();
  await popup.settle();
  assert.equal(storageData[LANGUAGE_KEY], 'en');
  assert.deepEqual(popup.storageWrites, [{ [LANGUAGE_KEY]: 'en' }], 'account clearing never writes language preferences');
  const reopened = makePopup({ popupView: view('accountA', 0, 0), storageData, uiLanguage: 'zh-CN' });
  await reopened.settle();
  assert.equal(reopened.document.documentElement.lang, 'en');

  const broken = makePopup({ popupView: view('accountA', 2, 9, {
    status: 'interrupted', active: false, errorCode: 'BULK_STORAGE_TIMEOUT',
  }), storageSet: async () => { throw new Error('synthetic storage failure'); } });
  await broken.settle();
  await broken.selectLanguage('en');
  assert.equal(broken.document.documentElement.lang, 'en');
  assert.equal(broken.elements.get('#status').textContent, popupI18n.translate('en', 'error.BULK_STORAGE_TIMEOUT'));
  assert.equal(broken.elements.get('#language-status').hidden, false);
  assert.match(broken.elements.get('#language-status').textContent, /preference could not be saved/u);
  assert.equal(broken.storageWrites.length, 1, 'failed language persistence is not retried');
  assert.equal(broken.runtimeMessages.length, 0);
});

test('a late preference read cannot overwrite a language selected in this popup', async () => {
  let finishRead;
  const popup = makePopup({ uiLanguage: 'zh-CN', storageGet: () => new Promise(resolve => { finishRead = resolve; }) });
  await popup.selectLanguage('en');
  finishRead({ [POPUP_VIEW_KEY]: view('accountA', 2, 9), [LANGUAGE_KEY]: 'zh-CN' });
  await popup.settle();
  assert.equal(popup.document.documentElement.lang, 'en');
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.equal(popup.elements.get('#update-incremental').textContent, 'Update changed conversations');
  assert.equal(popup.runtimeMessages.length, 0);
});

test('language changes preserve recovery after an error hides the current account', async () => {
  for (const error of ['ARCHIVE_KEY_UNAVAILABLE', 'ARCHIVE_DECRYPT_FAILED', 'UNSUPPORTED_PAGE',
    'ACCOUNT_IDENTITY_UNAVAILABLE']) {
    const fromPoll = error === 'ACCOUNT_IDENTITY_UNAVAILABLE';
    const popup = makePopup({ popupView: fromPoll ? view('accountA', 2, 9) : null,
      sendMessage: async request => request.type === 'START_UPDATE'
        ? { ok: true, accountUid: 'accountA', summary: { contactCount: 2, messageCount: 9 },
          progress: { state: 'running', active: true } }
        : { ok: false, error } });
    await popup.settle();
    if (fromPoll) await popup.fireTimer([...popup.timers.values()].find(timer => timer.delay === 10000));
    assert.equal(popup.elements.get('#account').textContent, '尚无本地记录');
    assert.equal(popup.elements.get('#update-incremental').disabled, false, `${error}: recovery is available`);
    const controls = ['#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup', '#clear'];
    const availability = controls.map(id => popup.elements.get(id).disabled);
    const calls = popup.runtimeMessages.length;
    await popup.selectLanguage('en');
    assert.deepEqual(controls.map(id => popup.elements.get(id).disabled), availability,
      `${error}: translating the view preserves every action's availability`);
    assert.equal(popup.runtimeMessages.length, calls, 'switching language does not probe or retry');
    await popup.elements.get('#update-incremental').listeners.get('click')();
    assert.equal(popup.runtimeMessages.at(-1).type, 'START_UPDATE');
    assert.equal(popup.elements.get('#account').textContent, 'accountA');
    assert.equal(popup.elements.get('#update-incremental').disabled, true, 'a running retry prevents duplicate starts');
  }
});

test('manual refresh can restore the saved language after the first local read fails or times out', async () => {
  for (const failure of ['rejected', 'timeout']) {
    let reads = 0, finishOldRead;
    const cached = view('accountA', 2, 9);
    const popup = makePopup({ storageGet: async () => {
      if (++reads === 1) {
        if (failure === 'rejected') throw new Error('synthetic local read failure');
        return new Promise(resolve => { finishOldRead = resolve; });
      }
      return { [POPUP_VIEW_KEY]: cached, [LANGUAGE_KEY]: 'en' };
    } });
    await popup.settle();
    if (failure === 'timeout') {
      await popup.fireTimer([...popup.timers.values()].find(timer => timer.delay === 5000));
      await popup.settle();
    }
    assert.equal(popup.document.documentElement.lang, 'zh-CN');
    await popup.elements.get('#refresh').listeners.get('click')();
    assert.equal(popup.document.documentElement.lang, 'en');
    assert.equal(popup.elements.get('#account').textContent, 'accountA');
    assert.deepEqual(popup.storageKeys, [initialStorageKeys, initialStorageKeys],
      'the manual cache refresh reads the preference in the same existing storage call');
    assert.equal(popup.runtimeMessages.length, 0);
    if (finishOldRead) {
      finishOldRead({ [POPUP_VIEW_KEY]: cached, [LANGUAGE_KEY]: 'zh-CN' });
      await popup.settle();
      assert.equal(popup.document.documentElement.lang, 'en', 'the timed-out read stays obsolete');
    }
  }
});

test('known message-save and checkpoint failures explain the problem in both languages', async () => {
  for (const code of ['BULK_SNAPSHOT_SAVE_FAILED', 'BULK_CHECKPOINT_FAILED']) {
    const popup = makePopup({ popupView: view('accountA', 2, 9, {
      state: 'failed', active: false, errorCode: code, errorDetails: '旧语言的保存诊断',
    }) });
    await popup.settle();
    assert.equal(popup.elements.get('#status').textContent, popupI18n.translate('zh-CN', `error.${code}`));
    await popup.selectLanguage('en');
    assert.equal(popup.elements.get('#status').textContent, popupI18n.translate('en', `error.${code}`));
    assert.match(popup.elements.get('#progress').textContent, /could not be confirmed/u);
    assert.equal(popup.elements.get('#message-count').textContent, '9');
    assert.equal(popup.runtimeMessages.length, 0);
  }
});

test('language switching updates accessibility labels, tooltip and the native clear confirmation', async () => {
  const confirmations = [];
  const popup = makePopup({ popupView: view('accountA', 2, 9), confirm: text => {
    confirmations.push(text);
    return false;
  } });
  await popup.settle();
  for (const locale of ['en', 'zh-CN']) {
    await popup.selectLanguage(locale);
    assert.equal(popup.elements.get('#refresh').getAttribute('aria-label'),
      locale === 'en' ? 'Refresh local record status' : '刷新本地记录状态');
    assert.equal(popup.elements.get('#refresh').getAttribute('title'),
      locale === 'en' ? 'Refresh local status' : '刷新本地状态');
    const labels = popup.document.querySelectorAll('[data-i18n-aria-label]');
    const expected = locale === 'en'
      ? ['Local record counts for this account', 'First collection instructions', 'Collection actions', 'Export local records for this account']
      : ['当前账号本地记录数', '首次采集说明', '采集操作', '导出本地记录账号数据'];
    for (const [index, key] of ['counts.aria', 'guide.aria', 'actions.aria', 'exports.aria'].entries()) {
      assert.equal(labels.find(element => element.getAttribute('data-i18n-aria-label') === key)
        .getAttribute('aria-label'), expected[index]);
    }
    await popup.elements.get('#clear').listeners.get('click')();
    assert.match(confirmations.at(-1), locale === 'en'
      ? /^Clear all local conversations and update records for account accountA/u : /^清除账号 accountA/u);
    assert.equal(popup.runtimeMessages.length, 0, 'declining the translated confirmation does not clear data');
    assert.equal(popup.elements.get('#message-count').textContent, '9');
  }
});
