import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension-tracker/popup.js', import.meta.url), 'utf8');
const POPUP_VIEW_KEY = 'bossReadonlyTracker.popupView.v1';
const ids = ['#account', '#contact-count', '#message-count', '#progress', '#status', '#refresh',
  '#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup', '#clear'];

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makePopup(sendMessage, { confirm = true, popupView = {
  accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 }, progress: null,
  verificationRequired: false,
} } = {}) {
  const elements = new Map(ids.map(id => [id, {
    id, textContent: '', disabled: true, listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
  }]));
  const timers = new Map();
  let timerId = 0;
  let storedPopupView = popupView;
  let storageReads = 0;
  const context = {
    document: {
      querySelector: selector => elements.get(selector) || null,
      querySelectorAll: selector => selector === '.actions button'
        ? ['#update-incremental', '#update-full', '#stop', '#export-latest', '#export-all', '#backup']
          .map(id => elements.get(id)) : [],
      createElement: () => ({ append() {}, click() {}, remove() {} }),
      body: { append() {} },
    },
    window: { confirm: () => confirm, addEventListener() {} },
    chrome: {
      tabs: { query: async () => [{ id: 1 }] },
      runtime: { sendMessage },
      storage: { local: { async get(key) {
        storageReads++;
        return key === POPUP_VIEW_KEY ? { [POPUP_VIEW_KEY]: storedPopupView } : {};
      } } },
    },
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { id, fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    URL,
    Blob,
  };
  vm.runInNewContext(source, context, { filename: 'popup.js' });
  return {
    elements, timers,
    getStorageReads() { return storageReads; },
    setPopupView(value) { storedPopupView = value; },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    async fireTimer(timer) {
      timers.delete(timer.id);
      return timer.fn();
    },
  };
}

function progress(status, overrides = {}) {
  return {
    kind: 'api_v1', runId: 'test-run', status, state: status, active: status === 'running',
    discovered: 364, completed: 10, scannedCount: 364, refreshedCount: 8,
    skippedUnchangedCount: 2, failed: 0, newMessageCount: 264, messageCount: 264,
    ...overrides,
  };
}

test('failed HTML-response diagnostics render safely and enable a retry', async () => {
  const failed = progress('failed', {
    completed: 10, failed: 1, errorCode: 'SITE_NON_JSON_RESPONSE',
    errorDetails: { endpoint: '/wapi/private', httpStatus: 200, contentType: 'text/html', responseKind: 'html' },
    error: `Unexpected token '<', "<!doctype html>" is not valid JSON`,
  });
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE' || message.type === 'GET_BULK_PROGRESS') {
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 10, messageCount: 264 }, progress: failed };
    }
    throw new Error(`Unexpected request ${message.type}`);
  }, { popupView: { accountUid: 'accountA', summary: { contactCount: 10, messageCount: 264 }, progress: failed } });
  await popup.settle();

  const label = popup.elements.get('#progress').textContent;
  assert.match(label, /更新失败/);
  assert.match(label, /检查 10\/364/);
  assert.match(label, /已更新 8/);
  assert.match(label, /跳过 2/);
  assert.match(label, /失败 1/);
  assert.match(label, /新增消息 264/);
  assert.match(label, /HTML 页面而不是 JSON/);
  assert.doesNotMatch(label, /private|contentType|object/i);
  assert.doesNotMatch(label, /Unexpected token|<!doctype/i);
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal(popup.elements.get('#update-full').disabled, false);
  assert.equal(popup.elements.get('#stop').disabled, false);
  assert.doesNotMatch(popup.elements.get('#status').textContent, /操作已完成/);
});

test('BOSS human verification explains that the user must complete verification before continuing', async () => {
  for (const state of ['failed', 'interrupted']) {
    const failed = progress(state, { errorCode: 'SITE_VERIFICATION_REQUIRED',
      errorDetails: 'SITE_VERIFICATION_REQUIRED' });
    const popup = makePopup(async message => {
      if (message.type === 'GET_STATE' || message.type === 'GET_BULK_PROGRESS') {
        return { ok: true, accountUid: 'accountA', summary: { contactCount: 1, messageCount: 0 }, progress: failed };
      }
      if (message.type === 'START_UPDATE') return { ok: false, error: 'SITE_VERIFICATION_REQUIRED' };
      throw new Error(`Unexpected request ${message.type}`);
    }, { popupView: { accountUid: 'accountA', summary: { contactCount: 1, messageCount: 0 }, progress: failed } });
    await popup.settle();

    const label = popup.elements.get('#progress').textContent;
    assert.match(label, /等待 BOSS 人工验证/);
    assert.match(label, /BOSS/);
    assert.match(label, /人工验证/);
    assert.match(label, /完成验证/);
    assert.doesNotMatch(label, /可重试|可以重试|可继续/);
    if (state === 'failed') {
      await popup.elements.get('#update-incremental').listeners.get('click')();
      assert.equal(popup.elements.get('#status').textContent,
        'BOSS 要求人工验证。请先在 BOSS 页面完成验证，再继续采集。');
      assert.doesNotMatch(popup.elements.get('#status').textContent, /可重试|可以重试/);
    }
  }
});

test('a verification response without a confirmed UID hides the previous account and does not probe again', async () => {
  const calls = [];
  const popup = makePopup(async message => {
    calls.push(message.type);
    if (message.type === 'GET_STATE') return { ok: true, accountUid: 'accountA',
      summary: { contactCount: 2, messageCount: 8 }, progress: progress('completed') };
    if (message.type === 'GET_BULK_PROGRESS') return { ok: false, error: 'SITE_VERIFICATION_REQUIRED' };
    throw new Error(`Unexpected request ${message.type}`);
  }, { popupView: { accountUid: 'accountA', summary: { contactCount: 2, messageCount: 8 },
    progress: progress('completed') } });
  await popup.settle();
  assert.equal(popup.elements.get('#account').textContent, 'accountA');

  const timer = [...popup.timers.values()].find(item => item.delay === 10000);
  assert.ok(timer);
  await popup.fireTimer(timer);
  assert.equal(popup.elements.get('#account').textContent, '尚无本地记录');
  assert.equal(popup.elements.get('#contact-count').textContent, '—');
  assert.match(popup.elements.get('#status').textContent, /BOSS.*人工验证/);
  assert.equal(calls.filter(type => type === 'GET_STATE').length, 0);
  assert.equal(popup.getStorageReads(), 1);
  assert.equal(popup.timers.size, 0);
});

test('verification error pauses the normal update button until an explicit START retry succeeds', async () => {
  let state = { required: true,
    progress: progress('stopped', { active: false, finalizing: true, errorCode: 'SITE_VERIFICATION_REQUIRED' }) };
  let progressPollResult = { required: true,
    progress: progress('interrupted', { finalizing: false, errorCode: 'SITE_VERIFICATION_REQUIRED' }) };
  const starts = [];
  const response = current => ({ ok: true, accountUid: 'accountA',
    summary: { contactCount: 2, messageCount: 8 }, verificationRequired: current.required,
    progress: current.progress });
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE') return response(state);
    if (message.type === 'GET_BULK_PROGRESS') {
      state = progressPollResult;
      return response(state);
    }
    if (message.type === 'START_UPDATE') {
      starts.push(message);
      state = starts.length === 1
        ? { required: true, progress: progress('interrupted', { errorCode: 'SITE_VERIFICATION_REQUIRED' }) }
        : { required: false, progress: progress('running') };
      if (starts.length === 2) progressPollResult = { required: false, progress: progress('completed') };
      return response(state);
    }
    throw new Error(`Unexpected request ${message.type}`);
  }, { popupView: { accountUid: 'accountA', summary: { contactCount: 2, messageCount: 8 },
    progress: state.progress, verificationRequired: state.required } });
  await popup.settle();

  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.elements.get('#update-full').disabled, true);
  assert.equal(popup.elements.get('#export-all').disabled, false);
  assert.match(popup.elements.get('#progress').textContent, /正在保存停止前已读取的内容/);
  const finalizingPoll = [...popup.timers.values()].find(timer => timer.delay === 5000);
  assert.ok(finalizingPoll);
  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(starts.length, 0, 'finalizing must not offer a continue action before the checkpoint');
  await popup.fireTimer(finalizingPoll);
  assert.equal(popup.elements.get('#update-incremental').textContent, '我已完成验证，继续采集');
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal([...popup.timers.values()].some(timer => timer.delay === 5000 || timer.delay === 10000), false);

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].type, 'START_UPDATE', 'manual continuation uses the normal START flow');
  assert.equal(starts[0].expectedAccountUid, 'accountA');
  assert.equal(popup.elements.get('#update-incremental').textContent, '我已完成验证，继续采集');
  assert.equal([...popup.timers.values()].some(timer => timer.delay === 5000 || timer.delay === 10000), false,
    'verification error must pause polling until the user retries');

  await popup.elements.get('#update-incremental').listeners.get('click')();
  assert.equal(starts.length, 2);
  assert.equal(starts[1].type, 'START_UPDATE');
  assert.equal(starts[1].expectedAccountUid, 'accountA');
  const recoveredPoll = [...popup.timers.values()].find(timer => timer.delay === 5000);
  assert.ok(recoveredPoll);
  await popup.fireTimer(recoveredPoll);
  assert.equal(popup.elements.get('#progress').textContent.includes('等待 BOSS 人工验证'), false);
  assert.equal(popup.elements.get('#update-incremental').textContent, '更新变化会话');
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.equal(popup.elements.get('#update-full').disabled, false);
});

test('a running update disables duplicate starts, shows counters, and keeps STOP available', async () => {
  let stored = null;
  const running = progress('running', { completed: 10, discovered: 364 });
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE' || message.type === 'GET_BULK_PROGRESS') {
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 10, messageCount: 264 }, progress: stored };
    }
    if (message.type === 'START_UPDATE') {
      stored = running;
      return { ok: true, accountUid: 'accountA', progress: running };
    }
    throw new Error(`Unexpected request ${message.type}`);
  });
  await popup.settle();
  await popup.elements.get('#update-incremental').listeners.get('click')();

  assert.match(popup.elements.get('#progress').textContent, /检查 10\/364/);
  assert.match(popup.elements.get('#progress').textContent, /新增消息 264/);
  assert.match(popup.elements.get('#status').textContent, /正在后台继续/);
  assert.doesNotMatch(popup.elements.get('#status').textContent, /操作已完成/);
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  assert.equal(popup.elements.get('#update-full').disabled, true);
  assert.equal(popup.elements.get('#stop').disabled, false);
});

test('STOP remains callable while a separate mutation is waiting', async () => {
  const messages = [];
  let stored = progress('running');
  const never = new Promise(() => {});
  const stopped = progress('stopped', { active: false });
  const popup = makePopup(async message => {
    messages.push(message);
    if (message.type === 'GET_STATE' || message.type === 'GET_BULK_PROGRESS') {
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 10, messageCount: 264 }, progress: stored };
    }
    if (message.type === 'CLEAR_ACCOUNT') return never;
    if (message.type === 'STOP_UPDATE') { stored = stopped; return { ok: true, accountUid: 'accountA', progress: stopped }; }
    throw new Error(`Unexpected request ${message.type}`);
  });
  await popup.settle();
  popup.elements.get('#clear').listeners.get('click')();
  await popup.settle();
  assert.equal(popup.elements.get('#clear').disabled, true);
  assert.equal(popup.elements.get('#stop').disabled, false);

  await popup.elements.get('#stop').listeners.get('click')();
  assert.equal(messages.some(message => message.type === 'STOP_UPDATE'), true);
  assert.equal(popup.elements.get('#progress').textContent.includes('已停止'), true);
  assert.equal(popup.elements.get('#status').textContent, '正在清除当前账号记录…');
  assert.equal(popup.elements.get('#clear').disabled, true);
});

test('a user refresh waits for the in-flight local progress poll and rereads only popupView storage', async () => {
  const poll = deferred();
  const calls = [];
  let active = 0, maxActive = 0;
  const popup = makePopup(async message => {
    calls.push(message.type);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (message.type === 'GET_BULK_PROGRESS') {
        return await poll.promise;
      }
      throw new Error(`Unexpected request ${message.type}`);
    } finally { active--; }
  });
  await popup.settle();
  const pollTimer = [...popup.timers.values()].find(timer => timer.delay === 10000);
  assert.ok(pollTimer, 'idle polling should use a 10 second delay');
  const pollDone = popup.fireTimer(pollTimer);
  await popup.settle();
  assert.equal(calls.filter(type => type === 'GET_BULK_PROGRESS').length, 1);

  const refreshDone = popup.elements.get('#refresh').listeners.get('click')();
  await popup.settle();
  assert.equal(popup.getStorageReads(), 1);
  assert.equal(maxActive, 1);
  poll.resolve({ ok: true, accountUid: 'accountA', summary: { contactCount: 1, messageCount: 2 }, progress: null });
  await Promise.all([pollDone, refreshDone]);
  assert.equal(popup.getStorageReads(), 2);
  assert.equal(calls.filter(type => type === 'GET_STATE').length, 0);
  assert.equal(maxActive, 1);
});

test('a successful progress poll clears a prior timeout status', async () => {
  let pollShouldHang = true;
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE') return { ok: true, accountUid: 'accountA',
      summary: { contactCount: 1, messageCount: 2 }, progress: null };
    if (message.type === 'GET_BULK_PROGRESS') {
      if (pollShouldHang) return new Promise(() => {});
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 1, messageCount: 2 }, progress: null };
    }
    throw new Error(`Unexpected request ${message.type}`);
  });
  await popup.settle();

  const firstPoll = [...popup.timers.values()].find(timer => timer.delay === 10000);
  assert.ok(firstPoll);
  const firstPollDone = popup.fireTimer(firstPoll);
  await popup.settle();
  const readTimeout = [...popup.timers.values()].find(timer => timer.delay === 30000);
  assert.ok(readTimeout, 'read requests should have a 30 second deadline');
  await popup.fireTimer(readTimeout);
  await firstPollDone;
  assert.match(popup.elements.get('#status').textContent, /等待扩展后台响应超时/);

  pollShouldHang = false;
  const nextPoll = [...popup.timers.values()].find(timer => timer.delay === 10000);
  assert.ok(nextPoll);
  await popup.fireTimer(nextPoll);
  assert.equal(popup.elements.get('#status').textContent, '当前账号记录已加载。');
});

test('a successful progress poll does not replace an active foreground action prompt', async () => {
  const pollGate = deferred();
  const startGate = deferred();
  const running = progress('running');
  let stored = null;
  let progressPolls = 0;
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE') return { ok: true, accountUid: 'accountA',
      summary: { contactCount: 1, messageCount: 2 }, progress: stored };
    if (message.type === 'GET_BULK_PROGRESS') { progressPolls++; return pollGate.promise; }
    if (message.type === 'START_UPDATE') { stored = running; return startGate.promise; }
    throw new Error(`Unexpected request ${message.type}`);
  });
  await popup.settle();
  const pollTimer = [...popup.timers.values()].find(timer => timer.delay === 10000);
  assert.ok(pollTimer);
  const pollDone = popup.fireTimer(pollTimer);
  await popup.settle();
  assert.equal(progressPolls, 1);

  const actionDone = popup.elements.get('#update-incremental').listeners.get('click')();
  await popup.settle();
  assert.equal(popup.elements.get('#status').textContent, '正在更新变化会话…');
  pollGate.resolve({ ok: true, accountUid: 'accountA',
    summary: { contactCount: 1, messageCount: 2 }, progress: running });
  await pollDone;
  assert.equal(popup.elements.get('#status').textContent, '正在更新变化会话…');

  startGate.resolve({ ok: true, accountUid: 'accountA', progress: running });
  await actionDone;
  assert.match(popup.elements.get('#status').textContent, /正在后台继续/);
});

test('a timed out start releases the mutation lock so the update can be retried', async () => {
  const never = new Promise(() => {});
  const popup = makePopup(async message => {
    if (message.type === 'GET_STATE' || message.type === 'GET_BULK_PROGRESS') {
      return { ok: true, accountUid: 'accountA', summary: { contactCount: 0, messageCount: 0 }, progress: null };
    }
    if (message.type === 'START_UPDATE') return never;
    throw new Error(`Unexpected request ${message.type}`);
  });
  await popup.settle();
  const startDone = popup.elements.get('#update-incremental').listeners.get('click')();
  await popup.settle();
  assert.equal(popup.elements.get('#update-incremental').disabled, true);
  const timeout = [...popup.timers.values()].find(timer => timer.delay === 90000);
  assert.ok(timeout);
  await popup.fireTimer(timeout);
  await startDone;
  assert.equal(popup.elements.get('#update-incremental').disabled, false);
  assert.match(popup.elements.get('#status').textContent, /超时/);
});
