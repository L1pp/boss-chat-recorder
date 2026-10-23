import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  createExtensionHarness,
  extensionPageOperation,
  getExtensionWorker,
  waitForServiceWorkerVersion,
} from './extension-harness.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const accountA = 'demo-account-a';
const accountB = 'demo-account-b';
const popupViewKey = 'bossReadonlyTracker.popupView.v1';
const languagePreferenceKey = 'bossReadonlyTracker.uiLanguage.v1';
let harness;

async function cachePopupView(view) {
  const worker = await getExtensionWorker(harness.context, harness.extensionId);
  await worker.evaluate(({ key, view }) => chrome.storage.local.set({ [key]: view }), {
    key: popupViewKey, view,
  });
}

function emptyPopupView() {
  return {
    accountUid: 'demo-first-run', summary: { contactCount: 0, messageCount: 0 },
    progress: null, hasCollectionHistory: false, verificationRequired: false,
    updatedAt: '2026-10-23T12:00:00.000Z',
  };
}

async function restartWithBrowserLocale(browserLocale) {
  await harness.closeContextForRestart();
  harness.browserLocale = browserLocale;
  await harness.startContext();
}

async function readFixture(accountUid) {
  const path = resolve(repositoryRoot, 'examples', 'demo-data', accountUid === accountA ? 'account-a' : 'account-b', 'state.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function seedBothAccounts(page) {
  const [stateA, stateB] = await Promise.all([readFixture(accountA), readFixture(accountB)]);
  return extensionPageOperation(page, 'seed', {
    accounts: { [accountA]: stateA, [accountB]: stateB },
  });
}

async function openAndCheckPopup(operationPage, accountUid, contactCount, messageCount) {
  const state = await extensionPageOperation(operationPage, 'get-state', { accountUid });
  expect(state.ok).toBe(true);
  await expect.poll(() => extensionPageOperation(operationPage, 'popup-cache')).toMatchObject({ accountUid });
  const page = await harness.openPopupPage();
  await expect(page.locator('#account')).toHaveText(accountUid);
  await expect(page.locator('#contact-count')).toHaveText(String(contactCount));
  await expect(page.locator('#message-count')).toHaveText(String(messageCount));
  await expect(page.locator('#status')).toContainText('已显示本地记录缓存');
  await page.close();
}

test.beforeEach(async ({}, testInfo) => {
  harness = await createExtensionHarness(testInfo);
});

test.afterEach(async () => {
  const current = harness;
  harness = null;
  if (current) await current.finish();
});

test('first-run guidance uses the local empty view and existing records restore the update actions', async ({}, testInfo) => {
  const operationPage = await harness.openPopupPage();
  await operationPage.evaluate(async () => {
    await chrome.storage.local.set({ 'bossReadonlyTracker.popupView.v1': {
      accountUid: 'demo-first-run', summary: { contactCount: 0, messageCount: 0 },
      progress: null, hasCollectionHistory: false, verificationRequired: false,
      updatedAt: '2026-10-23T12:00:00.000Z',
    } });
  });
  const firstRunPage = await harness.openPopupPage();
  expect(await firstRunPage.evaluate(() => chrome.i18n.getUILanguage())).toBe('zh-CN');
  expect(await firstRunPage.evaluate(() => chrome.runtime.getManifest().name)).toBe('BOSS 沟通记录本地助手');
  await expect(firstRunPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(firstRunPage.locator('#language-select')).toHaveValue('zh-CN');
  await expect(firstRunPage.locator('#first-run-guide')).toBeVisible();
  await expect(firstRunPage.locator('#open-chat-page')).toHaveAttribute('href', 'https://www.zhipin.com/web/geek/chat');
  await expect(firstRunPage.locator('#open-chat-page')).toHaveAttribute('target', '_blank');
  await expect(firstRunPage.locator('#open-chat-page')).toHaveAttribute('rel', /noopener/u);
  await expect(firstRunPage.locator('#update-incremental')).toHaveText('开始首次采集');
  await expect(firstRunPage.locator('#update-incremental')).toBeEnabled();
  await expect(firstRunPage.locator('#counts')).toBeHidden();
  await expect(firstRunPage.locator('#account-card')).toBeHidden();
  await expect(firstRunPage.locator('#progress-card')).toBeHidden();
  await expect(firstRunPage.locator('#update-full')).toBeHidden();
  await expect(firstRunPage.locator('#stop')).toBeHidden();
  await expect(firstRunPage.locator('#export-actions')).toBeHidden();
  await expect(firstRunPage.locator('#record-tools')).toBeHidden();
  const firstRunShot = testInfo.outputPath('first-run.png');
  await firstRunPage.locator('main').screenshot({ path: firstRunShot });
  await testInfo.attach('first-run', { path: firstRunShot, contentType: 'image/png' });
  await firstRunPage.close();

  await seedBothAccounts(operationPage);
  await extensionPageOperation(operationPage, 'get-state', { accountUid: accountA });
  const recordsPage = await harness.openPopupPage();
  await expect(recordsPage.locator('#first-run-guide')).toBeHidden();
  await expect(recordsPage.locator('#counts')).toBeVisible();
  await expect(recordsPage.locator('#update-incremental')).toHaveText('更新变化会话');
  await expect(recordsPage.locator('#export-actions')).toBeVisible();
  const recordsShot = testInfo.outputPath('existing-records.png');
  await recordsPage.locator('main').screenshot({ path: recordsShot });
  await testInfo.attach('existing-records', { path: recordsShot, contentType: 'image/png' });
  expect(harness.externalRequests).toEqual([]);
});

test('an English browser starts in English and a manual choice survives popup and browser restarts', async ({}, testInfo) => {
  await restartWithBrowserLocale('en-US');
  await cachePopupView(emptyPopupView());
  const page = await harness.openPopupPage();
  expect(await page.evaluate(() => chrome.i18n.getUILanguage())).toBe('en-US');
  expect(await page.evaluate(() => chrome.runtime.getManifest().name)).toBe('BOSS Chat Recorder · 沟通记录');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-select')).toHaveValue('en');
  await expect(page.locator('#language-select option')).toHaveText(['中文', 'English']);
  await expect(page.locator('#first-run-guide')).toBeVisible();
  await expect(page.locator('#update-incremental')).toHaveText('Start first collection');
  await expect(page.locator('#open-chat-page')).toHaveAttribute('href', 'https://www.zhipin.com/web/geek/chat');
  const englishShot = testInfo.outputPath('first-run-english.png');
  await page.locator('main').screenshot({ path: englishShot });
  await testInfo.attach('first-run-english', { path: englishShot, contentType: 'image/png' });

  await seedBothAccounts(page);
  await extensionPageOperation(page, 'get-state', { accountUid: accountA });
  await page.locator('#refresh').click();
  await expect(page.locator('#update-incremental')).toHaveText('Update changed conversations');
  const before = await extensionPageOperation(page, 'exports', { accountUids: [accountA, accountB] });
  const cacheBefore = await extensionPageOperation(page, 'popup-cache');
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__languageRuntimeCalls = [];
    chrome.runtime.sendMessage = (...args) => {
      globalThis.__languageRuntimeCalls.push(args[0]?.type || 'unknown');
      return original(...args);
    };
  });
  await page.locator('#language-select').selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#update-incremental')).toHaveText('更新变化会话');
  // The local popup preference does not change Chrome's own extension metadata language.
  expect(await page.evaluate(() => chrome.runtime.getManifest().name)).toBe('BOSS Chat Recorder · 沟通记录');
  await expect(page.locator('#account')).toHaveText(accountA);
  await expect(page.locator('#message-count')).toHaveText('4');
  expect(await page.evaluate(() => globalThis.__languageRuntimeCalls)).toEqual([]);
  expect(await extensionPageOperation(page, 'popup-cache')).toEqual(cacheBefore);
  const after = await extensionPageOperation(page, 'exports', { accountUids: [accountA, accountB] });
  for (const accountUid of [accountA, accountB]) {
    expect(after[accountUid].analysisInput.conversations).toEqual(before[accountUid].analysisInput.conversations);
  }
  expect(JSON.stringify(after[accountA].analysisInput)).toContain('谢谢介绍，我想进一步了解岗位内容。');
  expect(JSON.stringify(after[accountB].analysisInput)).toContain('您好，我可以补充项目经验。');
  await expect.poll(() => page.evaluate(async key => (await chrome.storage.local.get(key))[key],
    languagePreferenceKey)).toBe('zh-CN');

  await page.close();
  const reopened = await harness.openPopupPage();
  await expect(reopened.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(reopened.locator('#language-select')).toHaveValue('zh-CN');
  await expect(reopened.locator('#update-incremental')).toHaveText('更新变化会话');
  await reopened.close();

  await restartWithBrowserLocale('en-US');
  const coldPage = await harness.openPopupPage();
  expect(await coldPage.evaluate(() => chrome.i18n.getUILanguage())).toBe('en-US');
  await expect(coldPage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(coldPage.locator('#language-select')).toHaveValue('zh-CN');
  await expect(coldPage.locator('#account')).toHaveText(accountA);
  await expect(coldPage.locator('#message-count')).toHaveText('4');
  await expect(coldPage.locator('#update-incremental')).toHaveText('更新变化会话');
  expect(harness.externalRequests).toEqual([]);
});

test('non-Chinese browsers use English while a Traditional Chinese browser uses Chinese', async () => {
  await restartWithBrowserLocale('fr-FR');
  await cachePopupView(emptyPopupView());
  const page = await harness.openPopupPage();
  expect(await page.evaluate(() => chrome.i18n.getUILanguage())).toBe('fr-FR');
  expect(await page.evaluate(() => chrome.runtime.getManifest().name)).toBe('BOSS Chat Recorder · 沟通记录');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-select')).toHaveValue('en');
  await expect(page.locator('#update-incremental')).toHaveText('Start first collection');
  await page.close();

  await restartWithBrowserLocale('zh-TW');
  const traditionalChinesePage = await harness.openPopupPage();
  expect(await traditionalChinesePage.evaluate(() => chrome.i18n.getUILanguage())).toBe('zh-TW');
  expect(await traditionalChinesePage.evaluate(() => chrome.runtime.getManifest().name))
    .toBe('BOSS 沟通记录本地助手');
  await expect(traditionalChinesePage.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(traditionalChinesePage.locator('#language-select')).toHaveValue('zh-CN');
  await expect(traditionalChinesePage.locator('#update-incremental')).toHaveText('开始首次采集');
  expect(harness.externalRequests).toEqual([]);
});

test('rapid language choices persist after popup close with the first native write acknowledgement artificially delayed', async ({}, testInfo) => {
  await cachePopupView(emptyPopupView());
  const page = await harness.openPopupPage();
  await expect(page.locator('#language-select')).toHaveValue('zh-CN');
  const witness = await page.evaluate(async key => {
    const nativeSet = chrome.storage.local.set.bind(chrome.storage.local);
    const acceptedWrites = [];
    let firstNativeCommitted;
    const committed = new Promise(resolve => { firstNativeCommitted = resolve; });
    chrome.storage.local.set = items => {
      const nativeResult = nativeSet(items);
      if (!Object.hasOwn(items, key)) return nativeResult;
      acceptedWrites.push(items[key]);
      if (acceptedWrites.length !== 1) return nativeResult;
      // The native write still commits. Only its returned acknowledgement is held, so this
      // deterministically exercises close-before-callback without simulating failed disk IO.
      nativeResult.then(firstNativeCommitted);
      return nativeResult.then(() => new Promise(() => {}));
    };
    const selector = document.querySelector('#language-select');
    for (const language of ['en', 'zh-CN']) {
      selector.value = language;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await committed;
    return { acceptedWrites, displayedLanguage: document.documentElement.lang };
  }, languagePreferenceKey);
  await testInfo.attach('language-close-delayed-acknowledgement', {
    body: Buffer.from(JSON.stringify(witness, null, 2)), contentType: 'application/json',
  });
  await page.close();
  const worker = await getExtensionWorker(harness.context, harness.extensionId);
  await expect.poll(() => worker.evaluate(async key => (await chrome.storage.local.get(key))[key],
    languagePreferenceKey)).toBe('zh-CN');
  const reopened = await harness.openPopupPage();
  await expect(reopened.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(reopened.locator('#language-select')).toHaveValue('zh-CN');
  expect(witness).toEqual({ acceptedWrites: ['en', 'zh-CN'], displayedLanguage: 'zh-CN' });
  expect(harness.externalRequests).toEqual([]);
});

test('switching language rerenders running progress and known errors without changing collection state', async () => {
  const view = {
    accountUid: accountA, summary: { contactCount: 2, messageCount: 4 },
    hasCollectionHistory: true, verificationRequired: false,
    progress: { state: 'running', active: true, finalizing: false, completed: 3,
      discovered: 10, refreshed: 2, skipped: 1, failed: 0, newMessageCount: 4 },
    updatedAt: '2026-10-23T12:00:00.000Z',
  };
  await cachePopupView(view);
  const page = await harness.openPopupPage();
  await expect(page.locator('#progress')).toContainText('正在更新');
  await expect(page.locator('#progress')).toContainText('3/10');
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#update-incremental')).toBeDisabled();
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__languageRuntimeCalls = [];
    chrome.runtime.sendMessage = (...args) => {
      globalThis.__languageRuntimeCalls.push(args[0]?.type || 'unknown');
      return original(...args);
    };
  });
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#progress')).toContainText('Updating');
  await expect(page.locator('#progress')).toContainText('3/10');
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#update-incremental')).toBeDisabled();
  expect(await page.evaluate(() => globalThis.__languageRuntimeCalls)).toEqual([]);
  expect(await extensionPageOperation(page, 'popup-cache')).toEqual(view);

  const failedView = { ...view, progress: { ...view.progress, state: 'interrupted', active: false,
    errorCode: 'ARCHIVE_DECRYPT_FAILED' } };
  await cachePopupView(failedView);
  await page.locator('#refresh').click();
  await expect(page.locator('#status')).toContainText(/decrypt/iu);
  await expect(page.locator('#update-incremental')).toHaveText('Resume collection');
  await expect(page.locator('#update-incremental')).toBeEnabled();
  await expect(page.locator('#stop')).toBeHidden();
  const callsBeforeSwitch = await page.evaluate(() => [...globalThis.__languageRuntimeCalls]);
  await page.locator('#language-select').selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#status')).toHaveText('本地归档解密失败，原记录未改动。');
  await expect(page.locator('#update-incremental')).toHaveText('继续上次采集');
  await expect(page.locator('#progress')).toContainText('3/10');
  expect(await page.evaluate(() => globalThis.__languageRuntimeCalls)).toEqual(callsBeforeSwitch);
  expect(await extensionPageOperation(page, 'popup-cache')).toEqual(failedView);
  expect(harness.externalRequests).toEqual([]);
});

test('the public archive is encrypted in native storage and the popup reads the real cached account view', async () => {
  const operationPage = await harness.openPopupPage();
  const initialViews = await seedBothAccounts(operationPage);
  expect(initialViews[accountA].summary.contactCount).toBe(2);
  expect(initialViews[accountA].summary.messageCount).toBe(4);
  expect(initialViews[accountB].summary.contactCount).toBe(2);
  expect(initialViews[accountB].summary.messageCount).toBe(3);

  const stored = await extensionPageOperation(operationPage, 'storage-inspection');
  expect(stored.protectedKeyCount).toBeGreaterThan(0);
  expect(stored.allProtectedKeysEncrypted).toBe(true);
  expect(stored.plaintextMarkerPresent).toBe(false);
  expect(stored.keyPresent).toBe(true);
  expect(stored.keyExtractable).toBe(false);
  expect(stored.keyAlgorithm).toBe('AES-GCM');
  expect(stored.keyUsages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));

  await openAndCheckPopup(operationPage, accountA, 2, 4);
  await openAndCheckPopup(operationPage, accountB, 2, 3);

  expect(harness.externalRequests).toEqual([]);
});

test('exports and clearing preserve the same HR and MID in separate synthetic account partitions', async () => {
  const operationPage = await harness.openPopupPage();
  await seedBothAccounts(operationPage);
  const exports = await extensionPageOperation(operationPage, 'exports', { accountUids: [accountA, accountB] });
  const exportA = exports[accountA].analysisInput;
  const exportB = exports[accountB].analysisInput;
  const messagesA = exportA.conversations.flatMap(conversation => conversation.messages);
  const messagesB = exportB.conversations.flatMap(conversation => conversation.messages);
  expect(messagesA).toHaveLength(4);
  expect(messagesB).toHaveLength(3);
  expect(messagesA.map(message => message.messageId)).toContain('demo-message-shared');
  expect(messagesB.map(message => message.messageId)).toContain('demo-message-shared');
  expect(JSON.stringify(exportA)).toContain('谢谢介绍，我想进一步了解岗位内容。');
  expect(JSON.stringify(exportB)).toContain('您好，我可以补充项目经验。');
  expect(JSON.stringify(exportA)).not.toContain('您好，我可以补充项目经验。');
  expect(JSON.stringify(exportB)).not.toContain('谢谢介绍，我想进一步了解岗位内容。');

  const cleared = await extensionPageOperation(operationPage, 'clear', {
    accountUid: accountA,
    remainingAccountUid: accountB,
  });
  expect(cleared.result.accountUid).toBe(accountA);
  expect(cleared.result.removed).toBe(true);
  expect(cleared.removed).toBe(true);
  expect(cleared.remainingSummary.messageCount).toBe(3);
  expect(cleared.remainingExport.analysisInput.conversations.flatMap(item => item.messages)).toHaveLength(3);
  expect(JSON.stringify(cleared.remainingExport.analysisInput)).toContain('您好，我可以补充项目经验。');
  expect(JSON.stringify(cleared.remainingExport.analysisInput)).not.toContain('谢谢介绍，我想进一步了解岗位内容。');
  expect(harness.externalRequests).toEqual([]);
});

test('the same synthetic archive survives a real worker stop and a cold profile restart', async () => {
  const operationPage = await harness.openPopupPage();
  await seedBothAccounts(operationPage);
  const extensionUrl = `chrome-extension://${harness.extensionId}/service-worker.js`;
  const firstWorker = await getExtensionWorker(harness.context, harness.extensionId);
  expect(firstWorker.url()).toBe(extensionUrl);
  await firstWorker.evaluate(() => {
    globalThis.__browserTestWorkerInstance = 'before-stop';
  });

  const cdp = await harness.context.newCDPSession(operationPage);
  const controller = await waitForServiceWorkerVersion(cdp, harness.extensionId,
    version => version.runningStatus === 'running');
  const initialVersion = controller.version;
  await cdp.send('ServiceWorker.stopWorker', { versionId: initialVersion.versionId });
  await controller.waitFor(version => version.versionId === initialVersion.versionId &&
    version.runningStatus === 'stopped');

  const wakeResponse = await operationPage.evaluate(async () => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATE', expectedAccountUid: 'demo-account-a' }, response => {
      resolve(response || (chrome.runtime.lastError ? { error: 'NO_RESPONSE' } : null));
    });
  }));
  expect(wakeResponse).toMatchObject({ ok: false, error: 'UNTRUSTED_EXTENSION_UI_SENDER' });
  const restartedWorker = await getExtensionWorker(harness.context, harness.extensionId);
  expect(await restartedWorker.evaluate(() => globalThis.__browserTestWorkerInstance ?? null)).toBeNull();
  const afterWorkerStop = await extensionPageOperation(operationPage, 'read-after-restart', { accountUid: accountA });
  expect(afterWorkerStop.summary.contactCount).toBe(2);
  expect(afterWorkerStop.summary.messageCount).toBe(4);
  expect(afterWorkerStop.export.analysisInput.conversations.flatMap(item => item.messages)).toHaveLength(4);
  controller.dispose();
  await cdp.detach();
  await operationPage.close();

  await harness.closeContextForRestart();
  const coldWorker = await harness.startContext();
  const coldPage = await harness.openPopupPage();
  const afterColdRestartA = await extensionPageOperation(coldPage, 'read-after-restart', { accountUid: accountA });
  const afterColdRestartB = await extensionPageOperation(coldPage, 'read-after-restart', { accountUid: accountB });
  expect(afterColdRestartA.summary.messageCount).toBe(4);
  expect(afterColdRestartA.export.analysisInput.conversations.flatMap(item => item.messages)).toHaveLength(4);
  expect(JSON.stringify(afterColdRestartA.export.analysisInput)).toContain('谢谢介绍，我想进一步了解岗位内容。');
  expect(JSON.stringify(afterColdRestartB.export.analysisInput)).toContain('您好，我可以补充项目经验。');
  expect(JSON.stringify(afterColdRestartA.export.analysisInput)).not.toContain('您好，我可以补充项目经验。');
  expect(JSON.stringify(afterColdRestartB.export.analysisInput)).not.toContain('谢谢介绍，我想进一步了解岗位内容。');
  expect(harness.externalRequests).toEqual([]);

  await openAndCheckPopup(coldPage, accountA, 2, 4);
});
