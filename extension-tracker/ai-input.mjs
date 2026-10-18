// Chat facts for an AI to interpret. This module does not classify progress or
// send anything to a model; it only reads the extension's existing local data.
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => value === null || value === undefined ? null : String(value);
const copy = value => JSON.parse(JSON.stringify(value));

function epochIso(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(?:\.\d+)?$/u.test(String(value))) return null;
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch < 1e9) return null;
  const date = new Date(epoch >= 1e11 ? epoch : epoch * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function iso(value) {
  // A relative DOM label has no absolute date. Never substitute observedAt.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestProgress(progress, runtime, state) {
  if (progress) return progress.progress || progress;
  const candidates = Object.values(object(runtime?.progressByTab || state?.bulkProgress));
  return candidates.sort((left, right) => {
    const time = value => Date.parse(value?.updatedAt || value?.finishedAt || value?.startedAt || '') || 0;
    return time(right) - time(left);
  })[0] || null;
}

function bossId(contact) {
  const identity = contact?.identity || contact || {};
  return text(identity.bossId || identity.encryptBossId || identity.rawFriend?.encryptFriendId || contact?.bossId);
}

function selectedKeys(state, progress) {
  const entries = Object.entries(object(state.contacts));
  if (!progress?.runId) return new Set(entries.map(([key]) => key));
  const runId = progress.runId;
  const refreshedIds = new Set(array(progress.refreshedApiKeys).map(String));
  const keys = new Set();
  for (const [key, result] of Object.entries(object(progress.historyResults))) {
    // historyResults survives between rounds; completedKeys also includes the
    // skipped conversations. Only this round's result can select its context.
    if (result?.refreshedInRunId === runId &&
      (result.availableHistoryComplete === true || Number(result.pageCount) > 0)) keys.add(key);
  }
  for (const [key, contact] of entries) {
    if (refreshedIds.has(bossId(contact))) keys.add(key);
    if (state.rawSources?.[key]?.latestSessionId === runId) keys.add(key);
  }
  for (const capture of array(state.captures)) {
    if (capture?.sessionId === runId && capture.identityKey) keys.add(capture.identityKey);
  }
  return keys;
}

function manualUpdatesFor(state, contact, key) {
  const updates = [...array(contact.manualUpdates), ...array(state.manualUpdates).filter(update =>
    update?.identityKey === key || (bossId(contact) && text(update?.bossId) === bossId(contact)))];
  if (contact.manualConfirmation) updates.push(contact.manualConfirmation);
  // Preserve human notes and their explicitly entered status, not machine labels.
  const fields = ['id', 'updateId', 'channel', 'type', 'date', 'at', 'updatedAt', 'observedAt',
    'interviewAt', 'interviewTime', 'location', 'note', 'text', 'status', 'confirmed', 'source'];
  return updates.map(update => Object.fromEntries(fields.filter(field => update?.[field] !== undefined)
    .map(field => [field, copy(update[field])])));
}

function mediaSummary(message) {
  const body = object(message.rawApiMessage?.body);
  const summary = { type: message.apiBodyType ?? body.type ?? null };
  const display = ['headTitle', 'title', 'subtitle', 'description'].flatMap(field =>
    typeof body[field] === 'string' && body[field] ? [body[field]] : []);
  if (display.length) summary.displayText = [...new Set(display)];
  const media = ['image', 'file', 'voice', 'video', 'attachment'].filter(field => body[field] !== undefined);
  if (media.length) summary.mediaKinds = media;
  const properties = ['name', 'fileName', 'mimeType', 'size', 'duration', 'width', 'height',
    'interviewTime', 'interviewDate', 'address', 'location', 'venue', 'date', 'startTime', 'endTime', 'jobName'];
  const values = [body, ...media.map(field => object(body[field])), object(body.interview)];
  const details = values.flatMap(value => properties.filter(field =>
    ['string', 'number', 'boolean'].includes(typeof value[field]))
    .map(field => ({ field, value: value[field] })));
  if (details.length) summary.details = details;
  if (message.kind === 'attachment') summary.contentAvailable = false;
  return summary;
}

function inRun(timestamp, progress) {
  if (!progress?.runId || !progress.startedAt || !timestamp) return false;
  const start = Date.parse(progress.startedAt), value = Date.parse(timestamp);
  const end = Date.parse(progress.finishedAt || progress.updatedAt || new Date().toISOString());
  return Number.isFinite(start) && Number.isFinite(value) && value >= start && value <= end;
}

function messageFact(message, progress) {
  const raw = object(message.rawApiMessage);
  const sentAt = iso(message.sentAtISO || message.sentAt || message.sent_at) ||
    epochIso(message.rawApiTime ?? raw.time);
  const kind = message.kind || 'unknown';
  return {
    messageId: text(message.messageId ?? raw.mid),
    observationId: text(message.observationId),
    direction: message.direction || 'unknown',
    directionEvidence: message.directionEvidenceQuality || message.directionEvidence || null,
    kind, apiType: message.apiType ?? raw.type ?? null,
    apiBodyType: message.apiBodyType ?? object(raw.body).type ?? null,
    text: typeof message.contentText === 'string' && message.contentText
      ? message.contentText : typeof message.text === 'string' ? message.text : '',
    sentAt, rawTimeLabel: message.rawTimeLabel ?? null,
    rawTime: message.rawApiTime ?? raw.time ?? null,
    timeSource: sentAt ? 'explicit_message_send_time' : 'unknown_absolute_send_time',
    firstObservedAt: message.firstObservedAt || message.observedAt || null,
    lastObservedAt: message.lastObservedAt || message.observedAt || null,
    firstObservedInLatestUpdate: inRun(message.firstObservedAt || message.observedAt, progress),
    ...(kind === 'text' ? {} : { media: mediaSummary(message) }),
  };
}

function conversationFact(state, key, contact, progress, messages) {
  const identity = contact.identity || contact;
  const facts = messages.map(message => messageFact(message, progress));
  // JavaScript sorting is stable: undated observations retain stored order.
  facts.sort((left, right) => left.sentAt && right.sentAt
    ? Date.parse(left.sentAt) - Date.parse(right.sentAt) : left.sentAt ? -1 : right.sentAt ? 1 : 0);
  const first = facts.find(message => ['self', 'hr'].includes(message.direction) &&
    ['text', 'attachment'].includes(message.kind) && Number(message.apiType) !== 4 &&
    Number(message.apiBodyType) !== 16 &&
    !/撤回了一条消息|对方已同意[，,、\s]*您的附件简历已发送给对方/u.test(message.text)) || null;
  const coverage = contact.historyCoverage || {};
  const currentResult = progress?.historyResults?.[key];
  const history = currentResult && progress?.runId && currentResult.refreshedInRunId === progress.runId
    ? currentResult : coverage;
  return {
    conversationId: key, bossId: bossId(contact),
    identity: { company: identity.company || '', hrName: identity.hrName || '',
      hrRole: identity.hrRole || '', jobTitle: identity.jobTitle || identity.jobName || identity.positionName || '' },
    firstObservedAt: contact.firstObservedAt || null,
    lastObservedAt: contact.lastObservedAt || null,
    firstCommunicationAt: contact.firstCommunicationAt || null,
    firstAvailableMessageAt: first?.sentAt || iso(contact.firstAvailableMessageAt),
    firstAvailableMessageId: first?.messageId || null,
    firstAvailableSender: first?.direction || 'unknown',
    firstAvailableSenderScope: 'first_sender_in_saved_available_messages',
    historyCoverage: {
      availableHistoryComplete: history.availableHistoryComplete === true,
      scope: history.scope || 'saved_messages_only',
      completeReason: history.completeReason || history.reason || null,
      fullAccountHistoryVerified: false,
    },
    latestRefresh: progress?.runId ? {
      runId: progress.runId,
      capturedAt: currentResult?.refreshedInRunId === progress.runId ? currentResult.capturedAt || null : null,
      refreshReason: currentResult?.refreshedInRunId === progress.runId ? currentResult.refreshReason || null : null,
      error: currentResult?.refreshedInRunId === progress.runId ? currentResult.error || null : null,
    } : null,
    messageOrdering: 'known_absolute_send_times_ascending_then_undated_in_stored_order',
    messages: facts, manualUpdates: manualUpdatesFor(state, contact, key),
  };
}

/** Retain useful response metadata while excluding bodies and URL queries. */
function safeResponseDetails(value) {
  if (!value || typeof value !== 'object') return null;
  const details = {};
  for (const key of ['endpoint', 'finalPath']) {
    if (typeof value[key] !== 'string') continue;
    try { details[key] = new URL(value[key], 'https://example.invalid').pathname; } catch { /* omit invalid paths */ }
  }
  if (Number.isInteger(value.httpStatus)) details.httpStatus = value.httpStatus;
  if (typeof value.redirected === 'boolean') details.redirected = value.redirected;
  for (const key of ['contentType', 'responseKind']) {
    if (typeof value[key] === 'string') details[key] = value[key].slice(0, 128);
  }
  return Object.keys(details).length ? details : null;
}

/** Create a portable factual input, without copying raw credentials or rule conclusions. */
export function createAiAnalysisInput(state, { scope = 'latest_update', progress = null, runtime = null } = {}) {
  const source = object(state);
  const latest = latestProgress(progress, runtime, source);
  const requested = scope === 'all' ? 'all' : 'latest_update';
  const updateAvailable = Boolean(latest?.runId);
  const all = requested === 'all' || !updateAvailable;
  const selected = all ? new Set(Object.keys(object(source.contacts))) : selectedKeys(source, latest);
  const messagesByKey = new Map();
  for (const message of [...Object.values(object(source.messages)), ...array(source.unidentifiedMessages)]) {
    if (!selected.has(message?.identityKey)) continue;
    if (!messagesByKey.has(message.identityKey)) messagesByKey.set(message.identityKey, []);
    messagesByKey.get(message.identityKey).push(message);
  }
  const conversations = Object.entries(object(source.contacts)).filter(([key]) => selected.has(key))
    .map(([key, contact]) => conversationFact(source, key, contact, latest, messagesByKey.get(key) || []));
  const noChanges = updateAvailable && latest?.kind === 'api_v1' &&
    Number(latest.selectedCount) === 0 && latest.listBoundaryReached === true &&
    (latest.status === 'completed' || latest.state === 'completed');
  return {
    schemaVersion: 1, purpose: 'boss_chat_facts_for_ai_analysis', generatedAt: new Date().toISOString(),
    sourceNamespace: source.profileNamespace || null,
    scope: {
      requested, effective: all ? 'all_saved_conversations' : 'latest_update',
      description: requested === 'all' ? '本地已保存的全部会话事实。' : !updateAvailable
        ? '尚无更新轮次记录，提供本地已保存会话作为初始上下文。' : noChanges
          ? '本轮没有变化会话，conversations 为空；不要据此重复生成全量进展。'
          : '仅包含本轮实际读取并保存的变化会话；每个会话保留完整已保存消息上下文。',
      updateRecordAvailable: updateAvailable, noChanges,
      selectionBasis: all ? 'all_local_contacts' : 'this_run_refreshed_api_keys_or_history_captures',
      conversationCount: conversations.length, fullAccountCoverageVerified: false,
    },
    latestUpdate: updateAvailable ? {
      runId: latest.runId, mode: latest.runMode || null, status: latest.status || latest.state || null,
      startedAt: latest.startedAt || null, finishedAt: latest.finishedAt || null,
      scannedCount: latest.scannedCount ?? latest.discovered ?? null,
      changedConversationCount: latest.selectedCount ?? null,
      refreshedCount: latest.refreshedCount ?? null,
      skippedUnchangedCount: latest.skippedUnchangedCount ?? null,
      newlySavedMessageCount: latest.newMessageCount ?? null,
      failedCount: latest.failed ?? null,
      availableRecordsComplete: latest.availableRecordsComplete === true,
      error: latest.error || null,
      ...(latest.errorCode ? { errorCode: String(latest.errorCode) } : {}),
      ...(safeResponseDetails(latest.errorDetails) ? { errorDetails: safeResponseDetails(latest.errorDetails) } : {}),
    } : null,
    instructions: [
      '请根据聊天事实进行 AI 分析，不要把关键词或本地机器规则分类当成最终结论。',
      '判断招聘进展，提取需要我回复的事项、面试邀请及已经确认的时间地点；区分条件性介绍、等待通知、正式邀约、拒绝和我的婉拒。',
      '保留公司、岗位、HR、最早可取消息时间与最早可取消息发起方；引用 conversationId 和 messageId，让我可以核对和修正。',
      '最早可取消息不一定是账号历史第一条。availableHistoryComplete 仅表示网站当前提供的该会话历史已读取，不能推断账号全部历史完整。',
      'sentAt 是明确的实际发送时间；rawTimeLabel 保留原网页标签。没有绝对发送时间时不要将 firstObservedAt 或 lastObservedAt 当作发送时间。',
      'newlySavedMessageCount 和 firstObservedInLatestUpdate 表示本次首次保存的数据，其中可能是旧历史，不等于今天新发送或新联系。',
      '结合完整会话上下文和人工补充判断最新进展；图片、语音或附件只提供摘要时，不要推断未读取的内容。',
      '无变化或证据不足时明确说明；不要凭空补齐职位、进展或面试日程。',
    ],
    conversations,
  };
}
