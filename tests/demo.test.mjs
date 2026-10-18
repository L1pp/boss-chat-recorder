import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateDemo } from '../scripts/generate-demo.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function snapshotTree(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(root, child));
    else snapshot[child.replaceAll(path.sep, '/')] = await readFile(path.join(root, child), 'utf8');
  }
  return snapshot;
}

async function generatedDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boss-demo-fixture-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await generateDemo(directory);
  return directory;
}

test('demo generation is reproducible and provides a fully offline preview', async () => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), 'boss-demo-first-'));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'boss-demo-second-'));
  try {
    await generateDemo(firstDirectory);
    await generateDemo(secondDirectory);
    const first = await snapshotTree(firstDirectory);
    const second = await snapshotTree(secondDirectory);
    assert.deepEqual(first, second);
    assert.ok(first['index.html']);
    assert.ok(first['demo-data/account-a/state.json']);
    assert.ok(first['demo-data/account-b/runtime.json']);
    const html = first['index.html'];
    assert.match(html, /合成演示数据/u);
    assert.match(html, /textContent/u);
    assert.doesNotMatch(html, /\bfetch\s*\(|https?:\/\/|\.innerHTML\b/iu);
    assert.ok(Object.values(first).every(contents => !/https?:\/\//iu.test(contents)));
  } finally {
    await rm(firstDirectory, { recursive: true, force: true });
    await rm(secondDirectory, { recursive: true, force: true });
  }
});

test('the two accounts may share HR and message ids without sharing conversations or messages', async t => {
  const directory = await generatedDirectory(t);
  const accountA = path.join(directory, 'demo-data', 'account-a');
  const accountB = path.join(directory, 'demo-data', 'account-b');
  const stateA = await readJson(path.join(accountA, 'state.json'));
  const stateB = await readJson(path.join(accountB, 'state.json'));
  const latestA = await readJson(path.join(accountA, 'ai-export-latest.json'));
  const latestB = await readJson(path.join(accountB, 'ai-export-latest.json'));
  const allA = await readJson(path.join(accountA, 'ai-export-all.json'));
  const allB = await readJson(path.join(accountB, 'ai-export-all.json'));

  assert.notEqual(stateA.profileNamespace, stateB.profileNamespace);
  assert.equal(latestA.conversations.length, 1);
  assert.equal(latestB.conversations.length, 1);
  const conversationA = latestA.conversations[0];
  const conversationB = latestB.conversations[0];
  assert.equal(conversationA.bossId, 'demo-hr-shared');
  assert.equal(conversationB.bossId, 'demo-hr-shared');
  assert.notEqual(conversationA.conversationId, conversationB.conversationId);

  const sharedA = conversationA.messages.find(message => message.messageId === 'demo-message-shared');
  const sharedB = conversationB.messages.find(message => message.messageId === 'demo-message-shared');
  assert.ok(sharedA);
  assert.ok(sharedB);
  assert.notEqual(sharedA.text, sharedB.text);
  assert.ok(conversationA.messages.every(message => message.messageId.startsWith('demo-')));
  assert.ok(conversationB.messages.every(message => message.messageId.startsWith('demo-')));

  const allMessageIdsA = allA.conversations.flatMap(conversation => conversation.messages.map(message => message.messageId));
  const allMessageIdsB = allB.conversations.flatMap(conversation => conversation.messages.map(message => message.messageId));
  assert.deepEqual(allMessageIdsA.filter(id => allMessageIdsB.includes(id)), ['demo-message-shared']);
  assert.ok(allA.conversations.every(conversation => conversation.conversationId.includes('account-a')));
  assert.ok(allB.conversations.every(conversation => conversation.conversationId.includes('account-b')));

  const image = conversationA.messages.find(message => message.media?.contentAvailable === false);
  assert.ok(image);
  assert.ok(image.media.details.some(detail => detail.value === '合成岗位示意图.png'));
  assert.equal(conversationA.historyCoverage.availableHistoryComplete, true);
  assert.equal(conversationB.historyCoverage.availableHistoryComplete, false);
  assert.equal(conversationB.historyCoverage.completeReason, 'demo_page_budget_reached');
});

test('no-change latest exports are empty while previous rounds remain in runtime history', async t => {
  const directory = await generatedDirectory(t);
  for (const account of ['account-a', 'account-b']) {
    const accountDirectory = path.join(directory, 'demo-data', account);
    const runtime = await readJson(path.join(accountDirectory, 'runtime-no-change.json'));
    const exportData = await readJson(path.join(accountDirectory, 'ai-export-no-change.json'));
    const progress = Object.values(runtime.progressByTab)[0];
    assert.equal(progress.selectedCount, 0);
    assert.ok(Object.keys(progress.historyResults).length > 0);
    assert.equal(exportData.scope.noChanges, true);
    assert.deepEqual(exportData.conversations, []);
  }
});
