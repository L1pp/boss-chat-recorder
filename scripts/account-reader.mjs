import { fetchSiteJson, SiteResponseError } from './site-response.mjs';

// Fresh, same-origin BOSS account identity lookup for the public showcase.
// This intentionally does not inspect cookies, localStorage, or page internals.

function normalizeAccountUid(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value) || /^0+$/u.test(value)) return null;
  return value;
}

function isBossOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(url.hostname);
  } catch { return false; }
}

export function createAccountReader({ fetchImpl = globalThis.fetch,
  getOrigin = () => globalThis.location?.origin, beforeRequest } = {}) {
  return Object.freeze({
    async read({ signal, timeoutMs = 15_000 } = {}) {
      let origin;
      try { origin = getOrigin(); } catch { origin = null; }
      if (!isBossOrigin(origin)) throw new Error('请在 BOSS 直聘沟通页读取当前账号。');

      const endpoint = '/wapi/zpuser/wap/getUserInfo.json';
      const url = new URL(endpoint, origin);
      try {
        const result = await fetchSiteJson(url.href, {
          fetchImpl, signal, timeoutMs, endpoint, origin, beforeRequest, cache: 'no-store',
        });
        const { payload } = result;
        if (payload?.code !== 0 && payload?.code !== '0') {
          throw new SiteResponseError('SITE_API_ERROR', '网站未能确认当前登录账号，已暂停本轮更新。', {
            endpoint: result.endpoint,
            httpStatus: result.httpStatus,
            contentType: result.contentType,
            redirected: result.redirected,
            finalPath: result.finalPath,
            responseKind: 'api_error',
          });
        }
        const uid = normalizeAccountUid(payload?.zpData?.userId);
        if (!uid) throw new Error('当前账号响应缺少有效 userId。');
        return { uid };
      } catch (cause) {
        if (typeof cause?.code === 'string' && cause.code.startsWith('SITE_')) throw cause;
        throw new Error(cause?.message === '当前账号响应缺少有效 userId。'
          ? cause.message : '读取当前账号失败，已停止采集。');
      }
    },
  });
}
