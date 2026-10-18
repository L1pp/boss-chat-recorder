import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../extension-tracker/model.mjs';
import { splitConversationState, combineConversationState } from '../extension-tracker/conversation-state.mjs';

test('conversation split round trips every model field and unassigned observation without mutation', () => {
  const state = createEmptyState();
  state.contacts.a = { name: 'A' };
  state.contacts.b = null;
  state.rawSources.sourceOnly = { firstObservedSample: { text: 'synthetic raw' } };
  state.messages.ma = { messageId: 'same', identityKey: 'a' };
  state.messages.messageOnly = { identityKey: 'messageOnly', text: 'B' };
  state.messages.orphan = { text: 'no identity' };
  state.messages.empty = { identityKey: '' };
  state.initialRowsByKey.rowOnly = { active: false };
  state.closingRowsByKey.a = { preview: 'latest' };
  state.captures = [{ captureId: 2 }, { captureId: 1 }];
  state.unidentifiedMessages = [{ text: 'unknown 2' }, { text: 'unknown 1' }];
  state.unassignedObservations = [{ snapshot: { text: 'kept' } }];
  state.futureField = { arbitrary: ['preserved'] };
  const before = structuredClone(state);
  const split = splitConversationState(state);
  assert.deepEqual(combineConversationState(split.header, split.records), before);
  assert.deepEqual(state, before);
  assert.deepEqual(split.header.messages, { orphan: state.messages.orphan, empty: state.messages.empty });
  assert.equal(Object.hasOwn(split.records.find(record => record.identityKey === 'messageOnly'), 'contact'), false);
  assert.equal(Object.hasOwn(split.records.find(record => record.identityKey === 'b'), 'contact'), true);
  assert.equal(split.records.find(record => record.identityKey === 'b').contact, null);
});

test('subset reconstruction contains only requested conversations and keeps global observation order', () => {
  const state = createEmptyState();
  state.contacts.a = { name: 'A' }; state.contacts.b = { name: 'B' };
  state.messages.a = { identityKey: 'a' }; state.messages.b = { identityKey: 'b' };
  state.captures = [{ captureId: 'second' }, { captureId: 'first' }];
  const { header, records } = splitConversationState(state);
  const subset = combineConversationState(header, records.filter(record => record.identityKey === 'a'));
  assert.deepEqual(Object.keys(subset.contacts), ['a']);
  assert.deepEqual(Object.keys(subset.messages), ['a']);
  assert.deepEqual(subset.captures, state.captures);
  assert.deepEqual(header.contacts, {});
});

test('special identity and message keys are data and never modify object prototypes', () => {
  const state = createEmptyState();
  state.contacts = Object.fromEntries([['__proto__', { name: 'kept' }], ['constructor', { name: 'also kept' }]]);
  state.messages = Object.fromEntries([['__proto__', { identityKey: '__proto__', messageId: 'mid' }]]);
  const { header, records } = splitConversationState(state);
  const restored = combineConversationState(header, records);
  assert.deepEqual(restored, state);
  assert.equal(Object.hasOwn(restored.contacts, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(restored.contacts), Object.prototype);
  assert.equal(Object.getPrototypeOf(restored.messages), Object.prototype);
  assert.equal({}.name, undefined);
});
