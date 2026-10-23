import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ChromeWebStoreApiError,
  fetchItemStatus,
  getChromeWebStoreConfig,
  publishItem,
  runCli,
  uploadPackage,
} from '../scripts/chrome-webstore.mjs';

const accessToken = 'synthetic-cws-access-token';
const env = {
  CWS_PUBLISHER_ID: '12345678901234567890',
  CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  CWS_ACCESS_TOKEN: accessToken,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withSyntheticZip(run) {
  const tempParent = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempParent, 'cws-api-test-'));
  const zipPath = join(directory, 'synthetic-extension.zip');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x10, 0x20, 0x30, 0x40]);
  await writeFile(zipPath, bytes);
  try {
    await run({ directory, zipPath, bytes });
  } finally {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved).toLowerCase(), tempParent.toLowerCase());
    assert.match(resolved.split(/[\\/]/u).at(-1), /^cws-api-test-/u);
    await rm(resolved, { recursive: true, force: true });
  }
}

test('builds only fixed Chrome Web Store v2 URLs from safe ID path segments', () => {
  const config = getChromeWebStoreConfig(env);
  assert.equal(config.statusUrl,
    'https://chromewebstore.googleapis.com/v2/publishers/12345678901234567890/items/abcdefghijklmnopabcdefghijklmnop:fetchStatus');
  assert.equal(config.uploadUrl,
    'https://chromewebstore.googleapis.com/upload/v2/publishers/12345678901234567890/items/abcdefghijklmnopabcdefghijklmnop:upload');
  assert.equal(config.publishUrl,
    'https://chromewebstore.googleapis.com/v2/publishers/12345678901234567890/items/abcdefghijklmnopabcdefghijklmnop:publish');
  assert.throws(() => getChromeWebStoreConfig({ ...env, CWS_PUBLISHER_ID: '../attacker' }), /single safe/);
  assert.throws(() => getChromeWebStoreConfig({ ...env, CWS_EXTENSION_ID: 'item/other' }), /single safe/);
});

test('status uses the v2 fetchStatus endpoint and does not send a body', async () => {
  let request;
  const status = { itemId: env.CWS_EXTENSION_ID, publishedItemRevisionStatus: { state: 'PUBLISHED' } };
  const result = await fetchItemStatus({
    env,
    fetchImpl: async (url, init) => {
      request = { url, ...init };
      return jsonResponse(status);
    },
  });

  assert.deepEqual(result, status);
  assert.equal(request.method, 'GET');
  assert.match(request.url, /:fetchStatus$/);
  assert.equal(request.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(request.body, undefined);
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.signal.aborted, false);
  assert.equal(request.redirect, 'error');
});

test('status rejects empty and non-JSON success responses instead of reporting success', async (context) => {
  const emptyResponse = {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
  };
  await context.test('empty response', async () => {
    await assert.rejects(fetchItemStatus({ env, fetchImpl: async () => emptyResponse }), /empty response body/);
  });

  await context.test('HTML response', async () => {
    await assert.rejects(fetchItemStatus({
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<!doctype html><title>sign in</title>',
      }),
    }), /non-JSON response body/);
  });
});

test('status reports response body read errors and redacts token echoes', async () => {
  await assert.rejects(fetchItemStatus({
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => { throw new Error(`stream closed after ${accessToken}`); },
    }),
  }), (error) => {
    assert.match(error.message, /response body could not be read/);
    assert.doesNotMatch(error.message, new RegExp(accessToken));
    return true;
  });
});

test('upload sends the synthetic ZIP as raw media and accepts a synchronous success', async () => {
  await withSyntheticZip(async ({ zipPath, bytes }) => {
    const requests = [];
    const result = await uploadPackage({
      zipPath,
      env,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: '0.8.12' });
      },
    });

    assert.equal(result.uploadState, 'SUCCEEDED');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/upload\/v2\/publishers\/.*:upload$/);
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers['Content-Type'], 'application/zip');
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${accessToken}`);
    assert.deepEqual(Buffer.from(requests[0].init.body), bytes);
  });
});

test('upload polls v2 fetchStatus until asynchronous upload succeeds', async () => {
  await withSyntheticZip(async ({ zipPath }) => {
    const requests = [];
    const delays = [];
    const responses = [
      jsonResponse({ uploadState: 'IN_PROGRESS' }),
      jsonResponse({ lastAsyncUploadState: 'IN_PROGRESS' }),
      jsonResponse({ lastAsyncUploadState: 'SUCCEEDED', itemId: env.CWS_EXTENSION_ID }),
    ];
    const result = await uploadPackage({
      zipPath,
      env,
      pollIntervalMs: 7,
      maxPollAttempts: 3,
      sleepImpl: async (ms) => delays.push(ms),
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return responses.shift();
      },
    });

    assert.equal(result.uploadState, 'SUCCEEDED');
    assert.equal(result.finalStatus.lastAsyncUploadState, 'SUCCEEDED');
    assert.equal(requests.length, 3);
    assert.match(requests[1].url, /:fetchStatus$/);
    assert.equal(requests[1].init.method, 'GET');
    assert.deepEqual(delays, [7, 7]);
  });
});

test('upload also accepts the documented UPLOAD_IN_PROGRESS spelling', async () => {
  await withSyntheticZip(async ({ zipPath }) => {
    let requests = 0;
    const result = await uploadPackage({
      zipPath,
      env,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? jsonResponse({ uploadState: 'UPLOAD_IN_PROGRESS' })
          : jsonResponse({ lastAsyncUploadState: 'SUCCEEDED' });
      },
    });

    assert.equal(result.uploadState, 'SUCCEEDED');
    assert.equal(requests, 2);
  });
});

test('failed or unresolved asynchronous uploads reject so a workflow cannot continue to publish', async () => {
  await withSyntheticZip(async ({ zipPath }) => {
    let requests = 0;
    await assert.rejects(uploadPackage({
      zipPath,
      env,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? jsonResponse({ uploadState: 'IN_PROGRESS' })
          : jsonResponse({ lastAsyncUploadState: 'FAILED' });
      },
    }), /asynchronous ZIP upload failed/);
    assert.equal(requests, 2);

    requests = 0;
    await assert.rejects(uploadPackage({
      zipPath,
      env,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? jsonResponse({ uploadState: 'IN_PROGRESS' })
          : jsonResponse({ lastAsyncUploadState: 'IN_PROGRESS' });
      },
    }), /still in progress after 2 status checks/);
    assert.equal(requests, 3);
  });
});

test('publish explicitly requests DEFAULT_PUBLISH and leaves skipReview unset', async () => {
  let request;
  const response = { itemId: env.CWS_EXTENSION_ID, state: 'PENDING_REVIEW' };
  const result = await publishItem({
    env,
    fetchImpl: async (url, init) => {
      request = { url, ...init };
      return jsonResponse(response);
    },
  });

  assert.deepEqual(result, response);
  assert.match(request.url, /\/v2\/publishers\/.*:publish$/);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), { publishType: 'DEFAULT_PUBLISH' });
  assert.equal(JSON.parse(request.body).skipReview, undefined);
});

test('API errors retain useful status details while redacting token echoes', async () => {
  let thrown;
  try {
    await fetchItemStatus({
      env,
      fetchImpl: async () => jsonResponse({
        error: {
          code: 401,
          status: 'UNAUTHENTICATED',
          message: `Rejected Bearer ${accessToken}; also echoed ${accessToken}`,
        },
      }, 401),
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ChromeWebStoreApiError);
  assert.equal(thrown.httpStatus, 401);
  assert.equal(thrown.apiStatus, 'UNAUTHENTICATED');
  assert.match(thrown.message, /401 UNAUTHENTICATED/);
  assert.match(thrown.message, /\[REDACTED\]/);
  assert.doesNotMatch(thrown.message, new RegExp(accessToken));
});

test('CLI status output redacts a token echoed by a successful API payload', async () => {
  const lines = [];
  await runCli(['status'], {
    env,
    stdout: (line) => lines.push(line),
    fetchImpl: async () => jsonResponse({ diagnostic: accessToken }),
  });
  assert.match(lines[0], /\[REDACTED\]/);
  assert.doesNotMatch(lines[0], new RegExp(accessToken));
});

test('upload rejects missing and empty ZIP files without making API requests', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({ uploadState: 'SUCCEEDED' });
  };
  await assert.rejects(uploadPackage({ env, fetchImpl }), /requires --zip/);
  await withSyntheticZip(async ({ directory }) => {
    const emptyPath = join(directory, 'empty.zip');
    await writeFile(emptyPath, Buffer.alloc(0));
    await assert.rejects(uploadPackage({ zipPath: emptyPath, env, fetchImpl }), /ZIP package is empty/);
  });
  assert.equal(requests, 0);
});
