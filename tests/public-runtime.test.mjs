import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { registerPublicRuntime } from '../extension-tracker/public-runtime.mjs';

const PUBLIC_TYPES = Object.freeze([
  'SITE_REQUEST_SLOT',
  'GET_STATE',
  'GET_BULK_PROGRESS',
  'START_UPDATE',
  'STOP_UPDATE',
  'RESUME_AFTER_VERIFICATION',
  'EXPORT_AI_INPUT',
  'EXPORT_ACCOUNT_BACKUP',
  'CLEAR_ACCOUNT',
  'BULK_PROGRESS',
  'BULK_SNAPSHOTS',
]);

const DEBUG_TYPES = Object.freeze([
  'DEBUG_CONTROL_CONNECT',
  'DEBUG_CONTROL_DISCONNECT',
  'DEBUG_CONTROL_STATUS',
  'DEBUG_STOP_LOCAL',
  'GET_DEBUG_LOGS',
  'GET_DEBUG_STATUS',
  'GET_DEBUG_STORAGE',
]);

// Let the microtask queue and one macrotask turn drain before asserting.
const settle = () => new Promise(resolve => { setImmediate(resolve); });

function createChromeApi(id = 'public-runtime-extension-id') {
  const listeners = [];
  return {
    runtime: {
      id,
      onMessage: { addListener: listener => { listeners.push(listener); } },
    },
    listeners,
  };
}

function createHarness({
  dispatch: dispatchImpl = message => ({ ok: true, type: message?.type }),
} = {}) {
  const chromeApi = createChromeApi();
  const record = {
    handlerOptions: null,
    portOptions: null,
    dispatches: [],
    activityCount: 0,
    trustChecks: [],
  };
  const createExtensionMessageHandler = (api, options) => {
    assert.equal(api, chromeApi, '消息处理器工厂收到同一个 chromeApi');
    assert.equal(typeof options?.onStorageActivity, 'function', '工厂收到存储活动回调');
    record.handlerOptions = options;
    return (message, sender) => {
      record.dispatches.push({ message, sender });
      const notifyStorageActivity = () => options.onStorageActivity();
      return dispatchImpl(message, sender, notifyStorageActivity);
    };
  };
  const createStoragePortServer = config => {
    record.portOptions = config;
    return { activity: () => { record.activityCount += 1; } };
  };
  const isTrustedCollectorSender = (sender, extensionId) => {
    record.trustChecks.push({ sender, extensionId });
    return sender?.trusted === true && extensionId === chromeApi.runtime.id;
  };
  const runtime = registerPublicRuntime(chromeApi, {
    createExtensionMessageHandler,
    createStoragePortServer,
    isTrustedCollectorSender,
  });
  return { chromeApi, record, runtime };
}

function sendProbe() {
  const calls = [];
  return { calls, sendResponse: value => { calls.push(value); } };
}

test('只注册一个 onMessage 监听器，正常类型异步响应并透传结果', async () => {
  const { chromeApi, record, runtime } = createHarness();
  assert.equal(chromeApi.listeners.length, 1, '只注册一个监听器');
  assert.equal(runtime.handleMessage, chromeApi.listeners[0], '返回的 handleMessage 就是注册的监听器');
  assert.equal(typeof runtime.storagePorts?.activity, 'function', '返回可用 storagePorts');

  const { calls, sendResponse } = sendProbe();
  const sender = { id: chromeApi.runtime.id, tab: { id: 7 } };
  const accepted = runtime.handleMessage({ type: 'GET_STATE', tabId: 7 }, sender, sendResponse);
  assert.equal(accepted, true, '接受后返回 true 以保持消息通道打开');
  assert.deepEqual(calls, [], '同步阶段不响应');
  assert.deepEqual(record.dispatches, [], '同步阶段不派发');

  await settle();
  assert.deepEqual(calls, [{ ok: true, type: 'GET_STATE' }], '异步回传 dispatch 结果');
  assert.equal(record.dispatches.length, 1);
  assert.equal(record.dispatches[0].message.type, 'GET_STATE');
  assert.equal(record.dispatches[0].sender, sender, 'sender 原样透传给 dispatch');
});

test('白名单内的全部正常类型都被接受', async () => {
  for (const type of PUBLIC_TYPES) {
    const { chromeApi, record, runtime } = createHarness();
    const { calls, sendResponse } = sendProbe();
    const accepted = runtime.handleMessage({ type }, { id: chromeApi.runtime.id }, sendResponse);
    assert.equal(accepted, true, `${type} 应被接受`);
    await settle();
    assert.equal(record.dispatches.length, 1, `${type} 应派发一次`);
    assert.deepEqual(calls, [{ ok: true, type }], `${type} 应异步响应`);
  }
});

test('未知类型与 DEBUG_* 类型静默拒收：返回 false、不派发、不响应', async () => {
  const { chromeApi, record, runtime } = createHarness();
  const rejectedTypes = [...DEBUG_TYPES, 'UNKNOWN_TYPE', 'debug_control_connect', '', 0, null, undefined];
  for (const type of rejectedTypes) {
    const { calls, sendResponse } = sendProbe();
    assert.equal(runtime.handleMessage({ type }, { id: chromeApi.runtime.id }, sendResponse), false,
      `${String(type)} 不应被接受`);
    await settle();
    assert.deepEqual(calls, [], `${String(type)} 不应收到任何响应`);
  }
  for (const payload of [undefined, null, 'GET_STATE', 42]) {
    assert.equal(runtime.handleMessage(payload, { id: chromeApi.runtime.id }, () => {
      throw new Error('拒收的消息不应回响应');
    }), false);
  }
  await settle();
  assert.equal(record.dispatches.length, 0, '拒收消息从不进入 dispatch');
});

test('storagePorts.handleMessage 转发到同一个 dispatch', async () => {
  const { chromeApi, record } = createHarness({
    dispatch: (message, sender) => ({ ok: true, echoed: message?.type, sameSender: sender?.id }),
  });
  assert.equal(typeof record.portOptions?.handleMessage, 'function');
  assert.equal(record.portOptions.runtime, chromeApi.runtime, '端口服务复用同一 runtime');
  const sender = { id: chromeApi.runtime.id, tab: { id: 11 } };
  const result = await record.portOptions.handleMessage({ type: 'BULK_SNAPSHOTS' }, sender);
  assert.deepEqual(result, { ok: true, echoed: 'BULK_SNAPSHOTS', sameSender: chromeApi.runtime.id });
  assert.equal(record.dispatches.length, 1);
  assert.equal(record.dispatches[0].message.type, 'BULK_SNAPSHOTS');
  assert.equal(record.dispatches[0].sender, sender);
});

test('真实存储活动回调仍转发到 storagePorts.activity', async () => {
  const { chromeApi, record, runtime } = createHarness({
    dispatch: () => ({ ok: true }),
  });
  assert.equal(record.activityCount, 0, '注册时不应触发活动通知');
  record.handlerOptions.onStorageActivity();
  assert.equal(record.activityCount, 1, '工厂回调直接转发到 storagePorts.activity');

  const { calls, sendResponse } = sendProbe();
  assert.equal(runtime.handleMessage({ type: 'BULK_PROGRESS' }, { id: chromeApi.runtime.id }, sendResponse), true);
  await settle();
  assert.deepEqual(calls, [{ ok: true }]);
  assert.equal(record.activityCount, 1);
});

test('dispatch 触发存储写入时 storagePorts.activity 仍被调用', async () => {
  const { chromeApi, record, runtime } = createHarness({
    dispatch: (message, sender, notifyStorageActivity) => {
      notifyStorageActivity();
      return { ok: true, accountUid: '10001' };
    },
  });
  const { calls, sendResponse } = sendProbe();
  assert.equal(runtime.handleMessage({ type: 'BULK_SNAPSHOTS' }, { id: chromeApi.runtime.id }, sendResponse), true);
  await settle();
  assert.deepEqual(calls, [{ ok: true, accountUid: '10001' }]);
  assert.equal(record.activityCount, 1, '存储活动经回调到达 storagePorts');
});

test('storagePorts 的 isTrustedSender 复用 isTrustedCollectorSender(sender, runtime.id)', () => {
  const { chromeApi, record } = createHarness();
  const { isTrustedSender } = record.portOptions;
  assert.equal(typeof isTrustedSender, 'function', '注入独立信任校验函数');

  const trustedSender = { id: chromeApi.runtime.id, trusted: true };
  const untrustedSender = { id: chromeApi.runtime.id };
  assert.equal(isTrustedSender(trustedSender), true);
  assert.equal(isTrustedSender(untrustedSender), false);
  assert.equal(record.trustChecks.length, 2);
  assert.equal(record.trustChecks[0].sender, trustedSender, 'sender 原样传入');
  assert.equal(record.trustChecks[0].extensionId, chromeApi.runtime.id, '第二个参数是本扩展 id');
  assert.equal(record.trustChecks[1].sender, untrustedSender);
  assert.equal(record.trustChecks[1].extensionId, chromeApi.runtime.id);
});

test('dispatch 抛错时只返回静态错误码，不泄露异常原文', async () => {
  const secret = 'token=SECRET-VALUE 页面正文 <div>张三</div>';

  const coded = createHarness({
    dispatch: () => { throw Object.assign(new Error(secret), { code: 'SITE_VERIFICATION_REQUIRED' }); },
  });
  const codedProbe = sendProbe();
  assert.equal(coded.runtime.handleMessage({ type: 'START_UPDATE' }, {}, codedProbe.sendResponse), true);
  await settle();
  assert.deepEqual(codedProbe.calls, [{ ok: false, error: 'SITE_VERIFICATION_REQUIRED' }]);
  assert.deepEqual(Object.keys(codedProbe.calls[0]).sort(), ['error', 'ok'], '不额外附带 message/stack');
  assert.equal(JSON.stringify(codedProbe.calls).includes('SECRET-VALUE'), false);
  assert.equal(JSON.stringify(codedProbe.calls).includes('张三'), false);

  const plain = createHarness({ dispatch: () => Promise.reject(new Error(secret)) });
  const plainProbe = sendProbe();
  assert.equal(plain.runtime.handleMessage({ type: 'GET_BULK_PROGRESS' }, {}, plainProbe.sendResponse), true);
  await settle();
  assert.deepEqual(plainProbe.calls, [{ ok: false, error: 'RUNTIME_ERROR' }]);
  assert.equal(JSON.stringify(plainProbe.calls).includes('SECRET-VALUE'), false);

  const thrownJunk = createHarness({ dispatch: () => { throw null; } });
  const junkProbe = sendProbe();
  assert.equal(thrownJunk.runtime.handleMessage({ type: 'CLEAR_ACCOUNT' }, {}, junkProbe.sendResponse), true);
  await settle();
  assert.deepEqual(junkProbe.calls, [{ ok: false, error: 'RUNTIME_ERROR' }]);
});

test('缺少注入依赖时注册立即失败且不注册监听器', () => {
  const chromeApi = createChromeApi();
  assert.throws(() => registerPublicRuntime(null), /CHROME_EXTENSION_API_REQUIRED/u);
  assert.throws(() => registerPublicRuntime(chromeApi, {}), /MESSAGE_HANDLER_FACTORY_REQUIRED/u);
  assert.throws(() => registerPublicRuntime(chromeApi, {
    createExtensionMessageHandler: () => () => ({ ok: true }),
  }), /STORAGE_PORT_FACTORY_REQUIRED/u);
  assert.throws(() => registerPublicRuntime(chromeApi, {
    createExtensionMessageHandler: () => () => ({ ok: true }),
    createStoragePortServer: () => ({ activity() {} }),
  }), /TRUSTED_SENDER_CHECK_REQUIRED/u);
  assert.equal(chromeApi.listeners.length, 0);
});

test('模块导入本身不启动任何动作，也不含调试模块/本地桥接/诊断依赖', async () => {
  const originalChrome = globalThis.chrome;
  const added = [];
  globalThis.chrome = { runtime: { id: 'inert-probe-id', onMessage: { addListener: l => added.push(l) } } };
  try {
    const fresh = await import(`../extension-tracker/public-runtime.mjs?inert=${Date.now()}`);
    assert.deepEqual(Object.keys(fresh), ['registerPublicRuntime'], '只导出 registerPublicRuntime');
    assert.equal(typeof fresh.registerPublicRuntime, 'function');
    assert.deepEqual(added, [], '导入阶段不注册监听器');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }

  const source = await readFile(new URL('../extension-tracker/public-runtime.mjs', import.meta.url), 'utf8');
  const forbidden = [
    [/^\s*import\b/mu, '静态 import'],
    [/\brequire\s*\(/u, 'require 调用'],
    [/createDebugLog|createDebugControlBridge|debug-control|debug-log/u, '临时调试模块'],
    [/localhost|127\.0\.0\.1|https?:\/\//u, '本地或网络地址'],
    [/\bdiagnostics\b/iu, '诊断记录'],
    [/\b(token|accessToken)\b/iu, '访问令牌'],
    [/chrome\.debug\b/u, '调试 API'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(source), false, `公开运行时不包含${label}`);
  }
});
