import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension-tracker/popup.js', import.meta.url), 'utf8');
const POPUP_VIEW_KEY = 'bossReadonlyTracker.popupView.v1';
const ids = ['#account', '#account-card', '#contact-count', '#message-count', '#progress-card', '#progress',
  '#status', '#refresh', '#counts', '#first-run-guide', '#export-actions', '#record-tools', '#update-incremental', '#update-full', '#stop',
  '#export-latest', '#export-all', '#backup', '#clear'];

function makePopup({ popupView = null, sendMessage = async () => ({ ok: false, error: 'UNEXPECTED_MESSAGE' }) } = {}) {
  const elements = new Map(ids.map(id => [id, {
    id, textContent: '', disabled: true,
    hidden: ['#account-card', '#progress-card', '#counts', '#first-run-guide', '#update-full', '#stop',
      '#export-actions', '#record-tools'].includes(id),
    listeners: new Map(),
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
  assert.deepEqual(popup.storageKeys, [POPUP_VIEW_KEY, POPUP_VIEW_KEY]);
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
  assert.deepEqual(popup.storageKeys, [POPUP_VIEW_KEY]);
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
