import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApiBulkCollector, discoverFriendListParams } from '../scripts/extension-api-bulk.mjs';
import { readAvailableConversationHistory } from '../scripts/history-api-reader.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listParams = { labelId: '0', encryptSystemId: 'demo-system' };
const contact = { encryptFriendId: 'enc-peer', friendId: 'peer-100', brandName: 'Demo Studio',
  name: 'Synthetic HR', bossTitle: 'Recruiter', updateTime: 123 };
const listResponse = { ok: true, status: 200,
  json: async () => ({ code: 0, zpData: { friendList: [contact] } }) };
const historyText = { mid: '10001', type: 3, from: { uid: 'peer-100' }, to: { uid: 'account-A' },
  body: { type: 1, text: 'Synthetic message' } };

function makeRun(options = {}) {
  const sent = [], requests = [];
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'test-token',
    listParams, origin: 'https://www.zhipin.com',
    document: { visibilityState: 'hidden', hasFocus: () => false },
    fetchImpl: async (url, init) => { requests.push({ url: new URL(url), init }); return options.fetchImpl ? options.fetchImpl(url, init) : listResponse; },
    readHistory: options.readHistory || (async () => ({ availableHistoryComplete: true, messages: [], pages: [] })),
    send: async message => {
      sent.push(message);
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) resolveFinished(message.progress);
      return { ok: true };
    },
  });
  const started = collector.start(options.previous || null);
  return { started, finished, sent, requests, collector };
}

test('real collector status exposes the collection token while idle and after start', () => {
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'status-token',
    listParams,
    readHistory: async () => ({ availableHistoryComplete: true, messages: [], pages: [] }),
    send: async () => ({ ok: true }),
  });
  assert.equal(collector.status().status, 'idle');
  assert.equal(collector.status().accountUid, 'account-A');
  assert.equal(collector.status().collectionToken, 'status-token');
  const started = collector.start();
  assert.equal(started.active, true);
  assert.equal(started.accountUid, 'account-A');
  assert.equal(started.collectionToken, 'status-token');
  collector.stop('test cleanup');
});

test('list parameters come only from a same-origin label-0 list request already in performance entries', () => {
  const result = discoverFriendListParams({ origin: 'https://www.zhipin.com', performance: {
    getEntriesByType: () => [
      { name: 'https://other.test/wapi/zprelation/friend/geekFilterByLabel?labelId=0&token=wrong' },
      { name: 'https://www.zhipin.com/wapi/zprelation/friend/geekFilterByLabel?labelId=1&token=wrong' },
      { name: 'https://www.zhipin.com/wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=synthetic-current-page' },
    ],
  } });
  assert.equal(result.get('labelId'), '0');
  assert.equal(result.get('encryptSystemId'), 'synthetic-current-page');
  assert.equal(discoverFriendListParams({ origin: 'https://www.zhipin.com',
    performance: { getEntriesByType: () => [] } }), null);
});

test('collector rejects account UIDs that do not match the account-store format', () => {
  for (const uid of [0, '0', '', 'account/other', 'x'.repeat(129), 9007199254740992]) {
    assert.throws(() => createApiBulkCollector({ accountUid: uid,
      collectionToken: 'invalid-uid-token' }), /账号 UID/u);
  }
  assert.doesNotThrow(() => createApiBulkCollector({ accountUid: 'demo-account_A-1',
    collectionToken: 'valid-demo-token', 
    readHistory: async () => ({ availableHistoryComplete: true, messages: [], pages: [] }) }));
});

test('the prototype request sequence is one list followed by history with no identity requests', async () => {
  const run = makeRun({ readHistory: readAvailableConversationHistory,
    fetchImpl: async url => new URL(url).pathname.endsWith('/geek/historyMsg')
      ? { ok: true, status: 200, json: async () => ({ code: 0,
          zpData: { hasMore: false, messages: [historyText] } }) }
      : listResponse });
  const progress = await run.finished;
  assert.equal(progress.status, 'completed');
  assert.deepEqual(run.requests.map(request => request.url.pathname), [
    '/wapi/zprelation/friend/geekFilterByLabel', '/wapi/zpchat/geek/historyMsg',
  ]);
  assert.equal(run.sent.filter(message => message.type === 'BULK_SNAPSHOTS').length, 1);
});

test('foreign native participants stop collection without another account request', async () => {
  let finish, historyCalls = 0;
  const sent = [];
  const done = new Promise(resolve => { finish = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'switch-page-token',
    listParams, origin: 'https://www.zhipin.com', fetchImpl: async () => listResponse,
    readHistory: options => readAvailableConversationHistory({ ...options,
      fetchImpl: async () => {
        historyCalls++;
        return { ok: true, status: 200, json: async () => ({ code: 0, zpData: {
          hasMore: historyCalls === 1, minMsgId: String(1000 - historyCalls),
          messages: [{ ...historyText, to: { uid: historyCalls === 1 ? 'account-A' : 'account-B' } }],
        } }) };
      },
    }),
    send: async message => {
      sent.push(message);
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return { ok: true };
    },
  });
  collector.start();
  const progress = await done;
  assert.equal(historyCalls, 2);
  assert.equal(progress.status, 'interrupted');
  assert.match(progress.error, /参与者.*不匹配/u);
  assert.equal(sent.some(message => message.type === 'BULK_SNAPSHOTS'), false);
  assert.ok(sent.every(message => message.accountUid === 'account-A' && message.collectionToken === 'switch-page-token'));
});

test('missing captured list parameters reports refresh guidance without sending a list request', async () => {
  let listCalls = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'missing-params-token',
    origin: 'https://www.zhipin.com',
    performance: { getEntriesByType: () => [] },
    readHistory: async () => ({ availableHistoryComplete: true, messages: [], pages: [] }),
    fetchImpl: async () => { listCalls++; return listResponse; },
    send: async message => {
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return { ok: true };
    },
  });
  collector.start();
  const progress = await done;
  assert.equal(listCalls, 0);
  assert.match(progress.error, /刷新沟通页后重试/u);
});

test('an HTML list response interrupts the run before any contact history is requested', async () => {
  let historyCalls = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'html-list-token',
    listParams, origin: 'https://www.zhipin.com',
    fetchImpl: async () => new Response('<!doctype html><html><title>Login</title></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
    readHistory: async () => { historyCalls++; return { availableHistoryComplete: true, messages: [], pages: [] }; },
    send: async message => {
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return { ok: true };
    },
  });
  collector.start();
  const progress = await done;
  assert.equal(historyCalls, 0);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.state, 'interrupted');
  assert.equal(progress.active, false);
  assert.equal(progress.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.match(progress.error, /网页而不是数据/u);
  assert.deepEqual(progress.errorDetails, {
    endpoint: '/wapi/zprelation/friend/geekFilterByLabel',
    httpStatus: 200,
    contentType: 'text/html',
    redirected: false,
    finalPath: '/wapi/zprelation/friend/geekFilterByLabel',
    responseKind: 'html',
  });
  assert.doesNotMatch(JSON.stringify(progress.errorDetails), /encryptSystemId|account-A|token/u);
});

test('an HTTP rate-limit response interrupts the run and does not expose response text', async () => {
  let historyCalls = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'http-error-token',
    listParams, origin: 'https://www.zhipin.com',
    fetchImpl: async () => new Response('private response body', {
      status: 429, headers: { 'content-type': 'text/html' },
    }),
    readHistory: async () => { historyCalls++; return { availableHistoryComplete: true, messages: [], pages: [] }; },
    send: async message => {
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return { ok: true };
    },
  });
  collector.start();
  const progress = await done;
  assert.equal(historyCalls, 0);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.errorCode, 'SITE_HTTP_ERROR');
  assert.equal(progress.errorDetails.httpStatus, 429);
  assert.equal(progress.errorDetails.responseKind, 'http_error');
  assert.doesNotMatch(JSON.stringify(progress.errorDetails), /private|account-A|token|\?/u);
});

test('a known BOSS verification redirect gives a manual verification message and keeps only its static path', async () => {
  let historyCalls = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const collector = createApiBulkCollector({ accountUid: 'account-A', collectionToken: 'verification-token',
    listParams, origin: 'https://www.zhipin.com',
    fetchImpl: async () => ({ ok: true, status: 200,
      url: 'https://www.zhipin.com/web/passport/zp/verify.html?token=private-value',
      redirected: true, headers: { get: () => 'text/html' },
      text: async () => '<!doctype html><html><title>Verify</title></html>',
    }),
    readHistory: async () => { historyCalls++; return { availableHistoryComplete: true, messages: [], pages: [] }; },
    send: async message => {
      if (message.type === 'BULK_PROGRESS' && !message.progress.active) finish(message.progress);
      return { ok: true };
    },
  });
  collector.start();
  const progress = await done;
  assert.equal(historyCalls, 0);
  assert.equal(progress.status, 'interrupted');
  assert.equal(progress.errorCode, 'SITE_VERIFICATION_REQUIRED');
  assert.match(progress.error, /手动完成验证/u);
  assert.match(progress.error, /勿|请勿连续重试/u);
  assert.equal(progress.errorDetails.finalPath, '/web/passport/zp/verify.html');
  assert.equal(progress.errorDetails.redirected, true);
  assert.doesNotMatch(JSON.stringify(progress.errorDetails), /private-value|\?/u);
});

test('build check confirms generated bundles and standalone MIT license copy', () => {
  const output = execFileSync(process.execPath, ['scripts/build-extension.mjs', '--check'], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(output, /bundles and license copy are current/u);
  const unknown = spawnSync(process.execPath, ['scripts/build-extension.mjs', '--unrecognized'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown build option/u);
});

