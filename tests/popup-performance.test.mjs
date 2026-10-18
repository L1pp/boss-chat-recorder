import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension-tracker/popup.js', import.meta.url), 'utf8');
const POPUP_VIEW_KEY = 'bossReadonlyTracker.popupView.v1';
const ids = ['#account', '#contact-count', '#message-count', '#progress', '#status', '#refresh',
  '#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup', '#clear'];

function makePopup({ popupView = null, sendMessage = async () => ({ ok: false, error: 'UNEXPECTED_MESSAGE' }) } = {}) {
  const elements = new Map(ids.map(id => [id, {
    id, textContent: '', disabled: true, listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
  }]));
  const timers = new Map();
  const runtimeMessages = [];
  const storageKeys = [];
  let nextTimer = 0;
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
      tabs: { query: async () => [{ id: 7 }] },
      runtime: { async sendMessage(message) { runtimeMessages.push(message); return sendMessage(message); } },
      storage: { local: { async get(key) {
        storageKeys.push(key);
        return { [POPUP_VIEW_KEY]: popupView };
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
    elements, timers, runtimeMessages, storageKeys,
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    async fireTimer(timer) { timers.delete(timer.id); return timer.fn(); },
  };
}

function view(accountUid, contactCount = 0, messageCount = 0, progress = null, updatedAt = '2026-10-17T12:00:00.000Z') {
  return { accountUid, summary: { contactCount, messageCount }, progress,
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

  assert.deepEqual(popup.storageKeys, [POPUP_VIEW_KEY]);
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.match(popup.elements.get('#status').textContent, /本地记录缓存/);
  assert.equal(popup.elements.get('#contact-count').textContent, '2');
  assert.equal(popup.runtimeMessages.length, 0, 'opening the popup must not send a worker or site request');

  const timer = [...popup.timers.values()].find(item => item.delay === 10000);
  assert.ok(timer);
  await popup.fireTimer(timer);
  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.runtimeMessages[0].type, 'GET_BULK_PROGRESS');
  assert.equal(popup.runtimeMessages[0].expectedAccountUid, 'accountA');

  await popup.elements.get('#refresh').listeners.get('click')();
  assert.deepEqual(popup.storageKeys, [POPUP_VIEW_KEY, POPUP_VIEW_KEY]);
  assert.equal(popup.runtimeMessages.length, 1, 'manual refresh must reread local cache only');
});

test('without a cached UID the first start sends no expected UID and does not post-read GET_STATE', async () => {
  const popup = makePopup({ popupView: null,
    sendMessage: async message => {
      if (message.type === 'GET_STATE') return { ok: false, error: 'ACCOUNT_UID_REQUIRED' };
      assert.equal(message.type, 'START_UPDATE');
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 3, messageCount: 12 },
        progress: { kind: 'api_v1', status: 'running', state: 'running', active: true, runId: 'first-run' },
        verificationRequired: false, updatedAt: '2026-10-17T12:10:00.000Z' };
    } });
  await popup.settle();
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal(popup.elements.get('#export-all').disabled, true);
  assert.equal(popup.runtimeMessages.length, 1);
  assert.equal(popup.runtimeMessages[0].type, 'GET_STATE');
  assert.equal(Object.hasOwn(popup.runtimeMessages[0], 'tabId'), false,
    'legacy local initialization does not probe the active tab');
  assert.equal(Object.hasOwn(popup.runtimeMessages[0], 'expectedAccountUid'), false);

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(popup.runtimeMessages.length, 2);
  assert.equal(Object.hasOwn(popup.runtimeMessages[1], 'expectedAccountUid'), false);
  assert.equal(popup.runtimeMessages[1].type, 'START_UPDATE');
  assert.equal(popup.elements.get('#account').textContent, 'accountA');
  assert.equal(popup.elements.get('#contact-count').textContent, '3');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.runtimeMessages.filter(message => message.type === 'GET_STATE').length, 1,
    'successful first start must not post-read GET_STATE');
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
