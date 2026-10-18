(() => {
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

class SiteResponseError extends Error {
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
async function readSiteJsonResponse(response, { endpoint, requestUrl } = {}) {
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
async function waitForRequestSlot({ requestSlot, endpoint, signal, wait = siteWait } = {}) {
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
async function fetchSiteJson(input, {
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

function createAccountReader({ fetchImpl = globalThis.fetch,
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

// Read-only, same-origin BOSS history paging. The extension builder strips this
// import and injects site-response.mjs before this file.

function historyMessageId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function historyParticipantUid(value) {
  const uid = value && typeof value === 'object' ? value.uid : value;
  if (uid === null || uid === undefined || uid === '') return null;
  if (typeof uid === 'number') {
    if (uid === 0) return '0'; // Platform system-message sentinel; never an account UID.
    return Number.isSafeInteger(uid) && uid > 0 ? String(uid) : '__invalid_numeric_uid__';
  }
  if (typeof uid !== 'string') return '__invalid_uid__';
  if (uid === '0') return '0';
  return /^[A-Za-z0-9_-]{1,128}$/u.test(uid) && !/^0+$/u.test(uid) ? uid : '__invalid_uid__';
}

function historyAccountUid(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value) && !/^0+$/u.test(value) ? value : null;
}

function isSiteError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SITE_');
}

function rawMessageFitsAccount(message, accountUid, friendUid) {
  const allowed = new Set([accountUid, friendUid, '0'].filter(Boolean));
  return [historyParticipantUid(message?.from), historyParticipantUid(message?.to)]
    .filter(Boolean).every(uid => allowed.has(uid));
}

/** Identify the other conversation participant from the known recruiter's UID. */
function inferSelfUidFromMessages(messages, { friendUid, selfUid } = {}) {
  const provided = historyParticipantUid(selfUid);
  if (provided) return provided;
  const friend = historyParticipantUid(friendUid);
  if (!friend) return null;
  const candidates = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const from = historyParticipantUid(message?.from);
    const to = historyParticipantUid(message?.to);
    const other = from === friend ? to : to === friend ? from : null;
    if (!other || other === friend || other === '0') continue;
    candidates.set(other, (candidates.get(other) || 0) + 1);
  }
  return [...candidates].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function historyEpochIso(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch < 1e9) return null;
  const milliseconds = epoch >= 1e11 ? epoch : epoch * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Preserve the API object, including media, rather than interpreting every card. */
function normalizeApiMessage(message = {}, { selfUid } = {}) {
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  const bodyType = Number(body.type);
  const withdrawalText = `${body.headTitle || ''} ${typeof body.action === 'string'
    ? body.action : JSON.stringify(body.action || {})}`;
  const isWithdrawal = bodyType === 4 && /撤回了一条消息/u.test(withdrawalText);
  const isSystem = Number(message.type) === 4 || bodyType === 16 || isWithdrawal;
  let kind = 'unknown';
  if (isSystem) kind = 'system';
  else if (bodyType === 1) kind = 'text';
  else if (bodyType === 8) kind = 'platform_card';
  else if (bodyType === 3 || ['image', 'file', 'voice', 'video', 'attachment']
    .some(key => body[key] !== undefined)) kind = 'attachment';
  const self = historyParticipantUid(selfUid);
  const fromUid = historyParticipantUid(message.from);
  const toUid = historyParticipantUid(message.to);
  const direction = isSystem ? 'system' :
    self && fromUid === self ? 'self' : self && toUid === self ? 'hr' : 'unknown';
  const directionEvidenceQuality = isSystem ? 'history_api_system_type' :
    direction === 'self' ? 'from_uid_matches_self_uid' :
      direction === 'hr' ? 'to_uid_matches_self_uid' :
        self ? 'participant_uids_do_not_match_self_uid' : 'self_uid_unknown';
  const contentText = typeof body.text === 'string' ? body.text :
    typeof message.body === 'string' ? message.body : '';
  const text = contentText || (typeof body.headTitle === 'string' ? body.headTitle : '');
  return {
    messageId: historyMessageId(message.mid), kind,
    kindEvidence: `history_api_type_${message.type ?? 'unknown'}_body_${body.type ?? 'unknown'}`,
    direction, directionEvidence: 'history_api_from_to_uid', directionEvidenceQuality,
    contentText, text, received: message.received, from: message.from, to: message.to,
    fromUid, toUid,
    apiType: message.type, apiBodyType: body.type,
    deliveryStatus: null, readStatus: null,
    rawTimeLabel: message.time === undefined || message.time === null ? null : String(message.time),
    rawTimeExplicit: message.time !== undefined && message.time !== null,
    rawApiTime: message.time ?? null, sentAtISO: historyEpochIso(message.time),
    attributes: { 'data-mid': historyMessageId(message.mid) },
    rawApiMessage: message,
  };
}

function smallestHistoryMid(messages) {
  let smallest = null;
  for (const message of messages) {
    const id = historyMessageId(message?.mid);
    if (!id || !/^\d+$/u.test(id)) continue;
    if (smallest === null || BigInt(id) < BigInt(smallest)) smallest = id;
  }
  return smallest;
}

function availableHistoryCoverage(complete, reason) {
  return { availableHistoryComplete: complete, reason, startReached: false,
    fullHistoryVerified: false, scope: 'all_history_pages_currently_returned_by_site' };
}

function historySnapshot({ origin, identity, bossId, selfUid, messages, capturedAt, coverage }) {
  const row = identity && typeof identity === 'object' ? { ...identity, active: true } : null;
  const firstRealMessage = messages.find(message => ['hr', 'self'].includes(message.direction)) || null;
  const lastRealMessage = [...messages].reverse().find(message => ['hr', 'self'].includes(message.direction)) || null;
  return {
    status: 'readable_chat_dom', captureMode: 'api_history', source: 'same_origin_history_api', bossId, selfUid,
    page: { origin, pathname: '/web/geek/chat', capturedAt },
    list: { rows: row ? [row] : [], scope: 'history_api_identity', accountTotal: null,
      fullCoverageVerified: false, capturedRowCount: row ? 1 : 0, captureLimitReached: false },
    active: { rowIndexes: row ? [0] : [], headers: row ? [{ text: [row.hrName, row.company, row.hrRole]
      .filter(Boolean).join(' ') }] : [] },
    messages: { items: messages, capturedCount: messages.length, matchedDomCount: messages.length,
      captureLimitReached: false, loadingIndicatorVisible: false, fullHistoryVerified: false,
      timeNormalization: 'api_epoch_when_recognized',
      orderedMessageIds: messages.map(message => message.messageId).filter(Boolean) },
    firstRealMessage, lastRealMessage, historyCoverage: coverage,
  };
}

/**
 * Read every history page the site currently offers for one conversation.
 * A failed later page returns earlier pages intact. onPage receives only that
 * page's messages so callers can persist immediately, without repeatedly
 * writing the entire history. No page input, cookie reads, or outgoing messages.
 */
async function readAvailableConversationHistory({ bossId, identity, accountUid,
  fetchImpl = globalThis.fetch, origin = globalThis.location?.origin,
  signal, timeoutMs = 15_000, requestTimeoutMs = timeoutMs, maxPages = 1000, onPage, beforeRequest } = {}) {
  const pages = [];
  let complete = false, completeReason = null, error = null;
  let cursor = '0';
  const resolvedSelfUid = historyAccountUid(accountUid);
  let normalizedOrigin = origin;
  const pageLimit = Number.isFinite(Number(maxPages)) ? Math.max(1, Math.floor(Number(maxPages))) : 1000;
  const fail = (code, message, page, details) => {
    error = { code, message: String(message || code), page, ...(details ? { details } : {}) };
  };
  if (!resolvedSelfUid) fail('account_uid_required', '已认证账号 UID 必填。', 0);
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(url.hostname)) {
      fail('boss_origin_required', 'History reads require the BOSS page origin.', 0);
    }
    normalizedOrigin = url.origin;
  } catch { fail('boss_origin_required', 'History reads require the BOSS page origin.', 0); }
  if (!bossId) fail('boss_id_required', 'bossId is required.', 0);

  for (let pageNumber = 1; !error && pageNumber <= pageLimit; pageNumber++) {
    if (signal?.aborted) { fail('aborted', signal.reason || 'aborted', pageNumber); break; }
    const params = { bossId: String(bossId), maxMsgId: cursor, c: '20', page: String(pageNumber), src: '0' };
    const url = new URL('/wapi/zpchat/geek/historyMsg', normalizedOrigin);
    url.search = new URLSearchParams(params).toString();
    let siteResult, payload, requestError;
    try {
      siteResult = await fetchSiteJson(url.href, {
        fetchImpl, signal, timeoutMs: requestTimeoutMs, endpoint: url.pathname, origin: normalizedOrigin, beforeRequest,
      });
      payload = siteResult.payload;
    } catch (cause) {
      requestError = cause;
    }
    if (signal?.aborted) { fail('aborted', signal.reason || 'aborted', pageNumber); break; }
    if (requestError) {
      const code = isSiteError(requestError) ? requestError.code : signal?.aborted ? 'aborted' : 'request_failed';
      fail(code, requestError?.message || requestError, pageNumber, requestError?.details);
      break;
    }
    const rawData = payload?.zpData;
    const rawMessages = Array.isArray(rawData?.messages) ? rawData.messages : [];
    const page = { number: pageNumber, params, httpStatus: siteResult.httpStatus ?? null,
      code: payload?.code ?? null, hasMore: rawData?.hasMore ?? null,
      minMsgId: historyMessageId(rawData?.minMsgId), receivedAt: new Date().toISOString(),
      messageCount: rawMessages.length, rawPayload: payload };
    if (payload?.code !== 0 && payload?.code !== '0') {
      fail('SITE_API_ERROR', '网站未能返回会话历史数据，已暂停本轮更新。', pageNumber, {
        endpoint: siteResult.endpoint,
        httpStatus: siteResult.httpStatus,
        contentType: siteResult.contentType,
        redirected: siteResult.redirected,
        finalPath: siteResult.finalPath,
        responseKind: 'api_error',
      });
      break;
    }
    if (!Array.isArray(rawData?.messages)) {
      fail('api_messages_missing', 'The successful response did not contain a messages array.', pageNumber);
      break;
    }
    if (!rawMessages.every(message => rawMessageFitsAccount(message, resolvedSelfUid, identity?.uid))) {
      fail('foreign_account_message', '会话历史包含不属于已认证账号或当前联系人的参与者，已拒收该页。', pageNumber);
      break;
    }
    pages.push(page);
    let nextCursor = page.minMsgId || smallestHistoryMid(rawMessages);
    if (rawData.hasMore === false) { complete = true; completeReason = 'api_has_more_false'; }
    else if (rawData.hasMore !== true) fail('api_has_more_missing', 'hasMore was not supplied.', pageNumber);
    else if (!rawMessages.length) fail('empty_page_with_more', 'hasMore was true but this page was empty.', pageNumber);
    else if (!nextCursor || nextCursor === cursor) fail('cursor_not_advanced', 'The history cursor did not advance.', pageNumber);
    else if (pageNumber === pageLimit) fail('max_pages_reached', `Stopped after ${pageLimit} pages.`, pageNumber);

    const pageMessages = rawMessages.map((message, index) => ({ ...normalizeApiMessage(message, { selfUid: resolvedSelfUid }), index,
      apiPage: pageNumber, apiPageIndex: index }));
    const coverage = availableHistoryCoverage(complete, completeReason || error?.code || 'api_more_pages');
    if (typeof onPage === 'function') {
      try {
        await onPage({ page, messages: pageMessages, rawMessages, selfUid: resolvedSelfUid,
          historyCoverage: coverage, snapshot: historySnapshot({ origin: normalizedOrigin,
            identity, bossId: String(bossId), selfUid: resolvedSelfUid,
            messages: pageMessages, capturedAt: page.receivedAt, coverage }) });
      } catch (cause) {
        fail(cause.code || 'on_page_failed', cause?.message || cause, pageNumber, cause?.details);
      }
    }
    if (complete || error) break;
    cursor = nextCursor;
  }

  // The observed API returns each page oldest-to-newest, while its pages are
  // requested newest-to-oldest. Reverse pages only, retaining the API order.
  // Duplicate MID is a normal message upsert; messages without a MID stay separate.
  const messages = [], rawMessages = [], positions = new Map();
  for (const page of [...pages].reverse()) {
    if (page.code !== 0 && page.code !== '0') continue;
    const items = Array.isArray(page.rawPayload?.zpData?.messages) ? page.rawPayload.zpData.messages : [];
    for (const [apiPageIndex, raw] of items.entries()) {
      const message = { ...normalizeApiMessage(raw, { selfUid: resolvedSelfUid }), apiPage: page.number, apiPageIndex };
      const previous = message.messageId ? positions.get(message.messageId) : undefined;
      if (previous !== undefined) { messages[previous] = message; rawMessages[previous] = raw; }
      else {
        if (message.messageId) positions.set(message.messageId, messages.length);
        messages.push(message); rawMessages.push(raw);
      }
    }
  }
  messages.forEach((message, index) => { message.index = index; });
  const coverage = availableHistoryCoverage(complete, completeReason || error?.code || 'not_started');
  const capturedAt = new Date().toISOString();
  const snapshot = historySnapshot({ origin: normalizedOrigin, identity,
    bossId: String(bossId ?? ''), selfUid: resolvedSelfUid, messages, capturedAt, coverage });
  return { bossId: String(bossId ?? ''), identity, selfUid: resolvedSelfUid, capturedAt, pages, messages, rawMessages,
    availableHistoryComplete: complete, completeReason, error, historyCoverage: coverage,
    firstRealMessage: snapshot.firstRealMessage, lastRealMessage: snapshot.lastRealMessage,
    snapshot, ordering: 'older_pages_first_within_page_api_order', cookieRead: false };
}

// A single extension-local port per durable request. No retries or website IO.
function createStorageMessenger(runtime) {
  const unavailable = () => Object.assign(new Error('扩展内部保存连接不可用。'), { code: 'BULK_STORAGE_UNAVAILABLE' });
  return (message, { onActivity } = {}) => {
    if (typeof runtime?.connect !== 'function') {
      try {
        return typeof runtime?.sendMessage === 'function'
          ? Promise.resolve(runtime.sendMessage(message)) : Promise.reject(unavailable());
      } catch { return Promise.reject(unavailable()); }
    }
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      let port, settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        port?.onMessage.removeListener?.(receive);
        port?.onDisconnect.removeListener?.(disconnect);
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
        callback(value);
      };
      const disconnect = () => {
        try { void runtime.lastError; } catch { /* Consume without logging its contents. */ }
        finish(reject, unavailable());
      };
      const receive = value => {
        if (settled) return;
        if (value?.type === 'STORAGE_ACTIVITY') {
          try { onActivity?.(); } catch { /* Observation must not break persistence. */ }
        } else if (value?.type === 'STORAGE_RESULT') {
          if (!value.result || typeof value.result.ok !== 'boolean') finish(reject, unavailable());
          else finish(resolve, value.result);
        }
      };
      cancel = () => finish(reject, unavailable());
      try {
        port = runtime.connect({ name: 'bossReadonlyTracker.storage.v1' });
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(disconnect);
        port.postMessage(message);
      } catch { finish(reject, unavailable()); }
    });
    promise.cancel = () => cancel();
    return promise;
  };
}

// Same-origin history collection for the site's currently returned friend list.
// The builder strips this local import and injects the shared response helper.
// This collector never clicks, scrolls, types, reads cookies, or sends chat messages.
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 15_000;
const SAFE_SITE_ENDPOINTS = new Set([
  '/wapi/zprelation/friend/geekFilterByLabel',
  '/wapi/zpchat/geek/historyMsg',
]);
const SAFE_REDIRECT_PATHS = new Set([
  '/web/login', '/web/user/login', '/web/user/verification', '/web/common/verification',
  '/web/geek/chat', '/web/passport/zp/verify.html',
]);

function codedError(code, message, details = null) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function abortError() {
  return codedError('BULK_STOPPED', '采集已停止。');
}

function awaitStorage(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer, pending, settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const activity = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(reject, codedError('BULK_STORAGE_TIMEOUT',
          '扩展本地保存连续没有进展，采集已暂停。', { timeoutMs }));
        try { pending?.cancel?.(); } catch { /* Disconnect is best-effort. */ }
      }, timeoutMs);
    };
    activity();
    try {
      pending = operation(activity);
      Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
    } catch (error) { finish(reject, error); }
  });
}

function safeEndpoint(value) {
  if (typeof value !== 'string') return null;
  const path = value.split('?', 1)[0];
  return SAFE_SITE_ENDPOINTS.has(path) ? path : null;
}

function safeSiteDetails(value = {}) {
  const details = {};
  const endpoint = safeEndpoint(value.endpoint);
  const finalPath = safeEndpoint(value.finalPath) || safeRedirectPath(value.finalPath);
  if (endpoint) details.endpoint = endpoint;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) {
    details.httpStatus = value.httpStatus;
  }
  if (typeof value.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value.contentType)) {
    details.contentType = value.contentType.toLowerCase();
  }
  if (typeof value.redirected === 'boolean') details.redirected = value.redirected;
  if (finalPath) details.finalPath = finalPath;
  if (typeof value.responseKind === 'string' && /^[a-z_]{1,32}$/u.test(value.responseKind)) {
    details.responseKind = value.responseKind;
  }
  if (Number.isFinite(Number(value.timeoutMs)) && Number(value.timeoutMs) > 0) {
    details.timeoutMs = Number(value.timeoutMs);
  }
  return Object.keys(details).length ? details : null;
}

function safeRedirectPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.split('?', 1)[0];
  return SAFE_REDIRECT_PATHS.has(path) ? path : null;
}

function isSiteFailure(error) {
  return (typeof error?.code === 'string' && error.code.startsWith('SITE_') &&
    error.code !== 'SITE_REQUEST_ABORTED') || error?.code === 'api_response_error';
}

function siteErrorMessage(code, details = {}) {
  const status = Number.isInteger(details.httpStatus) ? `（HTTP ${details.httpStatus}）` : '';
  if (code === 'SITE_NON_JSON_RESPONSE') return '网站返回了网页而不是数据，采集已暂停。请确认 BOSS 登录状态后重试。';
  if (code === 'SITE_VERIFICATION_REQUIRED') {
    return 'BOSS 要求页面验证，采集已暂停。请在 BOSS 正常页面手动完成验证；验证前请勿连续重试。';
  }
  if (code === 'SITE_HTTP_ERROR') return `BOSS 网站请求异常${status}，采集已暂停。请确认登录状态或稍后重试。`;
  if (code === 'SITE_REQUEST_TIMEOUT') return '读取 BOSS 网站超时，采集已暂停。请检查网络和登录状态后重试。';
  if (code === 'SITE_API_ERROR') return `BOSS 接口返回异常${status}，采集已暂停。请确认登录状态或稍后重试。`;
  return '读取 BOSS 网站数据失败，采集已暂停。请稍后重试。';
}

function siteFailure(error, fallbackCode = 'SITE_REQUEST_FAILED', fallbackEndpoint = null) {
  const code = error?.code === 'api_response_error' ? 'SITE_API_ERROR' :
    typeof error?.code === 'string' && error.code.startsWith('SITE_') ? error.code : fallbackCode;
  const details = safeSiteDetails(error?.details) || (fallbackEndpoint
    ? { endpoint: fallbackEndpoint, responseKind: 'api_error' } : null);
  return codedError(code, siteErrorMessage(code, details || {}), details);
}
function discoverFriendListParams({ performance = globalThis.performance,
  origin = globalThis.location?.origin } = {}) {
  let expectedOrigin;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(parsed.hostname)) return null;
    expectedOrigin = parsed.origin;
  } catch { return null; }
  const entries = performance?.getEntriesByType?.('resource') || [];
  for (const entry of [...entries].reverse()) {
    let request;
    try { request = new URL(entry?.name || entry?.toJSON?.().name); }
    catch { continue; }
    if (request.origin !== expectedOrigin || request.pathname !== '/wapi/zprelation/friend/geekFilterByLabel' ||
        request.searchParams.get('labelId') !== '0') continue;
    return new URLSearchParams(request.searchParams);
  }
  return null;
}

function createApiBulkCollector({ accountUid, collectionToken,
  readHistory = globalThis.readAvailableConversationHistory,
  send, fetchImpl = globalThis.fetch, origin = globalThis.location?.origin,
  document: dom = globalThis.document, performance = globalThis.performance,
  listParams: suppliedListParams, storedContacts = [], limit = null,
  persistEveryContacts = 4, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  storageTimeoutMs = DEFAULT_STORAGE_TIMEOUT_MS, now = () => new Date().toISOString() } = {}) {
  const normalizeUid = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    if (typeof value !== 'string') return null;
    return /^[A-Za-z0-9_-]{1,128}$/u.test(value) && !/^0+$/u.test(value) ? value : null;
  };
  const fixedAccountUid = normalizeUid(accountUid);
  const fixedCollectionToken = typeof collectionToken === 'string' ? collectionToken.trim() : '';
  if (!fixedAccountUid) throw new Error('已认证账号 UID 必填。');
  if (!fixedCollectionToken) throw new Error('collectionToken 必填。');
  if (typeof readHistory !== 'function') throw new Error('必须提供历史分页读取器。');
  let current = null, executing = false;
  const positiveTimeout = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value)) : fallback;
  const settings = { limit: normalizeLimit(limit), persistEveryContacts: normalizeLimit(persistEveryContacts) || 4,
    requestTimeoutMs: positiveTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    storageTimeoutMs: positiveTimeout(storageTimeoutMs, DEFAULT_STORAGE_TIMEOUT_MS) };
  const compactText = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const copy = value => JSON.parse(JSON.stringify(value));
  const nativeIdFor = row => [row?.uid, row?.friendId, row?.rawFriend?.friendId,
    row?.bossId, row?.encryptBossId, row?.rawFriend?.encryptFriendId]
    .find(value => value !== undefined && value !== null && String(value).trim() !== '');
  const nativeKeyFor = row => {
    const id = nativeIdFor(row);
    return id === undefined ? null : JSON.stringify(['boss', String(id)]);
  };
  const keyFor = row => {
    const nativeKey = nativeKeyFor(row);
    if (nativeKey) return nativeKey;
    const parts = [row?.company, row?.hrName, row?.hrRole].map(compactText);
    return parts.some(Boolean) ? JSON.stringify(parts) : null;
  };
  const apiKeyFor = row => String(row.bossId || row.encryptBossId || row.uid || row.provisionalIdentityKey);
  const timestamp = () => now();
  const updateTimeFor = row => row?.rawFriend?.updateTime ?? null;
  const comparableUpdateTime = value => value === undefined || value === null ? null : String(value);
  const identityFor = row => row?.identity || row || {};
  const storedApiKey = stored => {
    const row = identityFor(stored);
    const id = row.bossId || row.encryptBossId || row.rawFriend?.encryptFriendId ||
      stored?.bossId || stored?.encryptBossId;
    return id === undefined || id === null || id === '' ? null : String(id);
  };
  function contactValues(value) {
    if (Array.isArray(value)) return value.flatMap(contactValues);
    if (!value || typeof value !== 'object') return [];
    if (value.contacts) return contactValues(value.contacts);
    if (value.profiles) return contactValues(value.profiles);
    if (value.identity || value.hrName || value.provisionalIdentityKey) return [value];
    return Object.values(value).flatMap(contactValues);
  }

  function normalizeLimit(value) {
    const parsed = Number(value);
    return value !== null && value !== undefined && Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed) : null;
  }
  function mapContact(row = {}) {
    const identity = {
      uid: row.friendId === undefined || row.friendId === null ? null : String(row.friendId),
      friendId: row.friendId ?? null, friendSource: row.friendSource ?? null,
      bossId: row.encryptFriendId === undefined || row.encryptFriendId === null ? '' : String(row.encryptFriendId),
      encryptBossId: row.encryptFriendId === undefined || row.encryptFriendId === null ? '' : String(row.encryptFriendId),
      company: compactText(row.brandName), hrName: compactText(row.name), hrRole: compactText(row.bossTitle),
      jobTitle: compactText(row.jobName || row.positionName),
      nativeBossTitle: compactText(row.bossTitle), rawFriend: row,
      provisionalIdentityKeyQuality: 'api_native_boss_identity',
    };
    identity.provisionalIdentityKey = keyFor(identity);
    return identity;
  }
  function status() {
    return current ? copy(current.progress) : {
      kind: 'api_v1', apiRevision: 5, accountUid: fixedAccountUid, collectionToken: fixedCollectionToken,
      runId: null, status: 'idle', state: 'idle', active: false, phase: 'idle',
      currentContact: null, discovered: 0, completed: 0, failed: 0, remaining: [],
      completedKeys: [], completedApiKeys: [], historyResults: {}, messageCount: 0,
      availableHistoryCompleteCount: 0, availableRecordsComplete: false, error: null,
      errorCode: null, errorDetails: null,
      runMode: null, scannedCount: 0, currentScopeCount: 0, selectedCount: 0,
      skippedUnchangedCount: 0, refreshedCount: 0, coveredCount: 0, newMessageCount: 0, pageCount: 0,
    };
  }
  function refresh(ctx) {
    const p = ctx.progress, contacts = [...ctx.contacts.values()];
    if (!ctx.listLoaded) {
      const previousContacts = contactValues(ctx.previous?.contacts);
      p.contacts = previousContacts;
      p.discovered = ctx.previous?.discovered ?? previousContacts.length;
      p.scannedCount = p.currentScopeCount = ctx.previous?.scannedCount ?? previousContacts.length;
      p.completed = ctx.previousCompleted.size;
      p.coveredCount = ctx.previousCompleted.size;
      p.completedKeys = [...(ctx.previous?.completedKeys || [])];
      p.completedApiKeys = [...ctx.previousCompleted];
      p.failedContacts = [...(ctx.previous?.failedContacts || [])];
      p.failedKeys = [...(ctx.previous?.failedKeys || [])];
      p.failed = ctx.previous?.failed ?? p.failedContacts.length;
      p.pendingCompletedCount = ctx.pendingCompleted.size;
      p.remaining = [...(ctx.previous?.remaining || [])];
      p.messageCount = ctx.previous?.messageCount ?? ctx.messageIds.size;
      p.observedApiMessageKeys = [...ctx.messageIds];
      p.selectedApiKeys = [...ctx.selected];
      p.selectedCount = ctx.selected.size;
      p.skippedUnchangedCount = ctx.previous?.skippedUnchangedCount || 0;
      p.refreshedApiKeys = [...ctx.refreshed];
      p.refreshedCount = ctx.refreshed.size;
      p.availableHistoryCompleteCount = ctx.previous?.availableHistoryCompleteCount ?? ctx.previousCompleted.size;
      p.availableRecordsComplete = false;
      p.visibilityState = dom?.visibilityState || null;
      p.hasFocus = dom?.hasFocus?.() ?? null;
      p.updatedAt = timestamp();
      return;
    }
    const completed = contacts.filter(row => ctx.completed.has(apiKeyFor(row)));
    p.contacts = contacts;
    p.discovered = contacts.length;
    p.scannedCount = p.currentScopeCount = contacts.length;
    p.completed = completed.length;
    p.coveredCount = completed.length;
    p.completedKeys = [...new Set(completed.map(row => row.provisionalIdentityKey))];
    p.completedApiKeys = completed.map(apiKeyFor);
    p.failedContacts = [...ctx.failed.values()];
    p.failedKeys = p.failedContacts.map(row => row.provisionalIdentityKey);
    p.failed = p.failedContacts.length;
    p.pendingCompletedCount = ctx.pendingCompleted.size;
    p.remaining = contacts.filter(row => !ctx.completed.has(apiKeyFor(row)));
    p.messageCount = ctx.messageIds.size;
    p.observedApiMessageKeys = [...ctx.messageIds];
    p.selectedApiKeys = [...ctx.selected];
    p.selectedCount = ctx.selected.size;
    p.skippedUnchangedCount = ctx.skippedUnchanged.size;
    p.refreshedApiKeys = [...ctx.refreshed];
    p.refreshedCount = ctx.refreshed.size;
    p.availableHistoryCompleteCount = completed.length;
    p.availableRecordsComplete = p.listBoundaryReached === true && p.remaining.length === 0 && !p.failed;
    p.visibilityState = dom?.visibilityState || null;
    p.hasFocus = dom?.hasFocus?.() ?? null;
    p.updatedAt = timestamp();
  }
  function accountFailure(ctx, code, message, details = null) {
    const error = codedError(code, message, details);
    if (!ctx.accountInvalid) {
      ctx.accountInvalid = true;
      ctx.cancelled = true;
      ctx.stopStatus = 'interrupted';
      ctx.stopReason = message;
      ctx.progress.errorCode = code;
      ctx.progress.errorDetails = details;
      ctx.pendingSnapshots.length = 0;
      ctx.pendingCompleted.clear();
      try { ctx.abort.abort(message); } catch { /* abort is best-effort */ }
    }
    throw error;
  }
  async function sendMessage(message) {
    if (typeof send !== 'function') throw codedError('BULK_STORAGE_UNAVAILABLE', '扩展本地保存通道不可用。');
    return awaitStorage(onActivity => send({ ...message,
      accountUid: fixedAccountUid, collectionToken: fixedCollectionToken }, { onActivity }), settings.storageTimeoutMs);
  }
  async function checkpoint(ctx) {
    refresh(ctx);
    const result = await sendMessage({ type: 'BULK_PROGRESS', progress: copy(ctx.progress) });
    if (result?.ok === false) throw codedError('BULK_CHECKPOINT_FAILED', '保存采集进度失败。');
  }
  function proceed(ctx) {
    if (ctx.cancelled || ctx.finalizing || ctx.finalized) throw abortError();
  }
  async function flushNow(ctx) {
    const acknowledge = () => {
      for (const apiKey of ctx.pendingCompleted) {
        const row = ctx.contacts.get(apiKey);
        const history = row && ctx.progress.historyResults[row.provisionalIdentityKey];
        if (history) history.availableHistoryComplete = true;
        ctx.completed.add(apiKey);
        ctx.refreshed.add(apiKey);
        ctx.failed.delete(apiKey);
      }
      ctx.pendingCompleted.clear();
    };
    // A final page may have been flushed by the four-page chunk below before
    // readHistory returned. Those already-saved pages need no second write.
    if (!ctx.pendingSnapshots.length) { acknowledge(); return; }
    const snapshots = ctx.pendingSnapshots.splice(0), started = Date.now();
    try {
      const saved = await sendMessage({ type: 'BULK_SNAPSHOTS', snapshots, sessionId: ctx.progress.runId });
      if (saved?.ok === false) throw codedError('BULK_SNAPSHOT_SAVE_FAILED', '保存聊天记录失败。');
      ctx.progress.lastStorageMs = saved?.storageMs ?? Date.now() - started;
      ctx.progress.lastSavedAt = timestamp();
      ctx.progress.lastSaveSummary = saved?.summary || null;
      ctx.progress.newMessageCount += Number(saved?.newMessageCount) || 0;
      acknowledge();
    } catch (error) {
      if (ctx.accountInvalid) ctx.pendingSnapshots.length = 0;
      else ctx.pendingSnapshots.unshift(...snapshots);
      throw error;
    }
  }
  async function flush(ctx) {
    if (ctx.flushPromise) return ctx.flushPromise;
    ctx.flushPromise = flushNow(ctx);
    try { return await ctx.flushPromise; }
    finally { ctx.flushPromise = null; }
  }
  async function readList(ctx) {
    proceed(ctx);
    let pageOrigin;
    try {
      const parsed = new URL(origin || dom?.location?.origin);
      if (parsed.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(parsed.hostname)) {
        throw new Error('BOSS 沟通页来源无效。');
      }
      pageOrigin = parsed.origin;
    } catch { throw new Error('BOSS 沟通页来源无效。'); }
    const foundParams = typeof suppliedListParams === 'function' ? await suppliedListParams() : suppliedListParams;
    const params = foundParams ? new URLSearchParams(foundParams) : discoverFriendListParams({
      performance: dom?.defaultView?.performance || performance, origin: pageOrigin,
    });
    if (!params || params.get('labelId') !== '0') {
      throw new Error('未在当前页面记录中找到会话列表请求参数。请刷新沟通页后重试。');
    }
    const url = new URL('/wapi/zprelation/friend/geekFilterByLabel', pageOrigin);
    url.search = params.toString();
    const response = await fetchSiteJson(url.href, { fetchImpl, signal: ctx.abort.signal,
      timeoutMs: settings.requestTimeoutMs, endpoint: url.pathname, origin: pageOrigin });
    const payload = response.payload;
    proceed(ctx);
    if (payload?.code !== 0 && payload?.code !== '0') {
      throw codedError('SITE_API_ERROR', siteErrorMessage('SITE_API_ERROR', response), safeSiteDetails({
        endpoint: url.pathname, httpStatus: response.httpStatus, contentType: response.contentType,
        redirected: response.redirected, finalPath: response.finalPath, responseKind: 'api_error',
      }));
    }
    if (!Array.isArray(payload?.zpData?.friendList)) throw new Error('会话列表响应没有 friendList');
    ctx.progress.listReturnedCount = payload.zpData.friendList.length;
    ctx.progress.listHttpStatus = response.httpStatus ?? null;
    ctx.progress.listContentType = response.contentType || null;
    ctx.progress.listApiCode = payload.code;
    ctx.progress.listReadAt = timestamp();
    ctx.progress.listScope = 'all_friends_currently_returned_by_label_0_api';
    const providedStoredContacts = contactValues(storedContacts);
    const storedByApi = new Map(), storedByNative = new Map(), storedByName = new Map();
    for (const stored of [...contactValues(ctx.previous?.contacts), ...providedStoredContacts]) {
      const identity = identityFor(stored), apiKey = storedApiKey(stored);
      if (apiKey && !storedByApi.has(apiKey)) storedByApi.set(apiKey, stored);
      const nativeKey = nativeKeyFor(identity) || nativeKeyFor(stored);
      if (nativeKey && !storedByNative.has(nativeKey)) storedByNative.set(nativeKey, stored);
      // Name-only DOM observations may supply display metadata. Known native
      // accounts with the same company/name must stay separate.
      if (nativeKey) continue;
      const nameKey = JSON.stringify([compactText(identity.company), compactText(identity.hrName)]);
      const group = storedByName.get(nameKey) || new Map();
      group.set(stored.provisionalIdentityKey || identity.provisionalIdentityKey || keyFor(identity), stored);
      storedByName.set(nameKey, group);
    }
    const previousByApi = new Map(contactValues(ctx.previous?.contacts)
      .map(row => [storedApiKey(row), row]).filter(([id]) => id));
    for (const raw of payload.zpData.friendList) {
      const row = mapContact(raw), apiKey = apiKeyFor(row);
      // Metadata can come from the same native account or an unidentified DOM
      // contact, while the storage key always comes from the current native ID.
      const candidates = [...(storedByName.get(JSON.stringify([row.company, row.hrName]))?.values() || [])];
      const byNative = storedByNative.get(row.provisionalIdentityKey);
      const byApi = storedByApi.get(apiKey);
      const associated = byNative || byApi || (candidates.length === 1 ? candidates[0] : null);
      if (associated) {
        const stored = associated, identity = identityFor(stored);
        row.hrRole = compactText(identity.hrRole);
        row.identityAssociation = byNative ? 'stored_native_id' : byApi ? 'stored_boss_id' : 'unique_stored_company_hr_name';
      }
      ctx.contacts.set(apiKey, row);
      const previousRow = previousByApi.get(apiKey);
      const previousKey = previousRow?.provisionalIdentityKey || identityFor(previousRow)?.provisionalIdentityKey;
      const previousResult = ctx.progress.historyResults[row.provisionalIdentityKey] ||
        (previousKey && ctx.progress.historyResults[previousKey]);
      if (previousResult && (!previousResult.bossId || String(previousResult.bossId) === row.bossId)) {
        ctx.progress.historyResults[row.provisionalIdentityKey] = { ...previousResult };
      }
      const previousTime = previousResult?.friendUpdateTime ?? updateTimeFor(previousRow);
      const updateTime = updateTimeFor(row);
      const priorComplete = ctx.previousCompleted.has(apiKey) && previousResult?.availableHistoryComplete === true &&
        (!previousResult.bossId || String(previousResult.bossId) === row.bossId);
      const unchanged = priorComplete && comparableUpdateTime(updateTime) !== null &&
        comparableUpdateTime(previousTime) === comparableUpdateTime(updateTime);
      if (ctx.progress.runMode === 'baseline' && !ctx.progress.resumed) {
        ctx.completed.delete(apiKey);
        ctx.selected.add(apiKey);
        row.refreshReason = 'baseline';
      } else if (unchanged) {
        ctx.completed.add(apiKey);
        ctx.skippedUnchanged.add(apiKey);
        row.refreshReason = 'unchanged';
      } else {
        ctx.completed.delete(apiKey);
        ctx.selected.add(apiKey);
        ctx.skippedUnchanged.delete(apiKey);
        row.refreshReason = !previousRow && !previousResult ? 'new_contact' :
          !priorComplete ? 'previous_history_incomplete' : updateTime === null ? 'update_time_unavailable' : 'friend_update_time_changed';
      }
    }
    // This endpoint returns one list without server pagination metadata.
    // Completion means this returned list, rather than every account-era contact.
    ctx.listLoaded = true;
    ctx.progress.listBoundaryReached = true;
    refresh(ctx);
  }
  function queuePage(ctx, row, value) {
    const snapshot = value.snapshot || {};
    const coverage = { ...(value.historyCoverage || snapshot.historyCoverage || {}),
      fullHistoryVerified: false, startReached: false,
      completeReason: value.historyCoverage?.availableHistoryComplete ? 'api_has_more_false' : null };
    const messages = value.messages || snapshot.messages?.items || [];
    const identity = { ...row, active: true };
    snapshot.status = 'readable_chat_dom';
    snapshot.captureMode = 'bulk_history';
    snapshot.captureTransport = 'history_api';
    snapshot.source = 'same_origin_history_api';
    snapshot.selfUid = fixedAccountUid;
    snapshot.bulkRunId = ctx.progress.runId;
    snapshot.bulkRunMode = ctx.progress.runMode;
    snapshot.requestedConversationKey = row.provisionalIdentityKey;
    snapshot.bossId = row.bossId;
    snapshot.page = { ...snapshot.page, origin: origin || dom?.location?.origin,
      pathname: '/web/geek/chat', capturedAt: snapshot.page?.capturedAt || timestamp(),
      visibilityState: dom?.visibilityState || null, hasFocus: dom?.hasFocus?.() ?? null };
    snapshot.list = { rows: [identity], scope: 'history_api_identity', accountTotal: null,
      fullCoverageVerified: false, capturedRowCount: 1, captureLimitReached: false };
    snapshot.active = { rowIndexes: [0], headers: [{ text: [row.hrName, row.company, row.hrRole].filter(Boolean).join(' ') }] };
    snapshot.messages = { ...snapshot.messages, items: messages, capturedCount: messages.length,
      matchedDomCount: messages.length, captureLimitReached: false, loadingIndicatorVisible: false,
      fullHistoryVerified: false, orderedMessageIds: messages.map(item => item.messageId).filter(Boolean) };
    snapshot.historyCoverage = coverage;
    ctx.pendingSnapshots.push(snapshot);
    for (const item of messages) {
      if (item.messageId !== undefined && item.messageId !== null && item.messageId !== '') {
        ctx.messageIds.add(`${apiKeyFor(row)}\n${String(item.messageId)}`);
      } else ctx.progress.unidentifiedMessageObservations++;
    }
    ctx.progress.lastCapturedAt = timestamp();
    ctx.progress.pageCount++;
    ctx.progress.currentHistoryPage = value.page?.number ?? null;
  }
  async function collect(ctx, row) {
    const started = Date.now(), key = row.provisionalIdentityKey, apiKey = apiKeyFor(row);
    let pagesSinceFlush = 0;
    const result = await readHistory({ bossId: row.bossId, identity: row,
      accountUid: fixedAccountUid, fetchImpl, requestTimeoutMs: settings.requestTimeoutMs,
      origin: origin || dom?.location?.origin, signal: ctx.abort.signal,
      onPage: async value => {
        proceed(ctx);
        queuePage(ctx, row, value);
        if (++pagesSinceFlush >= 4) { await flush(ctx); pagesSinceFlush = 0; }
      } });
    if (result.error?.code === 'foreign_account_message') {
      accountFailure(ctx, 'account_changed', '消息参与者与本轮账号不匹配，采集已停止。');
    }
    proceed(ctx);
    ctx.progress.lastCaptureMs = Date.now() - started;
    const complete = result.availableHistoryComplete === true && !result.error;
    const uniqueIds = new Set((result.messages || []).map(item => item.messageId).filter(Boolean));
    const historyError = result.error ? { ...result.error } : null;
    if (historyError && isSiteFailure(historyError)) {
      const failure = siteFailure(historyError, 'SITE_API_ERROR', '/wapi/zpchat/geek/historyMsg');
      historyError.code = failure.code;
      historyError.message = failure.message;
      historyError.details = failure.details;
      delete historyError.url;
      delete historyError.body;
    }
    ctx.progress.historyResults[key] = {
      bossId: row.bossId, availableHistoryComplete: false, apiAvailableHistoryComplete: complete,
      friendUpdateTime: updateTimeFor(row), refreshReason: row.refreshReason,
      refreshedInRunId: ctx.progress.runId,
      completeReason: result.completeReason || null, reason: result.completeReason || result.error?.code || 'api_not_complete',
      boundaryReached: complete, startReached: false, fullHistoryVerified: false,
      scope: 'all_history_pages_currently_returned_by_site',
      pageCount: result.pages?.length || 0, messageCount: result.messages?.length || 0,
      identifiedMessageCount: uniqueIds.size,
      pages: (result.pages || []).map(page => ({ number: page.number, httpStatus: page.httpStatus,
        code: page.code, hasMore: page.hasMore, messageCount: page.messageCount, minMsgId: page.minMsgId })),
      error: historyError, capturedAt: result.capturedAt || timestamp(),
    };
    if (complete) {
      ctx.pendingCompleted.add(apiKey);
      if (ctx.pendingCompleted.size >= settings.persistEveryContacts) await flush(ctx);
    } else {
      // Save earlier pages even when this contact's later request failed.
      await flush(ctx);
    }
    proceed(ctx);
    if (!complete) {
      if (isSiteFailure(result.error)) throw siteFailure(result.error, 'SITE_API_ERROR', '/wapi/zpchat/geek/historyMsg');
      throw new Error(result.error?.message || '网站返回的会话历史尚未读完。');
    }
  }
  function terminalError(ctx, error) {
    if (ctx.accountInvalid) {
      const code = ctx.progress.errorCode || 'account_changed';
      const message = ctx.stopReason || error?.message || '无法确认当前登录账号，采集已停止。';
      ctx.progress.errorCode = code;
      ctx.progress.errorDetails = error?.details || ctx.progress.errorDetails || null;
      ctx.progress.error = message;
      return codedError(code, message, ctx.progress.errorDetails);
    }
    if (ctx.cancelled || error?.code === 'BULK_STOPPED' || error?.code === 'SITE_REQUEST_ABORTED') {
      const message = ctx.stopReason || '采集已停止。';
      ctx.progress.errorCode = 'BULK_STOPPED';
      ctx.progress.errorDetails = null;
      ctx.progress.error = message;
      return codedError('BULK_STOPPED', message);
    }
    if (isSiteFailure(error)) {
      const safe = siteFailure(error);
      ctx.cancelled = true;
      ctx.stopStatus = 'interrupted';
      ctx.stopReason = safe.message;
      ctx.progress.errorCode = safe.code;
      ctx.progress.errorDetails = safe.details;
      try { if (!ctx.abort.signal.aborted) ctx.abort.abort(safe.message); } catch { /* abort is best-effort */ }
      return safe;
    }
    const code = typeof error?.code === 'string' ? error.code : null;
    const details = code?.startsWith('SITE_') ? safeSiteDetails(error?.details) : null;
    const message = code === 'BULK_STORAGE_TIMEOUT' ? '扩展本地保存通道超时，采集已暂停。' :
          code === 'BULK_SNAPSHOT_SAVE_FAILED' ? '保存聊天记录失败，采集已暂停。' :
            code === 'BULK_CHECKPOINT_FAILED' ? '保存采集进度失败，采集已暂停。' :
              code === 'BULK_STORAGE_UNAVAILABLE' ? '扩展本地保存通道不可用，采集已暂停。' :
                ctx.stopReason || error?.message || '采集已暂停。';
    ctx.progress.errorCode = code || 'BULK_FAILED';
    ctx.progress.errorDetails = details;
    ctx.progress.error = message;
    return codedError(ctx.progress.errorCode, message, details);
  }
  async function run(ctx) {
    try {
      await checkpoint(ctx);
      await readList(ctx);
      ctx.progress.phase = 'history';
      await checkpoint(ctx);
      let attempted = 0;
      for (const row of ctx.contacts.values()) {
        proceed(ctx);
        const apiKey = apiKeyFor(row);
        if (ctx.completed.has(apiKey)) continue;
        if (settings.limit !== null && attempted >= settings.limit) { ctx.progress.limitReached = true; break; }
        attempted++;
        ctx.progress.currentContact = row;
        ctx.progress.currentHistoryPage = null;
        ctx.progress.error = null;
        try { await collect(ctx, row); }
        catch (error) {
          if (ctx.cancelled || ctx.accountInvalid || error.code === 'BULK_STOPPED' ||
              isSiteFailure(error) || ['BULK_STORAGE_TIMEOUT',
                'BULK_SNAPSHOT_SAVE_FAILED', 'BULK_CHECKPOINT_FAILED', 'BULK_STORAGE_UNAVAILABLE'].includes(error.code)) throw error;
          ctx.failed.set(apiKey, { ...row, error: error.message || String(error), at: timestamp() });
          ctx.progress.error = error.message || String(error);
        }
        await checkpoint(ctx);
      }
      await flush(ctx);
      refresh(ctx);
      ctx.progress.status = ctx.progress.state = ctx.progress.availableRecordsComplete ? 'completed' : 'interrupted';
      ctx.progress.phase = 'finished';
      ctx.progress.currentContact = null;
      if (ctx.progress.availableRecordsComplete) ctx.progress.error = null;
      else if (ctx.progress.limitReached) ctx.progress.error = '本轮已达到试采数量，可以继续采集剩余会话。';
      else ctx.progress.error ||= '尚有读取失败的会话，可继续采集。';
    } catch (error) {
      const fatal = terminalError(ctx, error);
      ctx.progress.status = ctx.progress.state = ctx.stopStatus ||
        (isSiteFailure(error) || String(error?.code || '').startsWith('BULK_') ? 'interrupted' : 'failed');
      ctx.progress.phase = 'finished';
      ctx.progress.error = fatal.message;
    } finally {
      // Preserve pages received before an abort or a later request failure.
      ctx.finalizing = true;
      ctx.progress.finalizing = true;
      try { if (!ctx.accountInvalid) await flush(ctx); } catch (error) {
        if (ctx.accountInvalid) ctx.pendingSnapshots.length = 0;
        const fatal = terminalError(ctx, error);
        ctx.progress.status = ctx.progress.state = 'interrupted';
        ctx.progress.error = fatal.message;
      }
      ctx.progress.active = false;
      ctx.progress.finalizing = false;
      ctx.progress.finishedAt = timestamp();
      try { await checkpoint(ctx); } catch {
        ctx.progress.status = ctx.progress.state = 'interrupted';
        ctx.progress.phase = 'finished';
        ctx.progress.active = false;
        ctx.progress.errorCode = 'BULK_CHECKPOINT_FAILED';
        ctx.progress.errorDetails = null;
        ctx.progress.error = '保存最终采集进度失败，状态已在本地结束；下次更新会从未完成会话继续。';
      }
      ctx.finalized = true;
      executing = false;
    }
  }
  function launch(saved = null) {
    if (executing) return status();
    const candidate = saved?.progress || saved;
    const previous = candidate?.kind === 'api_v1' && candidate.accountUid === fixedAccountUid
      ? candidate : null;
    const resumed = Boolean(previous && previous.status !== 'completed' && previous.state !== 'completed');
    const runMode = resumed ? previous.runMode || 'baseline' : previous ? 'incremental' : 'baseline';
    const startedAt = timestamp();
    const previousCompleted = new Set((previous?.completedApiKeys || []).map(String));
    const previousCompletedKeys = new Set(previous?.completedKeys || []);
    for (const stored of contactValues(previous?.contacts)) {
      const identity = identityFor(stored), apiKey = storedApiKey(stored);
      const identityKey = stored?.provisionalIdentityKey || identity?.provisionalIdentityKey;
      if (apiKey && (previousCompletedKeys.has(apiKey) || (identityKey && previousCompletedKeys.has(identityKey)))) {
        previousCompleted.add(apiKey);
      }
    }
    current = {
      abort: new AbortController(), cancelled: false, contacts: new Map(), failed: new Map(),
      previous, previousCompleted,
      completed: new Set(resumed ? previousCompleted : []), pendingSnapshots: [], pendingCompleted: new Set(),
      selected: new Set(resumed ? previous?.selectedApiKeys || [] : []), skippedUnchanged: new Set(),
      refreshed: new Set(resumed ? previous?.refreshedApiKeys || [] : []),
      messageIds: new Set(resumed ? previous?.observedApiMessageKeys || [] : []),
      progress: {
        kind: 'api_v1', apiRevision: 5, accountUid: fixedAccountUid, collectionToken: fixedCollectionToken,
        runMode, resumed, runId: resumed && previous?.runId
          ? previous.runId : globalThis.crypto?.randomUUID?.() || `api-${Date.now()}-${Math.random()}`,
        status: 'running', state: 'running', active: true, phase: 'scan',
        currentContact: null, startedAt: resumed ? previous.startedAt || startedAt : startedAt,
        updatedAt: startedAt, discovered: 0, completed: 0, failed: 0, remaining: [],
        completedKeys: [], completedApiKeys: [], historyResults: { ...(previous?.historyResults || {}) },
        messageCount: 0, messageCountApproximate: false,
        unidentifiedMessageObservations: resumed ? previous.unidentifiedMessageObservations || 0 : 0,
        scannedCount: 0, currentScopeCount: 0, selectedCount: 0, skippedUnchangedCount: 0,
        refreshedCount: 0, coveredCount: 0, newMessageCount: resumed ? previous.newMessageCount || 0 : 0,
        pageCount: resumed ? previous.pageCount || 0 : 0,
        availableHistoryCompleteCount: 0, availableRecordsComplete: false,
        listBoundaryReached: false, fullAccountCoverageVerified: false,
        fullHistoryVerified: false, historyReachedStart: 0, limit: settings.limit, limitReached: false,
        persistEveryContacts: settings.persistEveryContacts, pendingCompletedCount: 0,
        captureLimitReached: false, error: null, errorCode: null, errorDetails: null, finalizing: false,
      },
    };
    refresh(current);
    executing = true;
    const ctx = current;
    // Popup/bridge calls return immediately; content owns the asynchronous run.
    Promise.resolve().then(() => run(ctx));
    return status();
  }
  function stop(reason = '用户停止采集') {
    if (!current || !executing) return status();
    current.cancelled = true;
    current.stopReason = reason;
    current.stopStatus = 'interrupted';
    current.progress.status = current.progress.state = current.stopStatus;
    current.progress.active = false;
    current.progress.finalizing = true;
    current.progress.error = reason;
    current.progress.errorCode = 'BULK_STOPPED';
    current.progress.errorDetails = null;
    current.abort.abort(reason);
    return status();
  }
  return Object.freeze({
    kind: 'api_v1', apiRevision: 5,
    configure: options => { if (options && Object.hasOwn(options, 'limit')) settings.limit = normalizeLimit(options.limit);
      if (options && Object.hasOwn(options, 'persistEveryContacts')) {
        settings.persistEveryContacts = normalizeLimit(options.persistEveryContacts) || 4;
      }
      if (options && Object.hasOwn(options, 'requestTimeoutMs')) {
        settings.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
      }
      if (options && Object.hasOwn(options, 'storageTimeoutMs')) {
        settings.storageTimeoutMs = positiveTimeout(options.storageTimeoutMs, DEFAULT_STORAGE_TIMEOUT_MS);
      }
      if (current) { current.progress.limit = settings.limit; current.progress.persistEveryContacts = settings.persistEveryContacts; }
      return { kind: 'api_v1', apiRevision: 5, ...settings }; },
    start: saved => launch(saved),
    resume: saved => launch(saved || status()), stop, status,
  });
}

globalThis.__bossBeforeSiteRequest = ({ endpoint, signal }) => waitForRequestSlot({
  endpoint, signal,
  requestSlot: message => {
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== 'function') {
      throw new SiteResponseError('SITE_REQUEST_SCHEDULER_UNAVAILABLE', '本地请求限速器不可用，采集已停止。', { endpoint });
    }
    return runtime.sendMessage(message);
  },
});
const __bossAccountReaderRevision = 'site-response-paced-v5';
const __bossAccountReaderRuntime = globalThis.__bossAccountReaderRuntime;
const __bossAccountReaderInstance = __bossAccountReaderRuntime?.revision === __bossAccountReaderRevision
  ? __bossAccountReaderRuntime.reader : createAccountReader();
globalThis.__bossAccountReaderRuntime = { revision: __bossAccountReaderRevision, reader: __bossAccountReaderInstance };
globalThis.__bossAccountReader = Object.freeze({ read: options => __bossAccountReaderInstance.read(options) });

globalThis.__bossStartCollection = ({ accountUid, collectionToken, previous, storedContacts } = {}) => {
  const runtime = globalThis.chrome?.runtime;
  const collector = createApiBulkCollector({
    accountUid, collectionToken, previous, storedContacts,
    readHistory: options => readAvailableConversationHistory(options),
    send: createStorageMessenger(runtime),
  });
  globalThis.__bossBulkCollector = collector;
  return collector.start(previous);
};

})();
