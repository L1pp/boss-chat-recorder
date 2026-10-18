import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiMessage, inferSelfUidFromMessages, readAvailableConversationHistory } from '../scripts/history-api-reader.mjs';

const origin = 'https://www.zhipin.com';
const text = (mid, sender, time = 1791960813932) => ({ mid, received: true, time,
  type: 3, from: { uid: sender }, to: { uid: sender === 'self' ? 'peer' : 'self' },
  body: { type: 1, text: `message ${mid}` } });
const response = payload => ({ status: 200, ok: true, json: async () => payload });
const account = { accountUid: 'self' };

test('normalization preserves message IDs, sender, epoch, and media payload', () => {
  const raw = text('90071992547409931234', 'hr');
  const message = normalizeApiMessage(raw, { selfUid: 'self' });
  assert.equal(message.messageId, raw.mid);
  assert.equal(message.direction, 'hr');
  assert.equal(message.sentAtISO, new Date(raw.time).toISOString());
  assert.equal(message.rawApiMessage, raw);
  assert.equal(normalizeApiMessage(raw).direction, 'unknown');
  assert.equal(normalizeApiMessage(text('2', 'self'), { selfUid: 'self' }).direction, 'self');
  assert.equal(inferSelfUidFromMessages([raw, text('2', 'self')], { friendUid: 'hr' }), 'self');
  assert.equal(normalizeApiMessage(text('2', 'self', 1791960813)).sentAtISO,
    new Date(1791960813000).toISOString());
  assert.equal(normalizeApiMessage({ type: 4, received: true, body: { type: 16 } }).direction, 'system');
  assert.equal(normalizeApiMessage({ type: 3, body: { type: 4,
    action: { text: '对方撤回了一条消息' } } }, { selfUid: 'self' }).kind, 'system');
  assert.equal(normalizeApiMessage({ type: 3, body: { type: 4,
    headTitle: '你撤回了一条消息' } }, { selfUid: 'self' }).direction, 'system');
  const image = { mid: '3', received: false, body: { type: 3, image: { url: 'media-reference' } } };
  assert.equal(normalizeApiMessage(image).kind, 'attachment');
  assert.deepEqual(normalizeApiMessage(image).rawApiMessage.body.image, image.body.image);
});

test('pages by precise MID cursor and returns chronological unique messages when hasMore is false', async () => {
  const calls = [], saved = [];
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer', hrName: 'Synthetic HR', company: 'Demo Studio', hrRole: 'Recruiter' },
    fetchImpl: async (href, options) => {
      calls.push({ url: new URL(href), options });
      return response(calls.length === 1
        ? { code: 0, zpData: { hasMore: true, messages: [text('90071992547409931234', 'peer'), text('90071992547409931235', 'self')] } }
        : { code: 0, zpData: { hasMore: false, minMsgId: '90071992547409931230', messages: [text('90071992547409931230', 'self'), text('90071992547409931234', 'peer')] } });
    }, onPage: page => saved.push(page) });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('maxMsgId'), '90071992547409931234');
  assert.equal(calls[1].url.searchParams.get('page'), '2');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.cache, undefined);
  assert.equal(saved.length, 2);
  assert.equal(result.selfUid, 'self');
  assert.deepEqual(saved[0].messages.map(message => message.direction), ['hr', 'self']);
  assert.equal(saved[1].historyCoverage.availableHistoryComplete, true);
  assert.deepEqual(result.messages.map(message => message.messageId),
    ['90071992547409931230', '90071992547409931234', '90071992547409931235']);
  assert.equal(result.availableHistoryComplete, true);
  assert.equal(result.completeReason, 'api_has_more_false');
  assert.equal(result.firstRealMessage.direction, 'self');
  assert.equal(result.historyCoverage.startReached, false);
  assert.equal(result.snapshot.messages.fullHistoryVerified, false);
});

test('non-advancing cursor returns saved pages and an incomplete result instead of looping', async () => {
  let calls = 0;
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => {
      calls++;
      return response({ code: 0, zpData: { hasMore: true, minMsgId: '5', messages: [text('5', 'peer')] } });
    } });
  assert.equal(calls, 2);
  assert.equal(result.availableHistoryComplete, false);
  assert.equal(result.error.code, 'cursor_not_advanced');
  assert.equal(result.pages.length, 2);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].contentText, 'message 5');
});

test('missing manually authenticated account fails before a history request', async () => {
  let calls = 0;
  const result = await readAvailableConversationHistory({ bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => { calls++; return response({ code: 0, zpData: { hasMore: false, messages: [] } }); } });
  assert.equal(calls, 0);
  assert.equal(result.error.code, 'account_uid_required');
  assert.equal(result.pages.length, 0);
});

test('history reader rejects account UIDs outside the shared account-store format', async () => {
  let calls = 0;
  for (const accountUid of [0, '0', '', 'user@example', 'x'.repeat(129), 9007199254740992]) {
    const result = await readAvailableConversationHistory({ accountUid, bossId: 'boss', origin,
      identity: { uid: 'peer' },
      fetchImpl: async () => { calls++; return response({ code: 0, zpData: { hasMore: false, messages: [] } }); },
    });
    assert.equal(result.error.code, 'account_uid_required');
    assert.equal(result.pages.length, 0);
  }
  assert.equal(calls, 0);
});

test('local cancellation after a page stops further history requests without probing userinfo', async () => {
  let calls = 0;
  const controller = new AbortController();
  const delivered = [];
  const result = await readAvailableConversationHistory({ accountUid: 'self', bossId: 'boss', origin,
    identity: { uid: 'peer' }, signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return response({ code: 0, zpData: { hasMore: true, messages: [text(String(calls), 'peer')] } });
    },
    onPage: page => { delivered.push(page); controller.abort('user stopped'); },
  });
  assert.equal(calls, 1);
  assert.equal(delivered.length, 1);
  assert.equal(result.pages.length, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.error.code, 'aborted');
  assert.equal(result.selfUid, 'self');
});

test('a history page with an explicit foreign participant is rejected whole', async () => {
  let delivered = 0;
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => response({ code: 0, zpData: { hasMore: false,
      messages: [text('foreign-1', 'other-account')] } }),
    onPage: () => { delivered++; },
  });
  assert.equal(result.error.code, 'foreign_account_message');
  assert.equal(result.pages.length, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(delivered, 0);
});

test('unsafe numeric participant IDs cannot be rounded into the authenticated UID', async () => {
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => response({ code: 0, zpData: { hasMore: false, messages: [
      { mid: 'unsafe-1', type: 3, from: { uid: 9007199254740992 }, to: { uid: 'peer' }, body: { type: 1 } },
    ] } }),
  });
  assert.equal(result.error.code, 'foreign_account_message');
  assert.equal(result.pages.length, 0);
});

test('a real HTML login page stops paging and preserves an earlier valid page', async () => {
  let calls = 0;
  const delivered = [];
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ code: 0, zpData: {
        hasMore: true, minMsgId: '10', messages: [text('10', 'peer')],
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      const response = new Response('<!doctype html><html><body>login</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
      Object.defineProperty(response, 'url', { value: `${origin}/web/login?private=uid` });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
    onPage: value => delivered.push(value),
  });
  assert.equal(calls, 2);
  assert.equal(delivered.length, 1);
  assert.equal(result.pages.length, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '10');
  assert.equal(result.availableHistoryComplete, false);
  assert.equal(result.error.code, 'SITE_NON_JSON_RESPONSE');
  assert.equal(result.error.details.responseKind, 'html');
  assert.equal(result.error.details.finalPath, '/web/login');
  assert.equal(JSON.stringify(result.error.details).includes('private'), false);
  assert.equal(result.error.message.includes('<!doctype'), false);
});

test('history requestTimeoutMs covers body reading without a remote account guard', async () => {
  const result = await readAvailableConversationHistory({ accountUid: 'self', bossId: 'boss', origin,
    identity: { uid: 'peer' }, requestTimeoutMs: 10,
    fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: () => 'application/json' }, text: () => new Promise(() => {}) }),
  });
  assert.equal(result.error.code, 'SITE_REQUEST_TIMEOUT');
  assert.equal(result.error.details.timeoutMs, 10);
  assert.equal(result.pages.length, 0);
});

test('a site API failure stops the page without storing its response message', async () => {
  let calls = 0;
  const result = await readAvailableConversationHistory({ ...account, bossId: 'boss', origin,
    identity: { uid: 'peer' },
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ code: 1001, message: 'private site detail',
        zpData: { messages: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.error.code, 'SITE_API_ERROR');
  assert.equal(result.error.details.endpoint, '/wapi/zpchat/geek/historyMsg');
  assert.equal(result.error.details.httpStatus, 200);
  assert.equal(result.error.details.responseKind, 'api_error');
  assert.equal(JSON.stringify(result.error.details).includes('private'), false);
  assert.equal(result.error.message.includes('private'), false);
  assert.equal(result.pages.length, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(calls, 1);
});
