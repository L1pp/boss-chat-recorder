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
let harness;

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
