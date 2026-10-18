// Same-origin history collection for the site's currently returned friend list.
// The builder strips this local import and injects the shared response helper.
// This collector never clicks, scrolls, types, reads cookies, or sends chat messages.
import { fetchSiteJson } from './site-response.mjs';

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
export function discoverFriendListParams({ performance = globalThis.performance,
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

export function createApiBulkCollector({ accountUid, collectionToken,
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
