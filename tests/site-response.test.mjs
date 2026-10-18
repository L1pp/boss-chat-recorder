import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { fetchSiteJson, readSiteJsonResponse } from '../scripts/site-response.mjs';

const origin = 'https://www.zhipin.com';

test('accepts valid JSON even when the response MIME is not JSON', async () => {
  const result = await fetchSiteJson('/wapi/example?private=do-not-echo', {
    origin,
    fetchImpl: async () => new Response('{"code":0,"zpData":{}}', {
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
  });
  assert.deepEqual(result.payload, { code: 0, zpData: {} });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.finalPath, '/wapi/example');
});

test('real HTML Response is classified without exposing its body or query string', async () => {
  const body = '<!doctype html><html><body>private-login-page and csrf-secret</body></html>';
  const fetchCalls = [];
  await assert.rejects(fetchSiteJson('/wapi/history?bossId=private-uid&token=secret', {
    origin,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: new URL(url), options });
      const response = new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      Object.defineProperty(response, 'url', { value: 'https://www.zhipin.com/web/login?next=private-uid' });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
  }), error => {
    assert.equal(error.code, 'SITE_NON_JSON_RESPONSE');
    assert.match(error.message, /网站返回了网页/u);
    assert.equal(error.details.endpoint, '/wapi/history');
    assert.equal(error.details.httpStatus, 200);
    assert.equal(error.details.contentType, 'text/html');
    assert.equal(error.details.redirected, true);
    assert.equal(error.details.finalPath, '/web/login');
    assert.equal(error.details.responseKind, 'html');
    assert.equal(JSON.stringify(error.details).includes('private'), false);
    assert.equal(JSON.stringify(error.details).includes('secret'), false);
    assert.equal(error.message.includes(body), false);
    return true;
  });
  assert.equal(fetchCalls.length, 1, 'does not retry login redirects');
  assert.equal(fetchCalls[0].options.method, 'GET');
  assert.equal(fetchCalls[0].options.credentials, 'same-origin');
  assert.equal(fetchCalls[0].options.cache, undefined);
});

test('observed BOSS verification redirect asks for manual verification and no retry', async () => {
  let calls = 0;
  await assert.rejects(fetchSiteJson('/wapi/history?private=uid', {
    origin,
    fetchImpl: async () => {
      calls++;
      const response = new Response('<!doctype html><html><body>verification</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      Object.defineProperty(response, 'url', {
        value: `${origin}/web/passport/zp/verify.html?token=private-secret`,
      });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
  }), error => {
    assert.equal(error.code, 'SITE_VERIFICATION_REQUIRED');
    assert.match(error.message, /手动完成验证/u);
    assert.match(error.message, /不要重新采集/u);
    assert.equal(error.details.finalPath, '/web/passport/zp/verify.html');
    assert.equal(error.details.responseKind, 'html');
    assert.equal(error.details.redirected, true);
    assert.equal(JSON.stringify(error.details).includes('private'), false);
    assert.equal(JSON.stringify(error.details).includes('token'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('classifies login and transient HTTP statuses without parsing their bodies', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(readSiteJsonResponse(new Response('private-body', {
      status, headers: { 'content-type': 'text/html' },
    }), { endpoint: '/wapi/example?uid=private' }), error => {
      assert.equal(error.code, 'SITE_HTTP_ERROR');
      assert.equal(error.details.httpStatus, status);
      assert.equal(error.details.endpoint, '/wapi/example');
      assert.equal(error.details.responseKind, 'http_error');
      assert.equal(JSON.stringify(error.details).includes('private'), false);
      return true;
    });
  }
});

test('malformed JSON and empty responses return safe site errors', async () => {
  for (const [body, responseKind] of [['{"truncated":', 'invalid_json'], ['', 'empty']]) {
    await assert.rejects(readSiteJsonResponse(new Response(body, {
      status: 200, headers: { 'content-type': 'application/json' },
    }), { endpoint: '/wapi/example' }), error => {
      assert.equal(error.code, 'SITE_NON_JSON_RESPONSE');
      assert.equal(error.details.responseKind, responseKind);
      assert.equal(JSON.stringify(error.details).includes('truncated'), false);
      return true;
    });
  }
});

test('timeout covers response body reading and does not retry', async () => {
  let calls = 0;
  await assert.rejects(fetchSiteJson('/wapi/slow', {
    origin, timeoutMs: 10,
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: () => new Promise(() => {}) };
    },
  }), error => {
    assert.equal(error.code, 'SITE_REQUEST_TIMEOUT');
    assert.equal(error.details.endpoint, '/wapi/slow');
    assert.equal(error.details.timeoutMs, 10);
    return true;
  });
  assert.equal(calls, 1);
});

test('rejects cross-origin URLs before fetch', async () => {
  let calls = 0;
  await assert.rejects(fetchSiteJson('https://example.test/data', {
    origin, fetchImpl: async () => { calls++; return new Response('{}'); },
  }), error => error.code === 'SITE_ORIGIN_ERROR');
  assert.equal(calls, 0);
});

test('built bulk bundle preserves the site abort code despite collector abort helpers', async () => {
  const bundle = await readFile(new URL('../extension-tracker/content/bulk.bundle.js', import.meta.url), 'utf8');
  let fetchCalls = 0;
  const context = createContext({
    AbortController, URL, setTimeout, clearTimeout,
    location: { origin },
    fetch: async () => { fetchCalls++; throw new Error('must not fetch an aborted request'); },
  });
  new Script(bundle, { filename: 'bulk.bundle.js' }).runInContext(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(context.__bossAccountReader.read({ signal: controller.signal }), error => {
    assert.equal(error.code, 'SITE_REQUEST_ABORTED');
    return true;
  });
  assert.equal(fetchCalls, 0);
});
