import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSiteJson, waitForRequestSlot } from '../scripts/site-response.mjs';

const origin = 'https://www.zhipin.com';
const endpoints = ['/wapi/zpuser/wap/getUserInfo.json',
  '/wapi/zprelation/friend/geekFilterByLabel', '/wapi/zpchat/geek/historyMsg'];

test('account, list, and history share fixed request slots with no site retries', async () => {
  let clock = 0, nextRequestAt = 0;
  const slotCalls = [], starts = [], waits = [];
  const beforeRequest = ({ endpoint, signal }) => waitForRequestSlot({ endpoint, signal,
    requestSlot: async message => {
      slotCalls.push(message);
      if (clock < nextRequestAt) return { ok: true, waitMs: nextRequestAt - clock };
      nextRequestAt = clock + 10_000;
      return { ok: true, waitMs: 0 };
    },
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
  });
  for (const endpoint of endpoints) {
    await fetchSiteJson(`${endpoint}?private=not-sent-to-slot`, { origin, beforeRequest,
      fetchImpl: async url => { starts.push({ at: clock, endpoint: new URL(url).pathname });
        return new Response('{"code":0}', { status: 200 }); },
    });
  }
  assert.deepEqual(starts.map(value => value.at), [0, 10_000, 20_000]);
  assert.deepEqual(starts.map(value => value.endpoint), endpoints);
  assert.deepEqual(waits, [10_000, 10_000]);
  assert.equal(starts.length, 3, 'positive local wait responses do not repeat site fetches');
  assert.equal(slotCalls.length, 5);
  assert.equal(slotCalls.every(message => message.type === 'SITE_REQUEST_SLOT'), true);
  assert.equal(slotCalls.every(message => endpoints.includes(message.endpoint)), true);
  assert.equal(JSON.stringify(slotCalls).includes('private'), false);
});

test('STOP cancels a scheduled wait before any site request starts', async () => {
  const controller = new AbortController();
  let slotCalls = 0, fetchCalls = 0;
  const request = fetchSiteJson(endpoints[2], { origin, signal: controller.signal,
    beforeRequest: options => waitForRequestSlot({ ...options,
      requestSlot: async () => { slotCalls++; return { ok: true, waitMs: 10_000 }; },
    }),
    fetchImpl: async () => { fetchCalls++; return new Response('{}'); },
  });
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  controller.abort('user stopped');
  await assert.rejects(request, error => error.code === 'SITE_REQUEST_ABORTED');
  assert.equal(slotCalls, 1);
  assert.equal(fetchCalls, 0);
});

test('STOP also cancels an outstanding local scheduling response', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  const request = fetchSiteJson(endpoints[2], { origin, signal: controller.signal,
    beforeRequest: options => waitForRequestSlot({ ...options,
      requestSlot: () => new Promise(() => {}),
    }),
    fetchImpl: async () => { fetchCalls++; return new Response('{}'); },
  });
  controller.abort();
  await assert.rejects(request, error => error.code === 'SITE_REQUEST_ABORTED');
  assert.equal(fetchCalls, 0);
});

test('network timeout starts after scheduling and still bounds fetch/body consumption', async () => {
  let fetchCalls = 0;
  const beforeRequest = () => new Promise(resolve => setTimeout(resolve, 20));
  const result = await fetchSiteJson(endpoints[2], { origin, beforeRequest, timeoutMs: 5,
    fetchImpl: async () => { fetchCalls++; return new Response('{"code":0}'); },
  });
  assert.equal(result.payload.code, 0);
  await assert.rejects(fetchSiteJson(endpoints[2], { origin, beforeRequest, timeoutMs: 5,
    fetchImpl: async () => { fetchCalls++; return new Promise(() => {}); },
  }), error => error.code === 'SITE_REQUEST_TIMEOUT');
  assert.equal(fetchCalls, 2);
});

test('missing or denied local scheduler never falls back to unrestricted fetch', async () => {
  for (const requestSlot of [undefined, async () => ({ ok: false }), async () => {
    throw new Error('local channel unavailable');
  }]) {
    let fetchCalls = 0;
    await assert.rejects(fetchSiteJson(endpoints[2], { origin,
      beforeRequest: options => waitForRequestSlot({ ...options, requestSlot }),
      fetchImpl: async () => { fetchCalls++; return new Response('{}'); },
    }), error => error.code === 'SITE_REQUEST_SCHEDULER_UNAVAILABLE');
    assert.equal(fetchCalls, 0);
  }
});
