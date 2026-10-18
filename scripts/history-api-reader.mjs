import { fetchSiteJson } from './site-response.mjs';

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
export function inferSelfUidFromMessages(messages, { friendUid, selfUid } = {}) {
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
export function normalizeApiMessage(message = {}, { selfUid } = {}) {
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
export async function readAvailableConversationHistory({ bossId, identity, accountUid,
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
