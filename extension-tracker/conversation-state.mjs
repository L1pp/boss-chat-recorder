const maps = ['contacts', 'messages', 'rawSources', 'initialRowsByKey', 'closingRowsByKey'];
const own = (target, key, value) => Object.defineProperty(target, key,
  { value, enumerable: true, configurable: true, writable: true });
const fields = [['contacts', 'contact'], ['rawSources', 'rawSource'],
  ['initialRowsByKey', 'initialRow'], ['closingRowsByKey', 'closingRow']];

// Preserve the original model and raw observations; only change storage layout.
export function splitConversationState(state) {
  const groups = new Map();
  const group = identityKey => {
    if (!groups.has(identityKey)) groups.set(identityKey, { identityKey, messages: {} });
    return groups.get(identityKey);
  };
  for (const [map, field] of fields) {
    for (const [identityKey, value] of Object.entries(state[map] || {})) group(identityKey)[field] = value;
  }
  const unassigned = {};
  for (const [key, value] of Object.entries(state.messages || {})) {
    const identity = value?.identityKey;
    own(typeof identity === 'string' && identity ? group(identity).messages : unassigned, key, value);
  }
  const header = { ...state, ...Object.fromEntries(maps.map(key => [key, {}])), messages: unassigned };
  return { header, records: [...groups.values()] };
}

export function combineConversationState(header, records) {
  const state = { ...header, ...Object.fromEntries(maps.map(key => [key, { ...(header[key] || {}) }])) };
  for (const record of records) {
    for (const [map, field] of fields) {
      if (Object.hasOwn(record, field)) own(state[map], record.identityKey, record[field]);
    }
    for (const [key, message] of Object.entries(record.messages || {})) own(state.messages, key, message);
  }
  return state;
}
