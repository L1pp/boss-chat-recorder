// Shared, privacy-safe handling for same-origin BOSS JSON responses.

const DEFAULT_TIMEOUT_MS = 15_000;

function siteSafePath(value, fallback = '/') {
  try {
    const base = globalThis.location?.href || 'https://www.zhipin.com/';
    return new URL(typeof value === 'string' && value ? value : fallback, base).pathname || '/';
  } catch { return '/'; }
}

function siteReadHttpStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function siteReadContentType(response) {
  let header = '';
  try { header = response?.headers?.get?.('content-type') || ''; } catch { /* hostile/mock header getter */ }
  const mime = String(header).split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : '';
}

function siteResponseMetadata(response, { endpoint, requestUrl, responseKind } = {}) {
  let finalUrl = requestUrl;
  try { if (typeof response?.url === 'string' && response.url) finalUrl = response.url; } catch { /* use request URL */ }
  let redirected = false;
  try { redirected = response?.redirected === true; } catch { /* use false */ }
  return {
    endpoint: siteSafePath(endpoint, requestUrl || '/'),
    httpStatus: siteReadHttpStatus(response),
    contentType: siteReadContentType(response),
    redirected,
    finalPath: siteSafePath(finalUrl, requestUrl || endpoint || '/'),
    responseKind,
  };
}

export class SiteResponseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SiteResponseError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function siteMakeNonJsonError(response, options, responseKind) {
  const details = siteResponseMetadata(response, { ...options, responseKind });
  const needsVerification = responseKind === 'html' &&
    details.finalPath === '/web/passport/zp/verify.html';
  return new SiteResponseError(needsVerification ? 'SITE_VERIFICATION_REQUIRED' : 'SITE_NON_JSON_RESPONSE',
    needsVerification
      ? 'BOSS 直聘要求进行页面验证。请在 BOSS 页面手动完成验证；验证完成前不要重新采集。'
      : '网站返回了网页而不是数据，已暂停本轮更新。请确认仍登录 BOSS 直聘后重试。',
    details);
}

function siteMakeHttpError(response, options) {
  const status = siteReadHttpStatus(response);
  return new SiteResponseError('SITE_HTTP_ERROR',
    `BOSS 网站请求失败${status ? `（HTTP ${status}）` : ''}，已暂停本轮更新。请检查登录状态或稍后重试。`,
    siteResponseMetadata(response, { ...options, responseKind: 'http_error' }));
}

function siteResponseIsSuccessful(response) {
  if (typeof response?.ok === 'boolean') return response.ok;
  const status = siteReadHttpStatus(response);
  return status === null || (status >= 200 && status < 300);
}

/**
 * Parse a site response without ever including its body in errors.
 * JSON MIME is advisory: valid JSON is accepted even with a nonstandard type.
 * `json()` support remains for older unit-test mocks; production Response uses text().
 */
export async function readSiteJsonResponse(response, { endpoint, requestUrl } = {}) {
  if (!siteResponseIsSuccessful(response)) throw siteMakeHttpError(response, { endpoint, requestUrl });

  let text;
  if (typeof response?.text === 'function') {
    try { text = await response.text(); }
    catch { throw siteMakeNonJsonError(response, { endpoint, requestUrl }, 'unreadable'); }
  } else if (typeof response?.json === 'function') {
    try { return await response.json(); }
    catch { throw siteMakeNonJsonError(response, { endpoint, requestUrl }, 'invalid_json'); }
  } else {
    throw siteMakeNonJsonError(response, { endpoint, requestUrl }, 'unreadable');
  }

  if (typeof text !== 'string' || !text.trim()) {
    throw siteMakeNonJsonError(response, { endpoint, requestUrl }, 'empty');
  }
  const trimmed = text.trimStart().replace(/^\uFEFF/u, '').trimStart();
  try { return JSON.parse(text); }
  catch {
    const htmlContentType = siteReadContentType(response) === 'text/html' ||
      siteReadContentType(response) === 'application/xhtml+xml';
    const htmlBody = /^(?:<!doctype\s+html\b|<html\b|<head\b)/iu.test(trimmed);
    throw siteMakeNonJsonError(response, { endpoint, requestUrl }, htmlContentType || htmlBody ? 'html' : 'invalid_json');
  }
}

function siteTimeoutError(endpoint, timeoutMs) {
  return new SiteResponseError('SITE_REQUEST_TIMEOUT',
    '请求 BOSS 网站超时，已暂停本轮更新。请确认网络和登录状态后重试。',
    { endpoint: siteSafePath(endpoint), timeoutMs });
}

function siteAbortError(endpoint) {
  return new SiteResponseError('SITE_REQUEST_ABORTED', '请求已取消。', { endpoint: siteSafePath(endpoint) });
}

function siteWait(milliseconds, { signal, endpoint } = {}) {
  if (signal?.aborted) return Promise.reject(siteAbortError(endpoint));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(siteAbortError(endpoint)); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function siteAwaitAbortable(operation, { signal, endpoint } = {}) {
  if (signal?.aborted) throw siteAbortError(endpoint);
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(siteAbortError(endpoint));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { signal?.removeEventListener?.('abort', onAbort); }
}

/** Ask the extension's local scheduler for permission to start one request.
 * A positive wait is a local scheduling response, never a retry of a site request.
 */
export async function waitForRequestSlot({ requestSlot, endpoint, signal, wait = siteWait } = {}) {
  const path = siteSafePath(endpoint);
  if (typeof requestSlot !== 'function') {
    throw new SiteResponseError('SITE_REQUEST_SCHEDULER_UNAVAILABLE', '本地请求限速器不可用，采集已停止。', { endpoint: path });
  }
  for (;;) {
    let slot;
    try {
      slot = await siteAwaitAbortable(() => requestSlot({ type: 'SITE_REQUEST_SLOT', endpoint: path }),
        { signal, endpoint: path });
    } catch (error) {
      if (error instanceof SiteResponseError) throw error;
      throw new SiteResponseError('SITE_REQUEST_SCHEDULER_UNAVAILABLE', '本地请求限速器不可用，采集已停止。', { endpoint: path });
    }
    if (!slot?.ok || !Number.isFinite(slot.waitMs) || slot.waitMs < 0) {
      const code = typeof slot?.error === 'string' && /^SITE_[A-Z_]+$/u.test(slot.error)
        ? slot.error : 'SITE_REQUEST_SCHEDULER_UNAVAILABLE';
      throw new SiteResponseError(code, '本地请求限速器未允许本次请求，采集已停止。', { endpoint: path });
    }
    if (signal?.aborted) throw siteAbortError(path);
    if (slot.waitMs === 0) return;
    await siteAwaitAbortable(() => wait(slot.waitMs, { signal, endpoint: path }), { signal, endpoint: path });
  }
}

/**
 * Perform one same-origin GET and return parsed JSON plus safe response metadata.
 * The timeout covers both fetch and body consumption. No automatic retry is made.
 */
export async function fetchSiteJson(input, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  endpoint,
  origin,
  beforeRequest = globalThis.__bossBeforeSiteRequest,
  cache,
} = {}) {
  const baseOrigin = origin || globalThis.location?.origin;
  let url;
  try { url = new URL(String(input), baseOrigin || 'https://www.zhipin.com/'); }
  catch { throw new SiteResponseError('SITE_REQUEST_FAILED', '无法构造网站请求地址。', { endpoint: siteSafePath(endpoint) }); }
  const endpointPath = siteSafePath(endpoint, url.href);
  const allowedOrigin = baseOrigin || url.origin;
  if (url.origin !== allowedOrigin || url.protocol !== 'https:') {
    throw new SiteResponseError('SITE_ORIGIN_ERROR', '网站请求必须使用当前 HTTPS 来源。', { endpoint: endpointPath });
  }
  if (typeof fetchImpl !== 'function') {
    throw new SiteResponseError('SITE_REQUEST_FAILED', '当前页面无法读取网站数据。', { endpoint: endpointPath });
  }
  if (signal?.aborted) throw siteAbortError(endpointPath);

  // Scheduling can take longer than a network timeout. Start that timeout only
  // after the local scheduler grants a slot, and cancel queued work on STOP.
  if (typeof beforeRequest === 'function') {
    await siteAwaitAbortable(() => beforeRequest({ endpoint: endpointPath, signal }),
      { signal, endpoint: endpointPath });
  }
  if (signal?.aborted) throw siteAbortError(endpointPath);

  const numericTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(numericTimeout) && numericTimeout > 0
    ? Math.max(1, numericTimeout) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    controller.abort();
    rejectAbort(siteAbortError(endpointPath));
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  const requestPromise = (async () => {
    const response = await fetchImpl(url.href, {
      method: 'GET', mode: 'same-origin', credentials: 'same-origin',
      ...(cache ? { cache } : {}),
      signal: controller.signal,
    });
    const payload = await readSiteJsonResponse(response, { endpoint: endpointPath, requestUrl: url.href });
    return { payload, ...siteResponseMetadata(response, { endpoint: endpointPath, requestUrl: url.href, responseKind: 'json' }) };
  })();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(siteTimeoutError(endpointPath, boundedTimeout));
    }, boundedTimeout);
  });

  try { return await Promise.race([requestPromise, timeoutPromise, abortPromise]); }
  catch (error) {
    if (error instanceof SiteResponseError) throw error;
    if (signal?.aborted) throw siteAbortError(endpointPath);
    throw new SiteResponseError('SITE_REQUEST_FAILED', '读取 BOSS 网站数据失败，已暂停本轮更新。',
      { endpoint: endpointPath });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
