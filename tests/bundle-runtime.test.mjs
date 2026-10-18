import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createExtensionMessageHandler } from '../extension-tracker/service-worker.js';
import { createAccountStore } from '../extension-tracker/account-store.mjs';
import { createStoragePortServer } from '../extension-tracker/storage-port-server.mjs';

function event() {
  const listeners = new Set();
  return { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
    emit: value => { for (const callback of [...listeners]) callback(value); } };
}

function portPair(sender) {
  let closed = false;
  const client = { onMessage: event(), onDisconnect: event() };
  const server = { onMessage: event(), onDisconnect: event(), sender, name: 'bossReadonlyTracker.storage.v1' };
  const disconnect = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => { client.onDisconnect.emit(); server.onDisconnect.emit(); });
  };
  client.disconnect = server.disconnect = disconnect;
  client.postMessage = value => {
    if (closed) throw new Error('PORT_CLOSED');
    queueMicrotask(() => server.onMessage.emit(structuredClone(value)));
  };
  server.postMessage = value => {
    if (closed) throw new Error('PORT_CLOSED');
    queueMicrotask(() => client.onMessage.emit(structuredClone(value)));
  };
  return { client, server };
}

// Execute the actual checked-in content bundles in an isolated JavaScript VM.
// This is a contract integration test, not a browser or network test.
test('built collector and real worker isolate overlapping IDs, resume only their own baseline and clear one account',
  { timeout: 5000 }, async () => {
    const origin = 'https://www.zhipin.com';
    const url = `${origin}/web/geek/chat`;
    const extensionId = 'demo-showcase-extension';
    const tabId = 7;
    let currentUid = 'demo-user-a';
    let handleMessage;
    let finished;
    const historyAccounts = [];
    let accountLookups = 0;
    let portRequests = 0;
    const onConnect = event();
    const legacy = { synthetic: true, text: 'demo-unassigned-legacy' };
    const memory = { 'bossReadonlyTracker.v2': structuredClone(legacy) };
    const ui = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
    const collectorSender = { id: extensionId, tab: { id: tabId, url }, url };
    const dispatchCollector = async message => {
      const result = await handleMessage(structuredClone(message), collectorSender);
      if (message.type === 'BULK_PROGRESS' && message.progress.active === false) {
        finished?.({ message: structuredClone(message), result });
      }
      return result;
    };
    const storagePorts = createStoragePortServer({ runtime: { onConnect },
      isTrustedSender: sender => sender.id === extensionId && sender.tab?.id === tabId,
      handleMessage: dispatchCollector,
    });
    const response = payload => ({ ok: true, status: 200, json: async () => payload });
    const context = vm.createContext({
      URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
      crypto: webcrypto,
      location: { origin, pathname: '/web/geek/chat', protocol: 'https:', hostname: 'www.zhipin.com' },
      document: { visibilityState: 'hidden', hasFocus: () => false },
      performance: { getEntriesByType: () => [
        { name: `${origin}/wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=demo-system` },
      ] },
      fetch: async href => {
        const route = new URL(href).pathname;
        if (route === '/wapi/zpuser/wap/getUserInfo.json') {
          accountLookups++;
          return response({ code: 0, zpData: { userId: currentUid } });
        }
        if (route === '/wapi/zprelation/friend/geekFilterByLabel') {
          return response({ code: 0, zpData: { friendList: [{ friendId: 'demo-hr-shared',
            encryptFriendId: 'demo-encoded-hr', brandName: '示例甲', name: '顾问甲',
            bossTitle: '合成招聘者', updateTime: 1 }] } });
        }
        if (route === '/wapi/zpchat/geek/historyMsg') {
          historyAccounts.push(currentUid);
          return response({ code: 0, zpData: { hasMore: false, minMsgId: '101', messages: [{
            mid: '101', type: 3, from: { uid: 'demo-hr-shared' }, to: { uid: currentUid },
            time: 1792231200000, body: { type: 1, text: `合成内容 ${currentUid}` },
          }] } });
        }
        throw new Error(`Unmocked route: ${route}`);
      },
      chrome: { runtime: { sendMessage: dispatchCollector, connect: options => {
        assert.equal(options.name, 'bossReadonlyTracker.storage.v1');
        portRequests++;
        const pair = portPair(collectorSender);
        onConnect.emit(pair.server);
        return pair.client;
      } } },
    });
    const chromeApi = {
      runtime: { id: extensionId },
      tabs: { get: async id => ({ id, url }) },
      storage: { local: {
        get: async key => ({ [key]: structuredClone(memory[key]) }),
        set: async values => Object.assign(memory, structuredClone(values)),
      } },
      scripting: { executeScript: async ({ files, func, args = [] }) => {
        if (files) {
          for (const file of files) {
            const source = await readFile(new URL(`../extension-tracker/${file}`, import.meta.url), 'utf8');
            await vm.runInContext(source, context, { filename: file });
          }
          return [{ result: null }];
        }
        context.__testArgs = structuredClone(args);
        const result = await vm.runInContext(`(${func.toString()})(...__testArgs)`, context);
        return [{ result: structuredClone(result) }];
      } },
    };
    handleMessage = createExtensionMessageHandler(chromeApi, { requestIntervalMs: 0,
      onStorageActivity: () => storagePorts.activity() });
    const call = (type, fields = {}) => handleMessage({ type, tabId,
      expectedAccountUid: currentUid, ...fields }, ui);
    async function collect() {
      const completion = new Promise(resolve => { finished = resolve; });
      const start = await call('START_UPDATE');
      assert.equal(start.ok, true, start.message);
      const done = await completion;
      assert.equal(done.result.ok, true, done.result.message);
      assert.equal(done.message.progress.status, 'completed', done.message.progress.error);
      const live = await call('GET_BULK_PROGRESS');
      assert.equal(live.ok, true);
      const partition = await createAccountStore(chromeApi).getAccount(currentUid);
      assert.equal(partition.runtime.progressByTab[String(tabId)].collectionToken, start.progress.collectionToken);
      assert.equal(live.accountUid, currentUid);
      return live.progress;
    }

    await collect();
    const first = await call('EXPORT_AI_INPUT', { scope: 'all' });
    assert.equal(first.analysisInput.conversations[0].messages[0].text, '合成内容 demo-user-a');
    handleMessage = createExtensionMessageHandler(chromeApi, { requestIntervalMs: 0,
      onStorageActivity: () => storagePorts.activity() }); // worker restart
    currentUid = 'demo-user-b';
    await collect();
    const second = await call('EXPORT_AI_INPUT', { scope: 'all' });
    assert.equal(second.analysisInput.conversations[0].messages[0].text, '合成内容 demo-user-b');
    assert.notEqual(first.analysisInput.sourceNamespace, second.analysisInput.sourceNamespace);
    assert.deepEqual(historyAccounts, ['demo-user-a', 'demo-user-b']);

    currentUid = 'demo-user-a';
    const unchanged = await collect();
    assert.equal(accountLookups, 3, 'one account request per manual start; local reads and saves add none');
    assert.equal(unchanged.selectedCount, 0);
    assert.deepEqual(historyAccounts, ['demo-user-a', 'demo-user-b']);
    const latest = await call('EXPORT_AI_INPUT');
    assert.deepEqual(latest.analysisInput.conversations, []);
    assert.equal((await call('EXPORT_AI_INPUT', { scope: 'all' })).analysisInput.conversations[0]
      .messages[0].text, '合成内容 demo-user-a');
    assert.equal((await call('CLEAR_ACCOUNT')).ok, true);
    assert.equal((await call('GET_STATE')).summary.messageCount, 0);
    currentUid = 'demo-user-b';
    assert.equal((await call('EXPORT_AI_INPUT', { scope: 'all' })).analysisInput.conversations[0]
      .messages[0].text, '合成内容 demo-user-b');
    assert.deepEqual(memory['bossReadonlyTracker.v2'], legacy);
    assert.ok(portRequests > 0, 'the built collector used the real storage port transport');
  });
