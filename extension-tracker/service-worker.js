import { registerPublicRuntime } from './public-runtime.mjs';
import { createProtectedAccountStorage } from './archive-key.mjs';
import {
  exportWalk,
  canonicalIdentityKey,
  isSupportedChatUrl,
  mergeSnapshot,
  summarizeState,
} from './model.mjs';
import { createAiAnalysisInput } from './ai-input.mjs';
import { createStoragePortServer } from './storage-port-server.mjs';
import {
  ACCOUNT_STORE_KEY,
  ACCOUNT_RUNTIME_KEY,
  createAccountStore,
  normalizeAccountUid,
} from './account-store.mjs';

export const POPUP_VIEW_KEY = 'bossReadonlyTracker.popupView.v1';
export const SITE_REQUEST_SLOT_KEY = 'bossReadonlyTracker.siteRequestSlot.v1';
const DEFAULT_SITE_REQUEST_INTERVAL_MS = 10_000;
const allowedSiteRequestPaths = new Set([
  '/wapi/zpuser/wap/getUserInfo.json',
  '/wapi/zprelation/friend/geekFilterByLabel',
  '/wapi/zpchat/geek/historyMsg',
]);
const validTabId = tabId => Number.isSafeInteger(tabId) && tabId >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminalProgressStates = new Set(['completed', 'interrupted', 'failed', 'stopped']);

function progressState(progress) {
  return progress?.status || progress?.state || '';
}

function terminalProgress(progress) {
  return terminalProgressStates.has(progressState(progress));
}

function finalizedProgress(progress) {
  return terminalProgress(progress) && progress?.active !== true && Boolean(progress?.finishedAt) &&
    progress?.finalizing !== true;
}

function activeProgress(progress) {
  return progressState(progress) === 'running' || progress?.active === true || progress?.finalizing === true;
}

function progressRequiresVerification(progress) {
  return terminalProgress(progress) && progress?.errorCode === 'SITE_VERIFICATION_REQUIRED';
}

function verificationRequiredFor(partition, accountUid, progress) {
  const legacy = partition?.runtime?.verificationRequired;
  return progressRequiresVerification(progress) ||
    (object(legacy) && legacy.required === true && legacy.accountUid === accountUid);
}

function extensionUiSender(sender, extensionId) {
  if (sender?.id !== extensionId || Number.isSafeInteger(sender?.tab?.id) || !sender?.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId;
  } catch {
    return false;
  }
}

function trustedCollectorSender(sender, extensionId) {
  if (sender?.id !== extensionId || !validTabId(sender?.tab?.id)) return false;
  const documentUrl = sender.url || sender.tab?.url;
  return isSupportedChatUrl(documentUrl) &&
    (!sender.tab?.url || isSupportedChatUrl(sender.tab.url));
}

function sameChatPage(left, right) {
  try {
    const a = new URL(left), b = new URL(right);
    return a.protocol === 'https:' && b.protocol === 'https:' &&
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      a.pathname.replace(/\/+$/u, '') === b.pathname.replace(/\/+$/u, '') &&
      isSupportedChatUrl(a.href) && isSupportedChatUrl(b.href);
  } catch {
    return false;
  }
}

function errorPayload(error) {
  const message = error?.message || 'EXTENSION_RUNTIME_ERROR';
  const code = error?.code || message.split(':', 1)[0] || 'EXTENSION_RUNTIME_ERROR';
  return { ok: false, error: code, message };
}

function appendLog(runtime, event, details = {}) {
  runtime.logs ||= [];
  runtime.logs.push({ at: new Date().toISOString(), event, ...details });
  runtime.logs = runtime.logs.slice(-1000);
}

function serialQueue() {
  let tail = Promise.resolve();
  return task => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

async function pageReadAccount() {
  const reader = globalThis.__bossAccountReader;
  if (!reader || typeof reader.read !== 'function') return { ok: false, error: 'ACCOUNT_READER_NOT_LOADED' };
  try { return { ok: true, value: await reader.read() }; }
  catch (error) {
    // Chrome may serialize an injected exception without its custom `code` field.
    // Return only a safe code, never response HTML or exception details.
    return { ok: false, error: error?.code === 'SITE_VERIFICATION_REQUIRED'
      ? 'SITE_VERIFICATION_REQUIRED' : 'ACCOUNT_IDENTITY_UNAVAILABLE' };
  }
}

function pageStartCollection(options) {
  const start = globalThis.__bossStartCollection;
  if (typeof start !== 'function') throw new Error('BULK_COLLECTOR_NOT_LOADED');
  return start(options);
}

function pageCollectorStatus() {
  const collector = globalThis.__bossBulkCollector;
  return collector && typeof collector.status === 'function' ? collector.status() : null;
}

function pageStopCollectionBound(accountUid, collectionToken) {
  const collector = globalThis.__bossBulkCollector;
  if (!collector || typeof collector.status !== 'function') return null;
  const current = collector.status();
  if (current?.accountUid !== accountUid || current?.collectionToken !== collectionToken) return null;
  if (typeof collector.stop !== 'function') return current;
  const result = collector.stop();
  if (result && typeof result.then === 'function') result.catch(() => {});
  return collector.status();
}

function randomCollectionToken() {
  const token = globalThis.crypto?.randomUUID?.();
  if (typeof token !== 'string' || token.length < 8) throw new Error('SECURE_RANDOM_UNAVAILABLE');
  return token;
}

function latestProgress(partition) {
  if (!object(partition)) return null;
  const values = Object.values(partition.runtime.progressByTab || {}).filter(progress => progress?.kind === 'api_v1');
  if (partition.baseline.previousProgress?.kind === 'api_v1') values.push(partition.baseline.previousProgress);
  return values.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

export function createExtensionMessageHandler(chromeApi = globalThis.chrome, {
  requestIntervalMs = DEFAULT_SITE_REQUEST_INTERVAL_MS,
  now = () => Date.now(),
  diagnostics = null,
  onStorageActivity = null,
  accountStorage = null,
} = {}) {
  if (!chromeApi?.storage?.local || !chromeApi?.runtime?.id || !chromeApi?.scripting?.executeScript) {
    throw new Error('CHROME_EXTENSION_API_REQUIRED');
  }
  const accounts = createAccountStore(chromeApi, { storage: accountStorage, onStorageEvent: diagnostics || onStorageActivity
    ? (event, details) => {
      diagnostics?.record(`storage.${event}`, details);
      onStorageActivity?.();
    } : undefined });
  const controlQueue = serialQueue();
  const popupViewQueue = serialQueue();
  const requestSlotQueue = serialQueue();
  const pendingStartTokens = new Set();
  let fallbackNextRequestAt = 0;

  async function diagnosticOperation(operation, task) {
    const finish = diagnostics?.begin(operation);
    try {
      const result = await task();
      finish?.({ ok: true });
      return result;
    } catch (error) {
      finish?.({ ok: false, errorCode: 'LOCAL_API_ERROR' });
      throw error;
    }
  }

  async function getTab(tabId) {
    if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); }
    catch { throw new Error('TAB_NOT_AVAILABLE'); }
    if (!isSupportedChatUrl(tab?.url)) throw new Error('UNSUPPORTED_PAGE');
    return tab;
  }

  async function executePage(tabId, func, args = []) {
    const results = await chromeApi.scripting.executeScript({ target: { tabId }, func, args });
    return results?.[0]?.result ?? null;
  }

  async function readFreshAccount(tabId) {
    await getTab(tabId);
    await chromeApi.scripting.executeScript({ target: { tabId }, files: ['content/account.bundle.js'] });
    let result;
    try { result = await executePage(tabId, pageReadAccount); }
    catch (error) {
      const code = error?.code || (String(error?.message || '').match(/SITE_VERIFICATION_REQUIRED/u)?.[0]);
      if (code === 'SITE_VERIFICATION_REQUIRED') throw new Error(code);
      throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
    }
    if (object(result) && result.ok === false) {
      if (result.error === 'SITE_VERIFICATION_REQUIRED') throw new Error('SITE_VERIFICATION_REQUIRED');
      throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
    }
    if (object(result) && result.ok === true && Object.hasOwn(result, 'value')) result = result.value;
    const accountUid = normalizeAccountUid(result?.uid);
    if (!accountUid) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE');
    const tab = await getTab(tabId);
    return { tab, accountUid };
  }

  async function syncVerificationBadge(tabId, accountUid, partition) {
    if (!chromeApi.action?.setBadgeText) return;
    try {
      const progress = validTabId(tabId)
        ? partition?.runtime?.progressByTab?.[String(tabId)] || latestProgress(partition)
        : latestProgress(partition);
      const required = verificationRequiredFor(partition, accountUid, progress);
      await diagnosticOperation('badge.setText', () =>
        chromeApi.action.setBadgeText({ tabId, text: required ? '验' : '' }));
      if (chromeApi.action.setTitle) {
        const title = required ? 'BOSS 要求人工验证，采集已暂停。' :
          (chromeApi.runtime.getManifest?.().name || 'BOSS 沟通记录');
        await diagnosticOperation('badge.setTitle', () => chromeApi.action.setTitle({ tabId, title }));
      }
    } catch {
      // Badge APIs are best-effort UI hints; saved account state is authoritative.
    }
  }

  function popupProgress(progress) {
    if (!object(progress)) return null;
    const result = {};
    for (const key of ['runId', 'status', 'state', 'phase', 'active', 'finalizing', 'discovered',
      'scannedCount', 'selectedCount', 'completed', 'refreshedCount', 'failed', 'failedCount', 'skipped',
      'skippedUnchangedCount', 'messageCount', 'newMessageCount', 'updatedMessageCount', 'limitReached',
      'startedAt', 'updatedAt', 'finishedAt', 'errorCode']) {
      const value = progress[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    }
    if (typeof progress.error === 'string') result.error = progress.error;
    return result;
  }

  function makePopupView(accountUid, partition, tabId = null, summary = null, progressOverride = undefined) {
    const progress = progressOverride !== undefined ? progressOverride :
      (validTabId(tabId) ? partition.runtime.progressByTab[String(tabId)] : null) || latestProgress(partition);
    const verificationRequired = verificationRequiredFor(partition, accountUid, progress);
    return {
      accountUid,
      summary: summary || partition.summary || summarizeState(partition.state),
      progress: popupProgress(progress),
      verificationRequired,
      verificationRetrying: false,
      updatedAt: new Date().toISOString(),
    };
  }

  function writePopupView(view) {
    // This is a derived UI cache, not part of the account storage commit.
    void popupViewQueue(async () => {
      await diagnosticOperation('popupCache.set', () => chromeApi.storage.local.set({ [POPUP_VIEW_KEY]: view }));
    }).catch(() => {});
    return view;
  }

  async function selectPopupView(accountUid, partition, tabId = null) {
    return writePopupView(makePopupView(accountUid, partition, tabId));
  }

  function patchPopupView(accountUid, partition, tabId = null, summary = null, progressOverride = undefined) {
    void popupViewQueue(async () => {
      const stored = await diagnosticOperation('popupCache.get', () => chromeApi.storage.local.get(POPUP_VIEW_KEY));
      const current = stored?.[POPUP_VIEW_KEY];
      if (normalizeAccountUid(current?.accountUid) !== accountUid) return false;
      const view = makePopupView(accountUid, partition, tabId, summary, progressOverride);
      await diagnosticOperation('popupCache.set', () => chromeApi.storage.local.set({ [POPUP_VIEW_KEY]: view }));
      return true;
    }).catch(() => {});
  }

  function allowedRequestPath(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) return null;
    try {
      const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(endpoint);
      const url = new URL(endpoint, 'https://www.zhipin.com');
      if (absolute && (url.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(url.hostname))) return null;
      if (!absolute && url.origin !== 'https://www.zhipin.com') return null;
      return allowedSiteRequestPaths.has(url.pathname) ? url.pathname : null;
    } catch { return null; }
  }

  async function reserveSiteRequestSlot(endpoint) {
    const path = allowedRequestPath(endpoint);
    if (!path) return { ok: false, error: 'SITE_REQUEST_PATH_NOT_ALLOWED' };
    return requestSlotQueue(async () => {
      const clockNow = Number(now());
      if (!Number.isFinite(clockNow)) throw new Error('SITE_REQUEST_CLOCK_INVALID');
      const session = chromeApi.storage.session;
      let nextRequestAt = fallbackNextRequestAt;
      if (session?.get && session?.set) {
        const stored = await session.get(SITE_REQUEST_SLOT_KEY);
        const persisted = Number(stored?.[SITE_REQUEST_SLOT_KEY]?.nextRequestAt);
        if (Number.isFinite(persisted)) nextRequestAt = Math.max(nextRequestAt, persisted);
      }
      if (clockNow < nextRequestAt) return { ok: true, waitMs: Math.ceil(nextRequestAt - clockNow) };
      const next = clockNow + Math.max(0, Number(requestIntervalMs) || 0);
      if (session?.get && session?.set) {
        await session.set({ [SITE_REQUEST_SLOT_KEY]: { nextRequestAt: next, endpoint: path } });
      }
      fallbackNextRequestAt = next;
      return { ok: true, waitMs: 0 };
    });
  }

  async function writeProgress(scope, progress, event = 'bulk_progress') {
    const update = await accounts.updateBoundRuntime(scope, partition => {
      const key = String(scope.tabId);
      const existing = partition.runtime.progressByTab[key];
      if (existing?.collectionToken === scope.collectionToken && terminalProgress(existing) && !terminalProgress(progress)) {
        return { rejected: 'COLLECTION_TERMINAL', progress: existing };
      }
      if (existing?.collectionToken === scope.collectionToken && progressState(existing) === 'stopping' &&
          progressState(progress) === 'running') {
        return { rejected: 'COLLECTION_FINALIZING', progress: existing };
      }
      if (existing?.collectionToken === scope.collectionToken && existing.finalizing === true &&
          progressState(progress) === 'running' && progress.finalizing !== true) {
        return { rejected: 'COLLECTION_FINALIZING', progress: existing };
      }
      const normalized = { ...progress, tabId: scope.tabId, accountUid: scope.accountUid,
        collectionToken: scope.collectionToken, updatedAt: new Date().toISOString() };
      partition.runtime.progressByTab[key] = normalized;
      if (normalized.kind === 'api_v1') partition.baseline.previousProgress = normalized;
      appendLog(partition.runtime, event, { tabId: scope.tabId, accountUid: scope.accountUid,
        runId: normalized.runId || null, status: progressState(normalized) || null,
        phase: normalized.phase || null, discovered: normalized.discovered ?? null,
        completed: normalized.completed ?? null, failed: normalized.failed ?? null,
        messageCount: normalized.messageCount ?? null, errorCode: normalized.errorCode || null });
      return { progress: normalized };
    });
    if (!update.accepted) return { ok: false, error: update.reason };
    if (update.value?.rejected) return { ok: false, error: update.value.rejected };
    const saved = update.value?.progress || null;
    if (finalizedProgress(saved) && !pendingStartTokens.has(scope.collectionToken)) {
      await accounts.removeTabBinding(scope.tabId, {
        accountUid: scope.accountUid, collectionToken: scope.collectionToken,
      });
    }
    void syncVerificationBadge(scope.tabId, scope.accountUid, update.partition);
    patchPopupView(scope.accountUid, update.partition, scope.tabId, null, saved);
    return { ok: true, progress: saved };
  }

  async function finishBoundProgress(scope, { status = 'interrupted', errorCode = null,
    errorDetails = '', event = 'bulk_interrupted' } = {}) {
    const update = await accounts.updateBoundRuntime(scope, partition => {
      const key = String(scope.tabId);
      const existing = partition.runtime.progressByTab[key];
      if (!object(existing) || existing.collectionToken !== scope.collectionToken) return null;
      if (!activeProgress(existing) && !(status === 'stopped' && progressState(existing) === 'interrupted')) {
        return existing;
      }
      const at = new Date().toISOString();
      const details = errorDetails || (status === 'stopped' ? '本轮更新已停止。' : '本轮更新已中断。');
      const normalized = { ...existing, status, state: status, active: false, phase: status,
        errorCode, errorDetails: details, error: details, finishedAt: existing.finishedAt || at,
        finalizing: false, updatedAt: at, tabId: scope.tabId, accountUid: scope.accountUid,
        collectionToken: scope.collectionToken };
      partition.runtime.progressByTab[key] = normalized;
      if (normalized.kind === 'api_v1') partition.baseline.previousProgress = normalized;
      appendLog(partition.runtime, event, { tabId: scope.tabId, accountUid: scope.accountUid,
        runId: normalized.runId || null, status, errorCode });
      return normalized;
    });
    if (update.accepted) {
      // Once the saved token is terminal, late collector messages cannot change it.
      await accounts.removeTabBinding(scope.tabId, {
        accountUid: scope.accountUid, collectionToken: scope.collectionToken,
      });
      void syncVerificationBadge(scope.tabId, scope.accountUid, update.partition);
      patchPopupView(scope.accountUid, update.partition, scope.tabId, null, update.value);
      return update.value || null;
    }
    return null;
  }

  async function interruptBoundProgress(binding, details = '当前沟通页无法确认原登录账号，本轮更新已标记中断。') {
    if (!binding || !validTabId(binding.tabId) || !normalizeAccountUid(binding.accountUid) ||
        typeof binding.collectionToken !== 'string') return null;
    return finishBoundProgress({ tabId: binding.tabId, accountUid: binding.accountUid,
      collectionToken: binding.collectionToken }, { status: 'interrupted', errorCode: 'COLLECTOR_UNAVAILABLE',
      errorDetails: details, event: 'bulk_interrupted' });
  }

  async function markUnboundProgressInterrupted(tabId, accountUid, progress, details) {
    if (!object(progress) || !activeProgress(progress) || !progress.collectionToken) return progress || null;
    const binding = await accounts.getTabBinding(tabId);
    if (binding?.accountUid === accountUid && binding.collectionToken === progress.collectionToken) return progress;
    const at = new Date().toISOString();
    return accounts.updateRuntimeAccount(accountUid, partition => {
      const key = String(tabId);
      const current = partition.runtime.progressByTab[key];
      if (!object(current) || current.collectionToken !== progress.collectionToken || !activeProgress(current)) return current || null;
      const normalized = { ...current, status: 'interrupted', state: 'interrupted', active: false,
        phase: 'interrupted', errorCode: 'COLLECTOR_UNAVAILABLE', errorDetails: details,
        error: details, finalizing: false, finishedAt: current.finishedAt || at, updatedAt: at };
      partition.runtime.progressByTab[key] = normalized;
      if (normalized.kind === 'api_v1') partition.baseline.previousProgress = normalized;
      appendLog(partition.runtime, 'bulk_interrupted', { tabId, accountUid,
        runId: normalized.runId || null, errorCode: normalized.errorCode });
      return normalized;
    });
  }

  async function handleCollectorMessage(message, sender) {
    if (!trustedCollectorSender(sender, chromeApi.runtime.id)) return { ok: false, error: 'UNTRUSTED_COLLECTOR_SENDER' };
    const tabId = sender.tab.id;
    const accountUid = normalizeAccountUid(message.accountUid);
    const collectionToken = message.collectionToken;
    if (!accountUid || typeof collectionToken !== 'string') return { ok: false, error: 'COLLECTION_IDENTITY_REQUIRED' };
    // updateBoundAccount validates the saved UID/token atomically with the write.
    const boundScope = { tabId, accountUid, collectionToken };

    if (message.type === 'BULK_PROGRESS') {
      if (!object(message.progress)) return { ok: false, error: 'BULK_PROGRESS_INVALID' };
      return writeProgress(boundScope, message.progress);
    }

    if (message.type === 'BULK_SNAPSHOTS') {
      if (!Array.isArray(message.snapshots)) return { ok: false, error: 'BULK_SNAPSHOTS_INVALID' };
      for (const snapshot of message.snapshots) {
        if (normalizeAccountUid(snapshot?.selfUid) !== accountUid) {
          return { ok: false, error: 'SNAPSHOT_ACCOUNT_MISMATCH' };
        }
        const snapshotUrl = `${snapshot?.page?.origin || ''}${snapshot?.page?.pathname || ''}`;
        if (!sameChatPage(sender.url || sender.tab.url, snapshotUrl)) {
          return { ok: false, error: 'SNAPSHOT_PAGE_MISMATCH' };
        }
      }
      const identities = [...new Set(message.snapshots.flatMap(snapshot =>
        (Array.isArray(snapshot.list?.rows) ? snapshot.list.rows : []).map(canonicalIdentityKey).filter(Boolean)))];
      const update = await accounts.updateBoundConversations({ tabId, accountUid, collectionToken }, identities, partition => {
        let state = partition.state;
        let newMessageCount = 0, unidentifiedObservationCount = 0;
        const identityKeys = [];
        for (const snapshot of message.snapshots) {
          const merged = mergeSnapshot(state, snapshot, { sessionId: message.sessionId || null,
            receivedAt: new Date().toISOString(), copyState: false });
          if (!merged.accepted) throw new Error(merged.reason || 'SNAPSHOT_REJECTED');
          state = merged.state;
          newMessageCount += merged.newMessageCount || 0;
          unidentifiedObservationCount += merged.unidentifiedObservationCount || 0;
          if (merged.identityKey && !identityKeys.includes(merged.identityKey)) identityKeys.push(merged.identityKey);
        }
        partition.state = state;
        const status = { tabId, accountUid, state: 'saved', lastAcceptedAt: new Date().toISOString() };
        partition.runtime.sourceStatus[String(tabId)] = status;
        appendLog(partition.runtime, 'bulk_snapshots_saved', { tabId, accountUid,
          runId: message.sessionId || null, snapshotCount: message.snapshots.length,
          newMessageCount, unidentifiedObservationCount });
        return { identityKeys, newMessageCount, unidentifiedObservationCount,
          summary: summarizeState(state) };
      });
      if (!update.accepted) return { ok: false, error: update.reason };
      patchPopupView(accountUid, update.partition, tabId, update.value?.summary);
      return { ok: true, accountUid, ...update.value };
    }
    return { ok: false, error: 'UNKNOWN_COLLECTOR_MESSAGE' };
  }

  async function readPopupView() {
    const stored = await chromeApi.storage.local.get(POPUP_VIEW_KEY);
    const view = stored?.[POPUP_VIEW_KEY];
    return object(view) ? view : null;
  }

  function partitionActivityAt(partition) {
    const runtime = partition?.runtime || {};
    const timestamps = [
      partition?.updatedAt, partition?.lastUpdatedAt, partition?.createdAt,
      partition?.state?.updatedAt, partition?.state?.createdAt, partition?.summary?.updatedAt,
      ...(Array.isArray(runtime.logs) ? runtime.logs.slice(-1).map(item => item?.at) : []),
      ...Object.values(runtime.progressByTab || {}).map(item => item?.updatedAt),
      ...Object.values(partition?.state?.contacts || {}).map(item => item?.lastObservedAt),
    ];
    return timestamps.reduce((latest, value) => {
      const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, 0);
  }

  async function mostRecentLocalAccountUid() {
    const stored = await accounts.getRuntimeRoot();
    const partitions = stored.accounts;
    if (!object(partitions)) return null;
    const candidates = Object.values(partitions).filter(partition =>
      object(partition) && normalizeAccountUid(partition.accountUid));
    candidates.sort((left, right) => partitionActivityAt(right) - partitionActivityAt(left));
    return normalizeAccountUid(candidates[0]?.accountUid);
  }

  async function localUiContext(message, { usePopupView = false } = {}) {
    let accountUid;
    if (Object.hasOwn(message || {}, 'expectedAccountUid')) {
      accountUid = normalizeAccountUid(message.expectedAccountUid);
      if (!accountUid) throw new Error('EXPECTED_ACCOUNT_UID_REQUIRED');
    } else if (usePopupView) {
      accountUid = normalizeAccountUid((await readPopupView())?.accountUid);
      if (!accountUid) accountUid = await mostRecentLocalAccountUid();
      if (!accountUid) throw new Error('ACCOUNT_UID_REQUIRED');
    } else {
      throw new Error('EXPECTED_ACCOUNT_UID_REQUIRED');
    }
    return { accountUid, tabId: validTabId(message?.tabId) ? message.tabId : null };
  }

  async function freshStartMessage(message) {
    const tabId = message?.tabId;
    if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
    if (message.mode && !['incremental', 'full'].includes(message.mode)) throw new Error('UNSUPPORTED_UPDATE_MODE');

    let previousBinding = await accounts.getTabBinding(tabId);
    if (previousBinding) {
      const existingPartition = (await accounts.getRuntimeContext(previousBinding.accountUid, tabId)).partition;
      const stored = existingPartition?.runtime?.progressByTab?.[String(tabId)] || null;
      const live = await executePage(tabId, pageCollectorStatus).catch(() => null);
      const matchesBinding = normalizeAccountUid(live?.accountUid) === previousBinding.accountUid &&
        live?.collectionToken === previousBinding.collectionToken;
      if (matchesBinding && (progressState(live) === 'stopping' || live.finalizing === true ||
          stored?.finalizing === true)) {
        return { ok: false, error: 'COLLECTION_FINALIZING', accountUid: previousBinding.accountUid,
          progress: popupProgress(live) };
      }
      if (matchesBinding && activeProgress(live)) {
        await accounts.updateRuntimeAccount(previousBinding.accountUid, current => {
          if (object(current.runtime.verificationRequired)) delete current.runtime.verificationRequired;
        });
        const saved = await writeProgress({ tabId, accountUid: previousBinding.accountUid,
          collectionToken: previousBinding.collectionToken }, live);
        const current = (await accounts.getRuntimeContext(previousBinding.accountUid, tabId)).partition;
        const view = current && await selectPopupView(previousBinding.accountUid, current, tabId);
        return { ok: true, accountUid: previousBinding.accountUid, progress: saved.progress || popupProgress(live),
          summary: view?.summary || current?.summary,
          verificationRequired: Boolean(view?.verificationRequired), verificationRetrying: false,
          updatedAt: view?.updatedAt || new Date().toISOString(), view };
      }
      if (matchesBinding && terminalProgress(live)) {
        await writeProgress({ tabId, accountUid: previousBinding.accountUid,
          collectionToken: previousBinding.collectionToken }, live);
      } else if (stored && activeProgress(stored)) {
        await executePage(tabId, pageStopCollectionBound,
          [previousBinding.accountUid, previousBinding.collectionToken]).catch(() => null);
        await finishBoundProgress({ tabId, accountUid: previousBinding.accountUid,
          collectionToken: previousBinding.collectionToken }, { status: 'interrupted',
          errorCode: 'COLLECTOR_UNAVAILABLE', errorDetails: '原采集器已不再运行，本轮已标记中断。' });
      } else {
        await accounts.removeTabBinding(tabId, previousBinding);
      }
      previousBinding = await accounts.getTabBinding(tabId);
    }

    let fresh;
    try { fresh = await readFreshAccount(tabId); }
    catch (error) {
      if (previousBinding) {
        await executePage(tabId, pageStopCollectionBound,
          [previousBinding.accountUid, previousBinding.collectionToken]).catch(() => null);
        await interruptBoundProgress({ ...previousBinding, tabId },
          '当前账号无法确认，本轮更新已停止。').catch(() => null);
      }
      throw error;
    }

    const accountUid = fresh.accountUid;
    if (previousBinding && previousBinding.accountUid !== accountUid) {
      await executePage(tabId, pageStopCollectionBound,
        [previousBinding.accountUid, previousBinding.collectionToken]).catch(() => null);
      await interruptBoundProgress({ ...previousBinding, tabId },
        '检测到登录账号已切换，旧账号本轮更新已停止。').catch(() => null);
    }

    const partition = await accounts.prepareAccountBody(accountUid);
    const binding = await accounts.getTabBinding(tabId);
    await selectPopupView(accountUid, partition, tabId);
    return processUiMessage(message, { tabId, accountUid, partition, binding });
  }

  async function processUiMessage(message, context) {
    const { tabId, accountUid } = context;

    if (message.type === 'GET_STATE') {
      const { partition } = await accounts.getRuntimeContext(accountUid, tabId);
      const view = await selectPopupView(accountUid, partition, tabId);
      if (validTabId(tabId)) void syncVerificationBadge(tabId, accountUid, partition);
      return { ok: true, ...view, view };
    }

    if (message.type === 'GET_BULK_PROGRESS') {
      const local = await accounts.getRuntimeContext(accountUid, tabId);
      let partition = local.partition;
      const binding = local.binding;
      let live = null;
      if (binding?.accountUid === accountUid) {
        live = await executePage(tabId, pageCollectorStatus).catch(() => null);
        if (normalizeAccountUid(live?.accountUid) !== accountUid || live?.collectionToken !== binding.collectionToken) {
          live = null;
        }
        if (live && terminalProgress(live) && !finalizedProgress(live) && live.active !== true) {
          live = progressState(live) === 'stopped'
            ? { ...live, status: 'stopping', state: 'stopping', phase: 'stopping', active: true,
              stopRequested: true, finalizing: true }
            : { ...live, active: true, finalizing: true };
        }
        if (live && (terminalProgress(live) || progressState(live) === 'stopping')) {
          const saved = await writeProgress({ tabId, accountUid, collectionToken: binding.collectionToken }, live);
          if (!saved.ok && saved.error !== 'COLLECTION_TOKEN_REVOKED') return saved;
          partition = (await accounts.getRuntimeContext(accountUid, tabId)).partition;
          live = saved.ok ? saved.progress : null;
        } else if (!live) {
          const stored = partition.runtime.progressByTab[String(tabId)] || null;
          if (stored?.collectionToken === binding.collectionToken && activeProgress(stored)) {
            await finishBoundProgress({ tabId, accountUid, collectionToken: binding.collectionToken }, {
              status: 'interrupted', errorCode: 'COLLECTOR_UNAVAILABLE',
              errorDetails: '当前沟通页已没有本轮采集器，本轮已标记中断；可以继续更新。',
              event: 'bulk_interrupted',
            });
          } else {
            await accounts.removeTabBinding(tabId, { accountUid, collectionToken: binding.collectionToken });
          }
          partition = (await accounts.getRuntimeContext(accountUid, tabId)).partition;
        }
      } else {
        const stored = partition.runtime.progressByTab[String(tabId)] || null;
        if (activeProgress(stored)) {
          await markUnboundProgressInterrupted(tabId, accountUid, stored,
            '当前沟通页已没有与本轮更新对应的采集器，本轮已标记中断；可以继续更新。');
          partition = (await accounts.getRuntimeContext(accountUid, tabId)).partition;
        }
      }
      if (validTabId(tabId)) void syncVerificationBadge(tabId, accountUid, partition);
      const summary = partition.summary;
      const displayProgress = validTabId(tabId)
        ? live || partition.runtime.progressByTab[String(tabId)] || null : latestProgress(partition);
      patchPopupView(accountUid, partition, tabId, summary, displayProgress);
      const view = makePopupView(accountUid, partition, tabId, summary, displayProgress);
      return { ok: true, accountUid,
        progress: view.progress, summary, verificationRequired: view.verificationRequired,
        verificationRetrying: false, updatedAt: view.updatedAt, view };
    }

    if (message.type === 'START_UPDATE' || message.type === 'RESUME_AFTER_VERIFICATION') {
      if (message.mode && !['incremental', 'full'].includes(message.mode)) throw new Error('UNSUPPORTED_UPDATE_MODE');
      const mode = message.mode || 'incremental';
      const local = context.partition ? context : await accounts.getAccountContext(accountUid, tabId);
      const initial = local.partition;
      const previousBinding = local.binding;
      const previousRun = initial.runtime.progressByTab[String(tabId)] || null;
      if (previousBinding?.accountUid === accountUid &&
          (progressState(previousRun) === 'stopping' || previousRun?.finalizing === true)) {
        throw new Error('COLLECTION_FINALIZING');
      }
      if (previousBinding?.accountUid === accountUid) {
        const live = await executePage(tabId, pageCollectorStatus).catch(() => null);
        if (normalizeAccountUid(live?.accountUid) === accountUid &&
            live?.collectionToken === previousBinding.collectionToken && live?.finalizing === true) {
          throw new Error('COLLECTION_FINALIZING');
        }
      }
      if (previousBinding?.accountUid === accountUid) {
        await executePage(tabId, pageStopCollectionBound,
          [accountUid, previousBinding.collectionToken]).catch(() => null);
      }

      const latest = initial;
      const latestBinding = await accounts.getTabBinding(tabId);
      if (latestBinding?.accountUid === accountUid) {
        await executePage(tabId, pageStopCollectionBound,
          [accountUid, latestBinding.collectionToken]).catch(() => null);
      }

      const collectionToken = randomCollectionToken();
      const scope = { tabId, accountUid, collectionToken };
      pendingStartTokens.add(collectionToken);
      try {
        await accounts.setTabBinding(tabId, accountUid, collectionToken);
        const legacyPauseCleared = await accounts.updateBoundRuntime(scope, partition => {
          delete partition.runtime.verificationRequired;
          return true;
        });
        if (!legacyPauseCleared.accepted) throw new Error(legacyPauseCleared.reason);
      } catch (error) {
        await accounts.removeTabBinding(tabId, { accountUid, collectionToken }).catch(() => false);
        pendingStartTokens.delete(collectionToken);
        throw error;
      }
      let collectorInvoked = false;
      try {
        await chromeApi.scripting.executeScript({ target: { tabId }, files: ['content/bulk.bundle.js'] });
        const previous = mode === 'full' ? null : latest.baseline.previousProgress;
        const storedContacts = Object.values(latest.state.contacts || {});
        collectorInvoked = true;
        const progress = await executePage(tabId, pageStartCollection,
          [{ accountUid, collectionToken, previous, storedContacts }]);
        if (!object(progress)) throw new Error('BULK_COLLECTOR_START_FAILED');
        const saved = await accounts.updateBoundRuntime(scope, partition => {
          const existing = partition.runtime.progressByTab[String(tabId)];
          const normalized = { ...progress, tabId, accountUid, collectionToken, updatedAt: new Date().toISOString() };
          if (existing?.collectionToken === collectionToken && terminalProgress(existing) &&
              !terminalProgress(normalized)) return existing;
          partition.runtime.progressByTab[String(tabId)] = normalized;
          if (normalized.kind === 'api_v1') partition.baseline.previousProgress = normalized;
          appendLog(partition.runtime, 'bulk_started', { tabId, accountUid, mode,
            runId: normalized.runId || null });
          return normalized;
        });
        if (!saved.accepted) throw new Error(saved.reason);
        const startedProgress = saved.value;
        if (finalizedProgress(startedProgress)) {
          await accounts.removeTabBinding(tabId, { accountUid, collectionToken });
        }
        const current = saved.partition;
        void syncVerificationBadge(tabId, accountUid, current);
        patchPopupView(accountUid, current, tabId, current.summary, startedProgress);
        const view = makePopupView(accountUid, current, tabId, current.summary, startedProgress);
        return { ok: true, accountUid, progress: startedProgress, summary: current.summary,
          verificationRequired: progressRequiresVerification(startedProgress), verificationRetrying: false,
          updatedAt: new Date().toISOString(), view };
      } catch (error) {
        if (collectorInvoked) {
          await executePage(tabId, pageStopCollectionBound, [accountUid, collectionToken]).catch(() => null);
        }
        await accounts.removeTabBinding(tabId, { accountUid, collectionToken }).catch(() => false);
        throw error;
      } finally {
        pendingStartTokens.delete(collectionToken);
      }
    }

    if (message.type === 'STOP_UPDATE') {
      if (!validTabId(tabId)) throw new Error('TAB_ID_REQUIRED');
      const binding = await accounts.getTabBinding(tabId);
      if (!binding || binding.accountUid !== accountUid) throw new Error('NO_CURRENT_COLLECTION');
      const scope = { tabId, accountUid, collectionToken: binding.collectionToken };
      const pageProgress = await executePage(tabId, pageStopCollectionBound,
        [accountUid, binding.collectionToken]).catch(() => null);
      const matchesScope = object(pageProgress) && normalizeAccountUid(pageProgress.accountUid) === accountUid &&
        pageProgress.collectionToken === binding.collectionToken;
      if (matchesScope) {
        const state = progressState(pageProgress);
        const stopping = finalizedProgress(pageProgress) ? pageProgress : {
          ...pageProgress, status: 'stopping', state: 'stopping', active: true, phase: 'stopping',
          stopRequested: true, finalizing: true, errorCode: null,
          errorDetails: '已收到停止请求，正在保存停止前已读取的内容。',
          error: '已收到停止请求，正在保存停止前已读取的内容。',
        };
        const saved = await writeProgress(scope, stopping, 'bulk_stopped');
        if (!saved.ok && state !== 'completed') throw new Error(saved.error);
        return { ok: true, accountUid, progress: saved.progress || pageProgress };
      }
      const progress = await finishBoundProgress(scope, { status: 'stopped', errorCode: null,
        errorDetails: '已按用户请求停止本轮更新；当前页面无法确认采集器状态。', event: 'bulk_stopped' });
      if (!progress) throw new Error('BULK_COLLECTOR_NOT_RUNNING');
      return { ok: true, accountUid, progress };
    }

    if (message.type === 'EXPORT_AI_INPUT') {
      if (message.scope && !['all', 'latest_update'].includes(message.scope)) throw new Error('UNSUPPORTED_AI_SCOPE');
      const partition = await accounts.getOrCreateAccount(accountUid);
      const analysisInput = createAiAnalysisInput(partition.state, {
        scope: message.scope || 'latest_update',
        progress: latestProgress(partition),
        runtime: partition.runtime,
      });
      return { ok: true, accountUid, analysisInput: { ...analysisInput, accountUid } };
    }

    if (message.type === 'EXPORT_ACCOUNT_BACKUP') {
      const partition = await accounts.getOrCreateAccount(accountUid);
      const walk = exportWalk(partition.state);
      walk.accountUid = accountUid;
      walk.bulkProgress = partition.runtime.progressByTab;
      return { ok: true, accountUid, backup: walk };
    }

    if (message.type === 'CLEAR_ACCOUNT') {
      const existing = await accounts.getAccount(accountUid);
      if (existing) {
        for (const [tabKey, progress] of Object.entries(existing.runtime.progressByTab || {})) {
          const boundTabId = Number(tabKey);
          if (!validTabId(boundTabId) || !progress?.collectionToken) continue;
          const binding = await accounts.getTabBinding(boundTabId);
          if (binding?.accountUid === accountUid && binding.collectionToken === progress.collectionToken) {
            await executePage(boundTabId, pageStopCollectionBound,
              [accountUid, binding.collectionToken]).catch(() => null);
          }
        }
      }
      const result = await accounts.clearAccount(accountUid);
      if (validTabId(tabId)) void syncVerificationBadge(tabId, accountUid, null);
      const summary = { contactCount: 0, messageCount: 0, unidentifiedObservationCount: 0 };
      const view = await writePopupView({ accountUid, summary,
        progress: null, verificationRequired: false, verificationRetrying: false,
        updatedAt: new Date().toISOString() });
      return { ok: true, accountUid, cleared: true,
        invalidatedTabIds: result.invalidatedTabIds,
        summary, verificationRequired: false, verificationRetrying: false,
        updatedAt: view.updatedAt, view };
    }

    return { ok: false, error: 'UNKNOWN_MESSAGE_TYPE' };
  }

  async function handleStopMessage(message) {
    return processUiMessage(message, await localUiContext(message));
  }

  async function handleUiMessage(message) {
    if (message.type === 'START_UPDATE' || message.type === 'RESUME_AFTER_VERIFICATION') {
      return controlQueue(() => freshStartMessage(message));
    }
    if (message.type === 'GET_STATE') {
      return processUiMessage(message, await localUiContext(message, { usePopupView: true }));
    }
    if (message.type === 'STOP_UPDATE') {
      return controlQueue(() => handleStopMessage(message));
    }
    if (message.type === 'GET_BULK_PROGRESS' || message.type === 'CLEAR_ACCOUNT') {
      return controlQueue(async () => processUiMessage(message, await localUiContext(message)));
    }
    return processUiMessage(message, await localUiContext(message));
  }

  return async function handleMessage(message, sender = {}) {
    if (message?.type === 'SITE_REQUEST_SLOT') {
      if (!extensionUiSender(sender, chromeApi.runtime.id) && !trustedCollectorSender(sender, chromeApi.runtime.id)) {
        return { ok: false, error: 'UNTRUSTED_SITE_REQUEST_SLOT_SENDER' };
      }
      try { return await reserveSiteRequestSlot(message.endpoint); }
      catch (error) { return errorPayload(error); }
    }
    if (message?.type === 'BULK_PROGRESS' || message?.type === 'BULK_SNAPSHOTS') {
      try { return await handleCollectorMessage(message, sender); }
      catch (error) { return errorPayload(error); }
    }
    if (!extensionUiSender(sender, chromeApi.runtime.id)) return { ok: false, error: 'UNTRUSTED_EXTENSION_UI_SENDER' };
    try { return await handleUiMessage(message || {}); }
    catch (error) { return errorPayload(error); }
  };
}

if (globalThis.chrome?.runtime?.onMessage) {
  const accountStorage = createProtectedAccountStorage(globalThis.chrome);
  registerPublicRuntime(globalThis.chrome, {
    createExtensionMessageHandler: (api, options) => createExtensionMessageHandler(api, { ...options, accountStorage }),
    createStoragePortServer,
    isTrustedCollectorSender: trustedCollectorSender,
  });
}
