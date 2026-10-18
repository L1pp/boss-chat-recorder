import { summarizeState } from './model.mjs';
import { splitConversationState, combineConversationState } from './conversation-state.mjs';

export const CONVERSATION_BODY_PREFIX = 'bossReadonlyTracker.conversations.v1:';
const prefixFor = uid => `${CONVERSATION_BODY_PREFIX}${encodeURIComponent(uid)}:`;
export const conversationHeaderKey = uid => `${prefixFor(uid)}header`;
const ledgerKey = uid => `${prefixFor(uid)}versions`;
const recordKey = (uid, version) => `${prefixFor(uid)}record:${version}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Called only within the account store's existing serialized transaction queue.
export function createConversationBodyStore(storage, operation = (_, task) => task()) {
  const get = key => operation('body.get', () => storage.get(key));
  const set = values => operation('body.set', () => storage.set(values));

  async function readHeader(uid) {
    const key = conversationHeaderKey(uid);
    const value = (await get(key))?.[key];
    if (!object(value) || value.schemaVersion !== 1 || value.accountUid !== uid ||
        !object(value.refs) || !object(value.state) || !object(value.summary)) {
      throw new Error('CONVERSATION_BODY_INVALID');
    }
    return value;
  }

  async function read(uid, identities = null) {
    const header = await readHeader(uid);
    const ids = identities === null ? Object.keys(header.refs) : [...new Set(identities)];
    const selected = ids.filter(id => Object.hasOwn(header.refs, id));
    const keys = selected.map(id => recordKey(uid, header.refs[id]));
    const values = keys.length ? await get(keys) : {};
    const records = selected.map((id, index) => {
      const record = values[keys[index]];
      if (!object(record) || record.accountUid !== uid || record.identityKey !== id) {
        throw new Error('CONVERSATION_RECORD_MISSING');
      }
      return record;
    });
    const state = combineConversationState(header.state, records);
    return { header, records, identities: ids, state, selectedSummary: summarizeState(state) };
  }

  async function commit(uid, state, previous = null, { partial = false } = {}) {
    const { header: stateHeader, records } = splitConversationState(state);
    const refs = partial ? { ...previous.header.refs } : {};
    if (partial) for (const id of previous.identities) delete refs[id];
    const values = {}, versions = [];
    for (const record of records) {
      const version = globalThis.crypto.randomUUID();
      versions.push(version);
      Object.defineProperty(refs, record.identityKey, { value: version, enumerable: true,
        configurable: true, writable: true });
      values[recordKey(uid, version)] = { ...record, accountUid: uid };
    }
    const selectedSummary = summarizeState(state);
    let summary = selectedSummary;
    if (partial) {
      const before = previous.selectedSummary;
      summary = { ...previous.header.summary, updatedAt: selectedSummary.updatedAt,
        unidentifiedObservationCount: selectedSummary.unidentifiedObservationCount };
      for (const key of ['contactCount', 'messageCount', 'originConfirmedCount', 'originProvisionalCount']) {
        summary[key] = (previous.header.summary[key] || 0) + selectedSummary[key] - before[key];
      }
    }
    // Keep an account-local list of allocated versions so explicit account
    // deletion can also remove unpublished records without reading other keys.
    const ledger = ledgerKey(uid);
    const allocated = (await get(ledger))?.[ledger];
    await set({ [ledger]: [...(Array.isArray(allocated) ? allocated : []), ...versions] });
    if (versions.length) await set(values);
    const next = { schemaVersion: 1, accountUid: uid, refs, state: stateHeader, summary };
    // The single header is the commit point. Until it succeeds, old immutable
    // records remain the readable version; never fall back to the legacy body.
    await operation('body.header.set', () => storage.set({ [conversationHeaderKey(uid)]: next }));
    return next;
  }

  async function keys(uid) {
    const ledger = ledgerKey(uid);
    const allocated = (await get(ledger))?.[ledger];
    return [conversationHeaderKey(uid), ledger,
      ...(Array.isArray(allocated) ? allocated.map(version => recordKey(uid, version)) : [])];
  }

  async function clear(uid) {
    const names = await keys(uid);
    if (storage.remove) await operation('body.remove', () => storage.remove(names));
    else await set(Object.fromEntries(names.map(name => [name, null])));
  }

  return { read, commit, clear, keys };
}
