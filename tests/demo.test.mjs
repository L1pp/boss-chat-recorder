import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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

function openPreview(html, navigator) {
  function element(tag, attributes = {}) {
    return {
      tag, attributes, children: [], value: '', textContent: '',
      dataset: Object.fromEntries(Object.entries(attributes)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5), value])),
      listeners: {},
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
    };
  }
  const nodes = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/giu)].map(([, tag, raw]) => {
    const attributes = Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/gu)]
      .map(([, key, value]) => [key, value]));
    return element(tag, attributes);
  });
  const byId = id => nodes.find(node => node.attributes.id === id);
  byId('demo-data').textContent = html.match(/<script id="demo-data" type="application\/json">([\s\S]*?)<\/script>/u)[1];
  let dataReads = 0;
  const document = {
    title: '', documentElement: {},
    getElementById: byId,
    querySelectorAll(selector) {
      return nodes.filter(node => Object.hasOwn(node.attributes, selector.slice(1, -1)));
    },
    createElement: tag => element(tag),
    createDocumentFragment: () => element('fragment'),
  };
  vm.runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/u)[1], {
    document, navigator,
    JSON: {
      parse(value) { dataReads += 1; return JSON.parse(value); },
      stringify: JSON.stringify,
    },
  });
  const text = node => node.textContent + node.children.map(text).join('\n');
  return {
    document, byId,
    text: () => text(byId('preview')),
    selectLanguage(value) {
      const picker = byId('language');
      picker.value = value;
      picker.listeners.change();
    },
    click(attribute, value) {
      nodes.find(node => node.attributes[attribute] === value).listeners.click();
    },
    dataReads: () => dataReads,
  };
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

test('offline preview selects the browser language, with English as the fallback', async t => {
  const directory = await generatedDirectory(t);
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-HK']) {
    const preview = openPreview(html, { language, languages: ['en-US', 'zh-CN'] });
    assert.equal(preview.document.documentElement.lang, 'zh-CN');
    assert.equal(preview.byId('language').value, 'zh');
    assert.match(preview.text(), /求职账号甲 · 本轮已更新的会话/u);
  }
  for (const navigator of [
    { language: 'en-US', languages: ['zh-CN'] },
    { language: 'fr-FR', languages: ['zh-CN'] },
    {},
  ]) {
    const preview = openPreview(html, navigator);
    assert.equal(preview.document.documentElement.lang, 'en');
    assert.equal(preview.document.title, 'Local synthetic demo');
    assert.match(preview.text(), /Job seeker A · Conversations updated this round/u);
    assert.match(preview.text(), /Recruiter ID: demo-hr-shared/u);
  }
});

test('language switching redraws the selected scope without translating or rereading messages', async t => {
  const directory = await generatedDirectory(t);
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  const preview = openPreview(html, { language: 'zh-CN' });
  const originalData = preview.byId('demo-data').textContent;
  preview.click('data-account', 'account-b');
  preview.click('data-scope', 'all');
  preview.selectLanguage('en');
  assert.equal(preview.document.documentElement.lang, 'en');
  assert.match(preview.text(), /Job seeker B · All saved conversations/u);
  assert.match(preview.text(), /Conversations: 2 · No changes: No/u);
  assert.match(preview.text(), /Recruiter · .*欢迎了解示例甲的数据分析岗位。/u);
  assert.match(preview.text(), /Job seeker · .*您好，我可以补充项目经验。/u);
  assert.match(preview.text(), /Available history complete: No/u);
  preview.selectLanguage('zh');
  assert.match(preview.text(), /求职账号乙 · 全部已保存的会话/u);
  assert.match(preview.text(), /会话数：2 · 无变化：否/u);
  assert.match(preview.text(), /欢迎了解示例甲的数据分析岗位。/u);
  assert.equal(preview.byId('demo-data').textContent, originalData);
  assert.equal(preview.dataReads(), 1);
  preview.click('data-scope', 'noChange');
  preview.selectLanguage('en');
  assert.match(preview.text(), /No changes this round/u);
  assert.match(preview.text(), /Conversations: 0 · No changes: Yes/u);
  assert.doesNotMatch(preview.text(), /欢迎了解/u);
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
