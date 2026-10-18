const KNOWN_SPEAKERS = new Set(['self', 'hr']);
const IGNORED_KINDS = new Set(['system']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function directionOf(message) {
  const direction = typeof message?.direction === 'string' ? message.direction.trim().toLowerCase() : '';
  return KNOWN_SPEAKERS.has(direction) ? direction : 'unknown';
}

function isArticlesCenterHint(message) {
  const evidence = [message?.kindEvidence, message?.directionEvidence, message?.className,
    message?.source, message?.selector].filter(nonEmpty).join(' ').toLowerCase();
  return evidence.includes('articles-center');
}

function isConversationNoise(message) {
  const kind = typeof message?.kind === 'string' ? message.kind.trim().toLowerCase() : '';
  if (IGNORED_KINDS.has(kind)) return true;
  if (kind === 'platform_card' && isArticlesCenterHint(message)) return true;
  // A direction=system attachment can still be a real media message whose sender
  // was not identified. Keep it as an ordering barrier rather than skipping it.
  if (typeof message?.direction === 'string' && message.direction.trim().toLowerCase() === 'system' && kind !== 'attachment') return true;
  return false;
}

function messageIdOf(message) {
  for (const value of [message?.messageId, message?.message_id, message?.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function evidenceFor(message, capturedAt = null) {
  return {
    messageId: messageIdOf(message),
    rawTimeLabel: typeof message?.rawTimeLabel === 'string' ? message.rawTimeLabel :
      (typeof message?.raw_time_label === 'string' ? message.raw_time_label : null),
    capturedAt: typeof capturedAt === 'string' ? capturedAt :
      (typeof message?.capturedAt === 'string' ? message.capturedAt :
        (typeof message?.firstObservedAt === 'string' ? message.firstObservedAt : null)),
  };
}

function observedAtEntry(sample, message) {
  return {
    message,
    capturedAt: typeof sample?.page?.capturedAt === 'string' ? sample.page.capturedAt :
      (typeof sample?.capturedAt === 'string' ? sample.capturedAt : null),
  };
}

function findStartSample(samples) {
  return samples.findIndex((sample) => sample?.isStartSample === true && sample?.complete === true);
}

function hasStartMarker(value) {
  const marker = asObject(value);
  if (marker.noMoreHistory === true || marker.platformConversationStart === true) return true;
  const labels = [marker.kind, marker.type, marker.marker].filter(nonEmpty)
    .map((entry) => entry.trim().toLowerCase());
  return labels.some((entry) => entry === 'no_more_history' || entry === 'platform_conversation_start');
}

function getSampleEntries(sample) {
  const items = sample?.messages?.items;
  if (!Array.isArray(items)) return [];
  return items.map((message) => observedAtEntry(sample, message));
}

function buildMessageIndex(conversation, samples) {
  const index = new Map();
  for (const sample of samples) {
    for (const entry of getSampleEntries(sample)) {
      const id = messageIdOf(entry.message);
      if (id && !index.has(id)) index.set(id, entry);
    }
  }
  for (const message of Array.isArray(conversation.messages) ? conversation.messages : []) {
    const id = messageIdOf(message);
    if (id && !index.has(id)) index.set(id, { message, capturedAt: null });
  }
  return index;
}

function firstSpeaker(entries) {
  for (const entry of entries) {
    const message = entry?.message;
    if (!message || isConversationNoise(message)) continue;
    const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : '';
    const direction = directionOf(message);
    const hasText = nonEmpty(message.contentText) || nonEmpty(message.text) || nonEmpty(message.content_text);

    // Direction on a real text, attachment, or Boss message card is useful
    // sender evidence. A direction-unknown attachment/card remains a barrier.
    const isSenderBearing = hasText || kind === 'attachment' || kind === 'platform_card' ||
      kind === 'unknown' || !kind;
    if (!isSenderBearing) return { speaker: 'unknown', entry, reason: 'first_message_type_unresolved' };
    if (direction === 'unknown') return { speaker: 'unknown', entry, reason: 'first_message_direction_unresolved' };
    return { speaker: direction, entry, reason: 'first_sender_message' };
  }
  return { speaker: 'unknown', entry: null, reason: 'no_sender_message' };
}

function orderedEntries(ids, messageIndex) {
  if (!Array.isArray(ids) || ids.length === 0) return { entries: null, reason: 'ordered_ids_missing' };
  const normalized = ids.map((value) => typeof value === 'string' ? value.trim() : '');
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) {
    return { entries: null, reason: 'ordered_ids_invalid' };
  }
  const entries = [];
  for (const id of normalized) {
    const entry = messageIndex.get(id);
    if (!entry) return { entries: null, reason: 'ordered_message_missing' };
    entries.push(entry);
  }
  return { entries, reason: null };
}

function hasUnorderedSampleMessage(samples, orderedIds) {
  const ordered = new Set(orderedIds);
  for (const sample of samples) {
    for (const entry of getSampleEntries(sample)) {
      if (isConversationNoise(entry.message)) continue;
      const id = messageIdOf(entry.message);
      if (!id || !ordered.has(id)) return true;
    }
  }
  return false;
}

function unknownResult(firstObservedSpeaker = 'unknown', firstObservedEvidence = null,
  reason = 'message_order_unverified', evidence = null) {
  return {
    origin: 'unknown',
    confidence: 'unknown',
    provisional: false,
    firstObservedSpeaker,
    evidence: evidence || firstObservedEvidence || { messageId: null, rawTimeLabel: null, capturedAt: null },
    firstObservedEvidence: firstObservedEvidence || { messageId: null, rawTimeLabel: null, capturedAt: null },
    reason,
  };
}

/**
 * Infer which side appears to have initiated a conversation from explicitly
 * ordered message evidence. Incomplete captures can produce a provisional
 * observation, but only a verified conversation start can produce a confirmed
 * origin. Message timestamps are evidence only; they are never used to sort.
 */
export function analyzeConversationOrigin(conversation) {
  const input = asObject(conversation);
  const samples = Array.isArray(input.samples) ? input.samples.filter((sample) => sample && typeof sample === 'object') : [];
  const coverage = asObject(input.historyCoverage);
  const messageIndex = buildMessageIndex(input, samples);
  const latestSample = samples.length ? samples[samples.length - 1] : null;
  const latestSampleFirst = latestSample ? firstSpeaker(getSampleEntries(latestSample)) :
    { speaker: 'unknown', entry: null, reason: 'no_sample_messages' };
  const firstObservedSpeaker = latestSampleFirst.speaker;
  const firstObservedEvidence = latestSampleFirst.entry ?
    evidenceFor(latestSampleFirst.entry.message, latestSampleFirst.entry.capturedAt) : null;

  const hasVerifiedStart = coverage.startReached === true && hasStartMarker(coverage.startEvidence);
  const startSampleIndex = findStartSample(samples);
  const startSample = startSampleIndex >= 0 ? samples[startSampleIndex] : null;

  let candidateEntries = null;
  let sequenceSource = null;
  let orderingFailure = null;

  // A complete sample explicitly marked as the conversation start preserves
  // DOM order, including messages without IDs and unresolved media at the top.
  if (startSample) {
    candidateEntries = getSampleEntries(startSample);
    sequenceSource = 'complete_start_sample_dom_order';
  } else if (Array.isArray(coverage.orderedMessageIds)) {
    const ordered = orderedEntries(coverage.orderedMessageIds, messageIndex);
    const hasUnorderedMessages = ordered.entries && hasUnorderedSampleMessage(samples, coverage.orderedMessageIds);
    candidateEntries = hasUnorderedMessages ? null : ordered.entries;
    sequenceSource = candidateEntries ? 'ordered_message_ids' : null;
    orderingFailure = hasUnorderedMessages ? 'sample_message_missing_from_order' : ordered.reason;
  } else if (latestSample) {
    // This is only the first sender visible in the latest captured DOM sample;
    // it is never treated as the actual conversation start without coverage.
    candidateEntries = getSampleEntries(latestSample);
    sequenceSource = 'latest_sample_dom_order_provisional';
  }

  if (!candidateEntries) {
    return unknownResult(firstObservedSpeaker, firstObservedEvidence,
      orderingFailure || (latestSample ? latestSampleFirst.reason : 'message_order_unverified'));
  }

  const candidate = firstSpeaker(candidateEntries);
  if (candidate.speaker === 'unknown' || !candidate.entry) {
    const evidence = candidate.entry ? evidenceFor(candidate.entry.message, candidate.entry.capturedAt) : null;
    return unknownResult(firstObservedSpeaker, firstObservedEvidence, candidate.reason, evidence);
  }

  const confirmed = hasVerifiedStart && sequenceSource !== 'latest_sample_dom_order_provisional';
  const evidence = evidenceFor(candidate.entry.message, candidate.entry.capturedAt);
  return {
    origin: candidate.speaker,
    confidence: confirmed ? 'confirmed' : 'provisional',
    provisional: !confirmed,
    firstObservedSpeaker,
    evidence,
    firstObservedEvidence: firstObservedEvidence || evidence,
    reason: confirmed ? 'verified_conversation_start' : 'conversation_start_not_verified',
  };
}
