import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountReader } from '../scripts/account-reader.mjs';

test('reads the current UID from the fresh same-origin no-store user-info response', async () => {
  let requested;
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async (url, options) => {
      requested = { url: new URL(url), options };
      return { ok: true, status: 200, json: async () => ({ code: '0', zpData: { userId: 7001 } }) };
    } });
  assert.deepEqual(await reader.read(), { uid: '7001' });
  assert.equal(requested.url.pathname, '/wapi/zpuser/wap/getUserInfo.json');
  assert.equal(requested.options.method, 'GET');
  assert.equal(requested.options.mode, 'same-origin');
  assert.equal(requested.options.credentials, 'same-origin');
  assert.equal(requested.options.cache, 'no-store');
});

test('rejects unknown, malformed, and imprecise account identities', async t => {
  const cases = [
    ['HTTP failure', { ok: false, status: 401, json: async () => ({}) }],
    ['API failure', { ok: true, status: 200, json: async () => ({ code: 1, zpData: { userId: '7' } }) }],
    ['missing UID', { ok: true, status: 200, json: async () => ({ code: 0, zpData: {} }) }],
    ['zero numeric UID', { ok: true, status: 200, json: async () => ({ code: 0, zpData: { userId: 0 } }) }],
    ['zero string UID', { ok: true, status: 200, json: async () => ({ code: 0, zpData: { userId: '0' } }) }],
    ['illegal UID characters', { ok: true, status: 200, json: async () => ({ code: 0, zpData: { userId: 'user@example' } }) }],
    ['overlong UID', { ok: true, status: 200, json: async () => ({ code: 0, zpData: { userId: 'a'.repeat(129) } }) }],
    ['unsafe numeric UID', { ok: true, status: 200, json: async () => ({ code: 0, zpData: { userId: 9007199254740992 } }) }],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
      fetchImpl: async () => response });
    await assert.rejects(reader.read());
  });
});

test('does not make a request outside an approved BOSS origin', async () => {
  let calls = 0;
  const reader = createAccountReader({ getOrigin: () => 'https://example.test',
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(reader.read());
  assert.equal(calls, 0);
});

test('fresh sequential reads do not reuse a completed account UID', async () => {
  let calls = 0;
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, zpData: { userId: ++calls } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) });
  assert.deepEqual(await reader.read(), { uid: '1' });
  assert.deepEqual(await reader.read(), { uid: '2' });
  assert.equal(calls, 2);
});

test('overlapping identity checks issue separate fresh requests', async () => {
  const releases = [];
  let calls = 0;
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async () => {
      const requestIndex = calls++;
      await new Promise(resolve => { releases[requestIndex] = resolve; });
      return new Response(JSON.stringify({ code: 0, zpData: { userId: requestIndex === 0 ? 'account-a' : 'account-b' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } });
  const first = reader.read();
  const second = reader.read();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(calls, 2);
  releases[0]();
  releases[1]();
  assert.deepEqual(await Promise.all([first, second]), [{ uid: 'account-a' }, { uid: 'account-b' }]);
});

test('does not turn an HTML login response into an account identity', async () => {
  let calls = 0;
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async () => {
      calls++;
      return new Response('<!doctype html><html><body>login</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    } });
  await assert.rejects(reader.read(), error => {
    assert.equal(error.code, 'SITE_NON_JSON_RESPONSE');
    assert.equal(error.details.endpoint, '/wapi/zpuser/wap/getUserInfo.json');
    assert.equal(error.details.responseKind, 'html');
    assert.equal(error.message.includes('<!doctype'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('API-level identity failure exposes only safe response metadata', async () => {
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async () => new Response(JSON.stringify({ code: 1001, message: 'private site detail',
      zpData: { userId: 'private-uid' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) });
  await assert.rejects(reader.read(), error => {
    assert.equal(error.code, 'SITE_API_ERROR');
    assert.equal(error.details.endpoint, '/wapi/zpuser/wap/getUserInfo.json');
    assert.equal(error.details.httpStatus, 200);
    assert.equal(error.details.responseKind, 'api_error');
    assert.equal(JSON.stringify(error.details).includes('private'), false);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('account lookup timeout is bounded and fails closed', async () => {
  let calls = 0;
  const reader = createAccountReader({ getOrigin: () => 'https://www.zhipin.com',
    fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(reader.read({ timeoutMs: 10 }), error => {
    assert.equal(error.code, 'SITE_REQUEST_TIMEOUT');
    assert.equal(error.details.timeoutMs, 10);
    assert.equal(error.details.endpoint, '/wapi/zpuser/wap/getUserInfo.json');
    return true;
  });
  assert.equal(calls, 1);
});

