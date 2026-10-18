import { analyzeConversationOrigin } from './analysis/conversation-origin.mjs';

const CHAT_HOSTS = new Set(['www.zhipin.com', 'zhipin.com']);
const CHAT_PATH = '/web/geek/chat';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const compact = (value) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (!bytes) throw new Error('UUID_UNAVAILABLE');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isSupportedChatUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && CHAT_HOSTS.has(url.hostname.toLowerCase()) &&
      url.pathname.replace(/\/+$/u, '') === CHAT_PATH && !url.pathname.includes('_security_check');
  } catch {
    return false;
  }
}

export function canonicalIdentityKey(row) {
  const nativeId = [row?.uid, row?.friendId, row?.rawFriend?.friendId,
    row?.bossId, row?.encryptBossId, row?.rawFriend?.encryptFriendId]
    .find(value => value !== undefined && value !== null && String(value).trim() !== '');
  if (nativeId !== undefined) return JSON.stringify(['boss', String(nativeId)]);
  const parts = [row?.company, row?.hrName, row?.hrRole].map(compact);
  return parts.some(Boolean) ? JSON.stringify(parts) : null;
}

function avatarReference(identity = {}) {
  if (nonEmpty(identity.avatarPath)) return identity.avatarPath.trim();
  if (nonEmpty(identity.avatarUrl)) return identity.avatarUrl.trim();
  const image = Array.isArray(identity.structure) && identity.structure.find((node) =>
    /^(IMG|IMAGE)$/iu.test(node?.tag || '') && /image-circle|avatar|photo/iu.test(node?.class || ''));
  const attributes = image?.attributes;
  if (isObject(attributes)) {
    for (const key of ['src', 'data-src', 'data-original']) if (nonEmpty(attributes[key])) return attributes[key].trim();
  }
  return null;
}

export function createEmptyState({ now = new Date().toISOString(), profileNamespace = uuid() } = {}) {
  return {
    schemaVersion: 2, profileNamespace, createdAt: now, updatedAt: now,
    contacts: {}, messages: {}, unidentifiedMessages: [], unassignedObservations: [],
    captures: [], rawSources: {}, initialRowsByKey: {}, closingRowsByKey: {}, listBaselineInitialized: false,
  };
}

export function normalizeState(value, { now = new Date().toISOString(), copy = true } = {}) {
  if (value === null || value === undefined) return createEmptyState({ now });
  if (!isObject(value)) throw new Error('STORAGE_STATE_INVALID');
  // Keep an older or unknown schema intact instead of replacing it with an empty state.
  if (value.schemaVersion !== 2) throw new Error(`STORAGE_SCHEMA_UNSUPPORTED:${value.schemaVersion}`);
  const state = copy ? clone(value) : value;
  state.profileNamespace ||= uuid();
  state.createdAt ||= now;
  state.updatedAt ||= now;
  for (const key of ['contacts', 'messages', 'rawSources', 'initialRowsByKey', 'closingRowsByKey']) {
    if (!isObject(state[key])) state[key] = {};
  }
  for (const key of ['unidentifiedMessages', 'unassignedObservations', 'captures']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  state.listBaselineInitialized = state.listBaselineInitialized === true || Object.keys(state.initialRowsByKey).length > 0;
  return state;
}

function warningsFor(snapshot, rows, activeRows, row, key) {
  const warnings = [];
  if (snapshot.status !== 'readable_chat_dom') warnings.push('chat_dom_status_unexpected');
  if (Array.isArray(snapshot.errors) && snapshot.errors.length) warnings.push('capture_reported_errors');
  if (snapshot.messages?.loadingIndicatorVisible !== false) warnings.push('message_loading_state_uncertain');
  if (!nonEmpty(snapshot.page?.capturedAt)) warnings.push('page_capture_time_missing');
  if (!Array.isArray(snapshot.list?.rows)) warnings.push('conversation_rows_missing');
  if (activeRows.length !== 1) warnings.push(`active_row_count_${activeRows.length}`);
  if (row && !key) warnings.push('conversation_identity_empty');
  if (key && rows.filter((candidate) => canonicalIdentityKey(candidate) === key).length > 1) {
    warnings.push('visible_identity_tuple_collision');
  }
  if (row) {
    if (nonEmpty(row.provisionalIdentityKey) && row.provisionalIdentityKey !== key) warnings.push('visible_identity_key_differs_from_tuple');
    const headers = (Array.isArray(snapshot.active?.headers) ? snapshot.active.headers : []).map((header) => compact(header?.text));
    if (!nonEmpty(row.hrName) || !headers.some((header) => header.includes(compact(row.hrName)))) warnings.push('chat_header_name_unconfirmed');
    const secondaryLabels = [row.company, row.hrRole].map(compact).filter(Boolean);
    if (secondaryLabels.length && !secondaryLabels.some((label) => headers.some((header) => header.includes(label)))) {
      warnings.push('chat_header_company_or_role_unconfirmed');
    }
  }
  if (!Array.isArray(snapshot.messages?.items)) warnings.push('message_items_missing');
  return warnings;
}

/** Validate only extension/BOSS provenance and enough structure to preserve a raw observation. */
export function validateSnapshot(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.page)) return { ok: false, error: 'SNAPSHOT_INVALID' };
  const pageUrl = `${snapshot.page.origin || ''}${snapshot.page.pathname || ''}`;
  if (!isSupportedChatUrl(pageUrl)) return { ok: false, error: 'UNSUPPORTED_PAGE' };
  const rows = Array.isArray(snapshot.list?.rows) ? snapshot.list.rows : [];
  const activeRows = rows.filter((row) => row?.active === true);
  const row = activeRows.length === 1 ? activeRows[0] : null;
  const key = row ? canonicalIdentityKey(row) : null;
  const warnings = warningsFor(snapshot, rows, activeRows, row, key);
  const items = Array.isArray(snapshot.messages?.items) ? snapshot.messages.items.filter(isObject) : [];
  if (Array.isArray(snapshot.messages?.items) && items.length !== snapshot.messages.items.length) warnings.push('invalid_message_items_preserved_in_raw_snapshot');
  return { ok: true, pageUrl, rows, activeRows, row, key, items, warnings };
}

function sampleFor(snapshot, row, warnings) {
  const atStart = snapshot.historyCoverage?.startReached === true;
  return {
    ...clone(snapshot),
    activeRows: row ? [clone(row)] : [],
    warnings: [...warnings],
    sampleScope: 'currently_rendered_dom_observation',
    isStartSample: atStart,
    complete: atStart && snapshot.messages?.captureLimitReached !== true,
  };
}

function updateListRows(state, rows, selectedKey, selectedRow) {
  for (const row of rows) {
    const key = canonicalIdentityKey(row);
    if (!key) continue;
    if (!state.listBaselineInitialized) state.initialRowsByKey[key] ||= clone(row);
    state.closingRowsByKey[key] = clone(row);
  }
  if (selectedKey && selectedRow) {
    if (!state.listBaselineInitialized) state.initialRowsByKey[selectedKey] ||= clone(selectedRow);
    state.closingRowsByKey[selectedKey] = clone(selectedRow);
  }
  if (Object.keys(state.initialRowsByKey).length) state.listBaselineInitialized = true;
}

function recordUnknownId(state, key, message, observedAt, captureId, index) {
  state.unidentifiedMessages.push({
    ...clone(message), observationId: uuid(), identityKey: key,
    observedAt, firstObservedAt: observedAt, lastObservedAt: observedAt,
    captureId, itemIndex: index,
  });
}

function rawDatesFor(message, previous) {
  const values = [
    ...(Array.isArray(previous?.rawDates) ? previous.rawDates : []),
    ...(Array.isArray(message.rawDates) ? message.rawDates : []),
    ...(nonEmpty(message.rawTimeLabel) ? [message.rawTimeLabel] : []),
  ];
  const seen = new Set();
  return values.filter((value) => {
    const marker = JSON.stringify(value);
    if (seen.has(marker)) return false;
    seen.add(marker);
    return true;
  });
}

function upsertMessage(state, key, message, observedAt) {
  const messageId = nonEmpty(message.messageId) ? message.messageId.trim() : null;
  if (!messageId) return { inserted: true, messageId: null };
  const storageKey = `message:${JSON.stringify([key, messageId])}`;
  const previous = state.messages[storageKey];
  state.messages[storageKey] = {
    ...(previous || {}), ...clone(message), messageId, identityKey: key,
    firstObservedAt: previous?.firstObservedAt || observedAt,
    lastObservedAt: observedAt,
    rawDates: rawDatesFor(message, previous),
  };
  return { inserted: !previous, messageId };
}

function originFor(samples, messages, historyCoverage = { startReached: false }) {
  return analyzeConversationOrigin({ historyCoverage, samples, messages });
}

export function summarizeState(value) {
  const state = normalizeState(value, { copy: false });
  const contacts = Object.values(state.contacts);
  return {
    contactCount: contacts.length,
    messageCount: Object.keys(state.messages).length,
    unidentifiedObservationCount: state.unidentifiedMessages.length,
    updatedAt: state.updatedAt,
    originConfirmedCount: contacts.filter((contact) => contact.originConfidence === 'confirmed').length,
    originProvisionalCount: contacts.filter((contact) => contact.originConfidence === 'provisional').length,
  };
}

export function mergeSnapshot(previous, snapshot, { captureId = uuid(), sessionId = null,
  receivedAt = new Date().toISOString(), copyState = true } = {}) {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) return { accepted: false, reason: validation.error, state: previous };
  const state = normalizeState(previous, { now: receivedAt, copy: copyState });
  const { row, key, items, rows, activeRows, warnings: baseWarnings } = validation;
  const observedAt = nonEmpty(snapshot.page.capturedAt) ? snapshot.page.capturedAt : receivedAt;
  const warnings = [...baseWarnings];
  const raw = clone(snapshot);

  updateListRows(state, rows, key, row);
  if (!row || !key) {
    const observation = {
      observationId: uuid(), sessionId, captureId, observedAt,
      reason: !activeRows.length ? 'no_active_conversation_row' :
        activeRows.length > 1 ? 'multiple_active_conversation_rows' : 'active_row_identity_missing',
      warnings, snapshot: raw,
    };
    state.unassignedObservations.push(observation);
    state.captures.push({ captureId, sessionId, identityKey: null, observedAt, warnings, unassigned: true });
    state.updatedAt = receivedAt;
    return { accepted: true, changed: true, state, summary: summarizeState(state),
      newMessageCount: 0, updatedMessageCount: 0, unidentifiedObservationCount: 0, warnings };
  }

  const priorContact = state.contacts[key];
  const priorAvatar = avatarReference(priorContact?.identity || priorContact || {});
  const nextAvatar = avatarReference(row);
  if (priorAvatar && nextAvatar && priorAvatar !== nextAvatar) warnings.push('avatar_reference_changed_same_visible_tuple');

  const sample = sampleFor(snapshot, row, warnings);
  const source = state.rawSources[key] || { firstObservedSample: null, latestObservedSample: null };
  let newMessageCount = 0, updatedMessageCount = 0, unidentifiedObservationCount = 0;
  for (const [index, message] of items.entries()) {
    if (!nonEmpty(message.messageId)) {
      recordUnknownId(state, key, message, observedAt, captureId, index);
      unidentifiedObservationCount++;
      continue;
    }
    const result = upsertMessage(state, key, message, observedAt);
    if (result.inserted) newMessageCount++;
    else updatedMessageCount++;
  }
  const messages = Object.values(state.messages).filter((message) => message.identityKey === key);
  const isHistory = snapshot.captureMode === 'bulk_history' || snapshot.captureMode === 'api_history';
  const oldestHistorySample = isHistory ? sample : source.oldestHistorySample;
  const historyCoverage = isHistory
    ? { ...clone(snapshot.historyCoverage || {}), verified: false,
      scope: snapshot.captureTransport === 'history_api' || snapshot.captureMode === 'api_history'
        ? 'all_history_pages_currently_returned_by_site' : 'messages_loaded_by_history_scroll' }
    : priorContact?.historyCoverage || { verified: false, scope: 'currently_rendered_messages_only' };
  const samples = [source.firstObservedSample, sample, oldestHistorySample].filter(Boolean);
  const originInference = originFor(samples, messages, historyCoverage);
  const firstObservedAt = priorContact?.firstObservedAt || observedAt;
  const contact = {
    ...(priorContact || {}), ...clone(row),
    provisionalIdentityKey: key,
    provisionalIdentityKeyQuality: row.provisionalIdentityKeyQuality || 'visible_name_tuple_provisional',
    provisionalIdentityKeyWarning: row.provisionalIdentityKeyWarning || 'Visible company, HR, and role values may collide or change.',
    identity: clone(row),
    firstObservedAt, lastObservedAt: observedAt,
    firstCommunicationAt: priorContact?.firstCommunicationAt || null,
    firstAvailableMessageAt: oldestHistorySample?.messages?.items?.find(message => ['hr', 'self'].includes(message.direction))?.sentAtISO ||
      priorContact?.firstAvailableMessageAt || null,
    initiator: originInference.origin, origin: originInference.origin,
    originConfidence: originInference.confidence, originInference,
    originScope: 'oldest_sender_in_loaded_dom_sample_only',
    fullHistoryVerified: false,
    historyCoverage,
    lastHeaderText: (snapshot.active?.headers || []).map((header) => compact(header?.text)).filter(Boolean).join(' | '),
    lastCapturedMessageCount: items.length, lastCapturedAt: observedAt,
    warnings,
  };
  state.contacts[key] = contact;
  state.rawSources[key] = {
    firstObservedSample: source.firstObservedSample || sample,
    latestObservedSample: sample,
    oldestHistorySample: oldestHistorySample || null,
    latestSessionId: sessionId,
  };
  state.captures.push({ captureId, sessionId, identityKey: key, observedAt, warnings,
    messageCount: items.length, unidentifiedObservationCount });
  state.updatedAt = receivedAt;
  return { accepted: true, changed: true, state, summary: summarizeState(state), identityKey: key,
    newMessageCount, updatedMessageCount, unidentifiedObservationCount, warnings };
}

function uniqueRows(rowsByKey) {
  return Object.entries(rowsByKey).map(([key, row]) => ({ ...clone(row), provisionalIdentityKey: key }));
}

export function exportWalk(value, { now = new Date().toISOString() } = {}) {
  const state = normalizeState(value, { now });
  const keys = Object.keys(state.contacts);
  const conversations = keys.map((key) => {
    const contact = state.contacts[key];
    const source = state.rawSources[key] || {};
    const samples = [source.firstObservedSample, source.latestObservedSample, source.oldestHistorySample].filter((sample, index, all) =>
      sample && all.indexOf(sample) === index);
    const messages = Object.values(state.messages).filter((message) => message.identityKey === key).map(clone);
    const originInference = originFor(samples, messages, contact.historyCoverage);
    return {
      identity: clone(contact.identity || contact),
      clickEvidence: { action: source.oldestHistorySample?.captureTransport === 'history_api' ? 'readonly_history_api'
        : source.oldestHistorySample ? 'extension_conversation_navigation' : 'manual_selection_or_observed_active_panel',
        observedPanelConfirmed: samples.length > 0, automaticNavigation: Boolean(source.oldestHistorySample) && source.oldestHistorySample?.captureTransport !== 'history_api' },
      samples, messages,
      unidentifiedMessages: state.unidentifiedMessages.filter((item) => item.identityKey === key).map(clone),
      initiator: originInference.origin, origin: originInference.origin,
      originConfidence: originInference.confidence, originInference,
      originScope: 'oldest_sender_in_loaded_dom_sample_only',
      historyCoverage: clone(contact.historyCoverage || { verified: false, scope: 'currently_rendered_messages_only' }),
      firstCommunicationAt: contact.firstCommunicationAt || null,
      firstAvailableMessageAt: contact.firstAvailableMessageAt || null,
      firstObservedAt: contact.firstObservedAt,
      lastObservedAt: contact.lastObservedAt,
      fullHistoryVerified: false,
      warnings: clone(contact.warnings || []),
    };
  });
  const initialRows = uniqueRows(state.initialRowsByKey);
  const closingRows = uniqueRows(state.closingRowsByKey);
  const initial = new Map(initialRows.map((row) => [canonicalIdentityKey(row), row]));
  const closingKeys = new Set(closingRows.map(canonicalIdentityKey));
  const newlyObservedRows = closingRows.filter((row) => !initial.has(canonicalIdentityKey(row)));
  const noLongerObservedRows = initialRows.filter((row) => !closingKeys.has(canonicalIdentityKey(row)));
  const changedPreviews = closingRows.flatMap((row) => {
    const key = canonicalIdentityKey(row);
    const before = initial.get(key);
    return before && (before.previewText ?? null) !== (row.previewText ?? null)
      ? [{ key, before: before.previewText ?? null, after: row.previewText ?? null }] : [];
  });
  const rawSources = keys.flatMap((key) => {
    const source = state.rawSources[key] || {};
    return [
      ...(source.firstObservedSample ? [{ identityKey: key, sampleRole: 'first_observed', ...clone(source.firstObservedSample) }] : []),
      ...(source.latestObservedSample ? [{ identityKey: key, sampleRole: 'latest_observed', ...clone(source.latestObservedSample) }] : []),
      ...(source.oldestHistorySample ? [{ identityKey: key, sampleRole: 'oldest_history_observed', ...clone(source.oldestHistorySample) }] : []),
    ];
  });
  return {
    schemaVersion: 1, mode: 'readonly_extension_capture',
    profileNamespace: state.profileNamespace, sourceNamespace: state.profileNamespace,
    targetId: null, targetUrl: 'https://www.zhipin.com/web/geek/chat', cdpMethods: [],
    startedAt: now, finishedAt: now,
    fullAccountCoverageVerified: false,
    selectedCohortCoverageVerified: conversations.length > 0,
    selectedCohortScope: 'contacts associated from the active row in snapshots stored by this browser profile',
    listBaselineScope: 'union of rows observed by this extension in this browser profile',
    initialRows, closingRows,
    selectedKeys: conversations.map((conversation) => canonicalIdentityKey(conversation.identity)),
    excludedRows: [], conversations, newlyObservedRows, noLongerObservedRows, changedPreviews, rawSources,
    unassignedObservations: clone(state.unassignedObservations), errors: [],
    limitations: [
      '原始网页快照和可疑状态会保存在本地并附带 warnings；未验证账号全部会话或完整聊天历史。',
      '首次采集时间不等于首次沟通时间；原始消息时间标签不转换为绝对时间。',
      '可见公司、HR、角色元组可能缺项、变化或碰撞；无活动会话行的观察保留为 unassigned。',
    ],
  };
}
