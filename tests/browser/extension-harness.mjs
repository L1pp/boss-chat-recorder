import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { runtimeFiles } from '../../scripts/package-extension.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tempPrefix = 'boss-public-chromium-';
const extensionPopupPath = 'popup.html';

async function copyPackagedRuntime(destination) {
  const source = join(repositoryRoot, 'extension-tracker');
  for (const name of runtimeFiles) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, name), target);
  }
}

function extensionIdFromWorker(worker) {
  const match = /^chrome-extension:\/\/([a-p]{32})\//u.exec(worker.url());
  return match?.[1] || null;
}

export async function getExtensionWorker(context, extensionId) {
  const isExtensionWorker = worker => extensionId
    ? worker.url().startsWith(`chrome-extension://${extensionId}/service-worker.js`)
    : /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/u.test(worker.url());
  const matches = () => context.serviceWorkers().find(isExtensionWorker);
  const current = matches();
  if (current) return current;
  return context.waitForEvent('serviceworker', { predicate: isExtensionWorker });
}

async function launchOfflineExtension(profilePath, extensionPath, externalRequests) {
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 480, height: 760 },
    acceptDownloads: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  await context.setOffline(true);
  await context.route(/^https?:\/\//u, async route => {
    externalRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  return context;
}

export async function createExtensionHarness(testInfo) {
  const tempRoot = await mkdtemp(join(tmpdir(), tempPrefix));
  let harness;
  try {
  const extensionPath = join(tempRoot, 'extension');
  const profilePath = join(tempRoot, 'profile');
  await mkdir(profilePath, { recursive: true });
  await copyPackagedRuntime(extensionPath);

  harness = {
    tempRoot,
    extensionPath,
    profilePath,
    testInfo,
    contexts: [],
    pages: new Set(),
    externalRequests: [],
    context: null,
    extensionId: null,

    async startContext() {
      this.context = await launchOfflineExtension(this.profilePath, this.extensionPath, this.externalRequests);
      this.contexts.push(this.context);
      this.context.on('page', page => this.pages.add(page));
      const worker = await getExtensionWorker(this.context, this.extensionId);
      const discoveredId = extensionIdFromWorker(worker);
      if (!discoveredId) throw new Error('EXTENSION_ID_UNAVAILABLE');
      if (this.extensionId && discoveredId !== this.extensionId) throw new Error('EXTENSION_ID_CHANGED_ON_RESTART');
      this.extensionId = discoveredId;
      return worker;
    },

    async closeContextForRestart() {
      if (!this.context) return;
      const current = this.context;
      this.context = null;
      await current.close();
    },

    async openPopupPage() {
      const page = await this.context.newPage();
      this.pages.add(page);
      await page.goto(`chrome-extension://${this.extensionId}/${extensionPopupPath}`);
      return page;
    },

    async finish() {
      const failed = this.testInfo.status !== this.testInfo.expectedStatus;
      try {
        if (failed) {
          let screenshotIndex = 0;
          for (const page of this.pages) {
            if (page.isClosed()) continue;
            const path = this.testInfo.outputPath(`browser-failure-${++screenshotIndex}.png`);
            try { await page.screenshot({ path, fullPage: true }); } catch { continue; }
            await this.testInfo.attach(`browser-failure-${screenshotIndex}`, {
              path, contentType: 'image/png',
            });
          }
        }
        if (this.context) {
          await this.closeContextForRestart().catch(async () => {
            const current = this.context;
            this.context = null;
            await current?.close().catch(() => {});
          });
        }
      } finally {
        for (const context of this.contexts) await context.close().catch(() => {});
        await removeTemporaryWorkspace(this.tempRoot);
        this.contexts.length = 0;
        this.pages.clear();
      }
    },
  };

    await harness.startContext();
    return harness;
  } catch (error) {
    for (const context of harness?.contexts || []) await context.close().catch(() => {});
    await removeTemporaryWorkspace(tempRoot);
    throw error;
  }
}

export async function removeTemporaryWorkspace(path) {
  const tempParent = await realpath(tmpdir());
  const actualPath = await realpath(path);
  const relativePath = relative(tempParent, actualPath);
  const isWithinTempParent = relativePath !== '' && relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  if (dirname(actualPath).toLowerCase() !== tempParent.toLowerCase() ||
      !isWithinTempParent || !basename(actualPath).startsWith(tempPrefix)) {
    throw new Error('TEMPORARY_WORKSPACE_PATH_CHECK_FAILED');
  }
  await rm(actualPath, { recursive: true, force: true });
}

export async function waitForServiceWorkerVersion(session, extensionId, predicate) {
  const versions = new Map();
  const waiters = new Set();
  const update = event => {
    for (const version of event.versions || []) {
      if (version.scriptURL === `chrome-extension://${extensionId}/service-worker.js`) {
        versions.set(String(version.versionId), version);
        for (const waiter of waiters) {
          if (waiter(version)) waiters.delete(waiter);
        }
      }
    }
  };
  session.on('ServiceWorker.workerVersionUpdated', update);
  await session.send('ServiceWorker.enable');
  const waitFor = condition => {
    const match = [...versions.values()].find(condition);
    if (match) return Promise.resolve(match);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('SERVICE_WORKER_VERSION_UNAVAILABLE'));
      }, 15_000);
      const check = version => {
        if (!condition(version)) return false;
        clearTimeout(timeout);
        resolve(version);
        return true;
      };
      waiters.add(check);
    });
  };
  try {
    const version = await waitFor(predicate);
    return { version, waitFor, dispose: () => session.off('ServiceWorker.workerVersionUpdated', update) };
  } catch (error) {
    session.off('ServiceWorker.workerVersionUpdated', update);
    throw error;
  }
}

export async function extensionPageOperation(page, operation, payload = {}) {
  return page.evaluate(async ({ operation, payload }) => {
    const extensionUrl = path => chrome.runtime.getURL(path);
    const [archiveModule, storeModule, aiInputModule, encryptionModule] = await Promise.all([
      import(extensionUrl('archive-key.mjs')),
      import(extensionUrl('account-store.mjs')),
      import(extensionUrl('ai-input.mjs')),
      import(extensionUrl('encrypted-storage.mjs')),
    ]);
    const encryptedStorage = archiveModule.createProtectedAccountStorage(chrome);
    const store = storeModule.createAccountStore(chrome, { storage: encryptedStorage });
    const popupViewKey = 'bossReadonlyTracker.popupView.v1';

    async function exportAccount(accountUid) {
      const partition = await store.getAccount(accountUid);
      if (!partition) return null;
      const analysisInput = aiInputModule.createAiAnalysisInput(partition.state, {
        scope: 'all', runtime: partition.runtime,
      });
      return { ok: true, accountUid, analysisInput: { ...analysisInput, accountUid } };
    }

    if (operation === 'seed') {
      for (const [accountUid, state] of Object.entries(payload.accounts)) {
        await store.updateAccount(accountUid, partition => {
          partition.state = state;
          return true;
        });
        await store.prepareAccountBody(accountUid);
      }
      return Object.fromEntries(await Promise.all(Object.keys(payload.accounts).map(async accountUid => {
        const partition = await store.getAccount(accountUid);
        const view = { accountUid, summary: partition.summary, progress: null,
          verificationRequired: false, updatedAt: new Date().toISOString() };
        await chrome.storage.local.set({ [popupViewKey]: view });
        return [accountUid, { summary: partition.summary, view }];
      })));
    }

    if (operation === 'exports') {
      const values = {};
      for (const accountUid of payload.accountUids) {
        values[accountUid] = await exportAccount(accountUid);
      }
      return values;
    }

    if (operation === 'clear') {
      const result = await store.clearAccount(payload.accountUid);
      const remaining = await store.getAccount(payload.remainingAccountUid);
      const removed = await store.getAccount(payload.accountUid);
      const remainingExport = await exportAccount(payload.remainingAccountUid);
      return { result, removed: removed === null, remainingSummary: remaining?.summary || null, remainingExport };
    }

    if (operation === 'storage-inspection') {
      const raw = await chrome.storage.local.get(null);
      const protectedKeys = Object.keys(raw).filter(encryptionModule.isProtectedArchiveKey);
      const envelopes = protectedKeys.map(key => raw[key]);
      const keyEntry = await new Promise((resolve, reject) => {
        let request;
        try { request = indexedDB.open('bossReadonlyTracker.archiveKey.v1', 1); }
        catch (error) { reject(error); return; }
        request.onerror = () => reject(request.error || new Error('ARCHIVE_KEY_DATABASE_FAILED'));
        request.onsuccess = () => {
          const database = request.result;
          let transaction;
          try { transaction = database.transaction('keys', 'readonly'); }
          catch (error) { database.close(); reject(error); return; }
          const get = transaction.objectStore('keys').get('archive');
          get.onerror = () => { database.close(); reject(get.error || new Error('ARCHIVE_KEY_READ_FAILED')); };
          get.onsuccess = () => {
            const value = get.result;
            database.close();
            resolve(value || null);
          };
        };
      });
      return {
        protectedKeyCount: protectedKeys.length,
        allProtectedKeysEncrypted: protectedKeys.length > 0 && envelopes.every(value =>
          value && value.__bossArchiveEncrypted === 1 && typeof value.keyId === 'string' &&
          typeof value.iv === 'string' && typeof value.ciphertext === 'string'),
        plaintextMarkerPresent: Object.values(raw).some(value =>
          ['欢迎了解示例', '您好，我可以补充项目经验。'].some(marker => JSON.stringify(value).includes(marker))),
        keyPresent: Boolean(keyEntry?.key),
        keyExtractable: keyEntry?.key?.extractable ?? null,
        keyAlgorithm: keyEntry?.key?.algorithm?.name ?? null,
        keyUsages: keyEntry?.key?.usages || [],
      };
    }

    if (operation === 'get-state') {
      const partition = await store.getAccount(payload.accountUid);
      if (!partition) return { ok: false, error: 'ACCOUNT_PARTITION_MISSING' };
      const view = { accountUid: payload.accountUid, summary: partition.summary,
        progress: null, verificationRequired: false, updatedAt: new Date().toISOString() };
      await chrome.storage.local.set({ [popupViewKey]: view });
      return { ok: true, ...view };
    }

    if (operation === 'popup-cache') {
      const cached = await chrome.storage.local.get(popupViewKey);
      return cached[popupViewKey] || null;
    }

    if (operation === 'read-after-restart') {
      const partition = await store.getAccount(payload.accountUid);
      const result = await exportAccount(payload.accountUid);
      return { summary: partition?.summary || null, export: result };
    }

    throw new Error(`UNKNOWN_BROWSER_TEST_OPERATION:${operation}`);
  }, { operation, payload });
}
