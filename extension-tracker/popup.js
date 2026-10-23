const accountLabel = document.querySelector('#account');
const contactCount = document.querySelector('#contact-count');
const messageCount = document.querySelector('#message-count');
const progressLabel = document.querySelector('#progress');
const statusLabel = document.querySelector('#status');
const updateIncrementalButton = document.querySelector('#update-incremental');
const updateFullButton = document.querySelector('#update-full');
const accountCard = document.querySelector('#account-card');
const progressCard = document.querySelector('#progress-card');
const firstRunGuide = document.querySelector('#first-run-guide');
const countsSection = document.querySelector('#counts');
const exportActions = document.querySelector('#export-actions');
const recordTools = document.querySelector('#record-tools');
const POPUP_VIEW_STORAGE_KEY = 'bossReadonlyTracker.popupView.v1';
const controlButtons = [...document.querySelectorAll('.actions button'), document.querySelector('#clear')];
const mutationButtons = ['#update-incremental', '#update-full', '#clear']
  .map(selector => document.querySelector(selector));
let currentAccountUid = null;
let viewEpoch = 0;
let mutationCount = 0;
let lastProgress = null;
let summaryIsKnownEmpty = false;
let hasCollectionHistory = null;
let firstRunWelcome = false;
let firstStartRetryAvailable = false;
let firstRunStarting = false;
let firstCollectionInThisPopup = false;
let stateRefreshPromise = null;
let progressRefreshPromise = null;
let progressTimer = null;
let legacyPopupViewLookupAttempted = false;
let legacyPopupViewConfirmedEmpty = false;
const foregroundActions = [];
const requestDeadlines = { GET_BULK_PROGRESS: 30000 };
const actionRequestTimeoutMs = 90000;
const popupTimeoutStatuses = new Set();

const progressErrorMessages = {
  ARCHIVE_KEY_MISSING: '本机归档密钥不存在，无法读取加密记录。请保留浏览器配置及已有导出备份。',
  ARCHIVE_KEY_MISMATCH: '本机密钥与归档不匹配，原记录未改动。',
  ARCHIVE_KEY_INVALID: '本机归档密钥无效，原记录未改动。',
  ARCHIVE_KEY_UNAVAILABLE: '暂时无法读取本机归档密钥，请保留当前浏览器配置。',
  ARCHIVE_CRYPTO_UNAVAILABLE: '当前浏览器无法使用本地加密功能。',
  ARCHIVE_ACCESS_UNAVAILABLE: '无法限制本地存储访问范围，请使用支持的 Chrome 版本。',
  ARCHIVE_CIPHERTEXT_INVALID: '本地加密记录格式异常，原记录未改动。',
  ARCHIVE_DECRYPT_FAILED: '本地归档解密失败，原记录未改动。',
  ARCHIVE_ENCRYPT_FAILED: '本地归档加密失败，原记录已保留。',
  BULK_STORAGE_TIMEOUT: '扩展本地保存长时间没有进展，采集已暂停。',
  BULK_STORAGE_UNAVAILABLE: '扩展内部保存连接已断开，采集已暂停。',
  SITE_NON_JSON_RESPONSE: '网站接口返回了 HTML 页面而不是 JSON；本轮已停止，可以重试。',
  SITE_HTTP_ERROR: '网站接口返回错误状态；本轮已停止，可以重试。',
  SITE_REQUEST_TIMEOUT: '读取网站接口超时；本轮已停止，可以重试。',
  COLLECTOR_UNAVAILABLE: '当前沟通页已没有本轮采集器；本轮已标记中断，可以继续更新。',
  COLLECTION_FINALIZING: '正在保存停止前已读取的内容，请稍后重试。',
  SITE_VERIFICATION_REQUIRED: 'BOSS 要求人工验证。请先在 BOSS 页面完成验证，再继续采集。',
  POPUP_REQUEST_TIMEOUT: '等待扩展后台响应超时，请刷新状态后重试。',
  TAB_QUERY_TIMEOUT: '读取当前标签页超时，请刷新状态后重试。',
};
popupTimeoutStatuses.add(progressErrorMessages.POPUP_REQUEST_TIMEOUT);
popupTimeoutStatuses.add(progressErrorMessages.TAB_QUERY_TIMEOUT);
const progressStateNames = {
  running: '正在更新', stopping: '正在保存停止前已读取的内容', completed: '已完成', interrupted: '上次采集已中断，可继续采集',
  failed: '更新失败，可重试', stopped: '采集已停止，可继续', paused: '采集已暂停，可继续',
};
const terminalStates = new Set(['completed', 'interrupted', 'failed', 'stopped', 'paused']);

function progressState(progress) {
  return progress?.status || progress?.state || '未知';
}

function progressFromResponse(result) {
  const progress = result?.progress && typeof result.progress === 'object' ? result.progress : null;
  const hasRequired = typeof result?.verificationRequired === 'boolean';
  const required = hasRequired ? result.verificationRequired : progress?.verificationRequired;
  if (required === undefined) return progress;
  if (!progress && required === false) return null;
  return { ...(progress || {}),
    verificationRequired: required };
}

function resolveCollectionHistory(declared, summary, progress, fallback = null) {
  const hasSavedRecords = ['contactCount', 'messageCount'].some(key =>
    Number.isFinite(summary?.[key]) && summary[key] > 0);
  if (declared === true || progress || hasSavedRecords) return true;
  if (declared === false) return false;
  return fallback;
}

function unknownEmptyView() {
  return Boolean(currentAccountUid) && hasCollectionHistory === null && summaryIsKnownEmpty && !lastProgress;
}

function popupViewFromPayload(payload, fallbackAccountUid = currentAccountUid) {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload.view && typeof payload.view === 'object'
    ? { ...payload.view, ...payload } : payload;
  const accountUid = source.accountUid || source.localAccountUid || null;
  if (!accountUid) return null;
  const displayedCount = element => {
    const value = Number(element?.textContent);
    return Number.isFinite(value) ? value : null;
  };
  const fallback = fallbackAccountUid === accountUid ? {
    summary: { contactCount: displayedCount(contactCount), messageCount: displayedCount(messageCount) },
    progress: lastProgress,
    hasCollectionHistory,
  } : null;
  const summary = source.summary && typeof source.summary === 'object' ? source.summary :
    fallback?.summary || { contactCount: null, messageCount: null };
  const progress = Object.hasOwn(source, 'progress') || typeof source.verificationRequired === 'boolean'
    ? progressFromResponse(source) : fallback?.progress || null;
  const history = resolveCollectionHistory(source.hasCollectionHistory, summary, progress, fallback?.hasCollectionHistory);
  return { ok: true, accountUid: String(accountUid), summary, progress,
    hasCollectionHistory: history,
    verificationRequired: source.verificationRequired,
    updatedAt: source.updatedAt || fallback?.updatedAt || null };
}

async function readLocalPopupView() {
  const record = await withTimeout(chrome.storage.local.get(POPUP_VIEW_STORAGE_KEY), 5000, 'POPUP_VIEW_TIMEOUT');
  return popupViewFromPayload(record?.[POPUP_VIEW_STORAGE_KEY], null);
}

function mergeProgressResponses(primary, secondary) {
  const current = progressFromResponse(primary);
  const fallback = progressFromResponse(secondary);
  if (!current) return fallback;
  if (!fallback) return current;
  return { ...fallback, ...current,
    ...(typeof current.verificationRequired === 'boolean' ? {} :
      typeof fallback.verificationRequired === 'boolean' ? { verificationRequired: fallback.verificationRequired } : {}) };
}

function verificationWaiting(progress) {
  const state = progressState(progress);
  const required = typeof progress?.verificationRequired === 'boolean'
    ? progress.verificationRequired : progress?.errorCode === 'SITE_VERIFICATION_REQUIRED';
  return required &&
    progress?.finalizing !== true && progress?.active !== true && state !== 'running' && state !== 'stopping';
}

function progressName(progress) {
  if (progress?.finalizing === true || progressState(progress) === 'stopping') {
    return '正在保存停止前已读取的内容';
  }
  if (verificationWaiting(progress)) return '等待 BOSS 人工验证';
  const state = progressState(progress);
  if (['failed', 'interrupted'].includes(state) && progress?.errorCode === 'SITE_VERIFICATION_REQUIRED' &&
      progress?.verificationRequired !== false) {
    return '更新已暂停';
  }
  return progressStateNames[state] || state;
}

function isProgressRunning(progress) {
  return progressState(progress) === 'stopping' || progress?.active === true || progress?.finalizing === true ||
    (progressState(progress) === 'running' && progress?.active !== false);
}

function canResumeProgress(progress) {
  return !verificationWaiting(progress) && !isProgressRunning(progress) &&
    ['interrupted', 'failed', 'stopped', 'paused'].includes(progressState(progress));
}

function primaryActionLabel() {
  if (firstRunStarting) return currentAccountUid ? '正在启动首次采集…' : '正在确认账号并启动…';
  if (verificationWaiting(lastProgress)) return '我已完成验证，继续采集';
  if (firstStartRetryAvailable && !currentAccountUid) return '开始首次采集';
  if (lastProgress?.finalizing === true || progressState(lastProgress) === 'stopping') {
    if (summaryIsKnownEmpty || firstCollectionInThisPopup) return '正在保存采集内容';
    return '更新变化会话';
  }
  if (isProgressRunning(lastProgress)) {
    return summaryIsKnownEmpty || firstCollectionInThisPopup ? '正在采集' : '正在更新';
  }
  if (canResumeProgress(lastProgress)) return '继续上次采集';
  if (unknownEmptyView()) return '开始采集';
  return firstRunWelcome ? '开始首次采集' : '更新变化会话';
}

function updateViewVisibility() {
  const running = isProgressRunning(lastProgress);
  const waitingForVerification = verificationWaiting(lastProgress);
  const onboarding = firstRunWelcome || firstRunStarting;
  if (accountCard) accountCard.hidden = firstRunWelcome || firstRunStarting;
  if (progressCard) progressCard.hidden = firstRunWelcome;
  if (firstRunGuide) firstRunGuide.hidden = !firstRunWelcome;
  if (countsSection) countsSection.hidden = onboarding;
  if (exportActions) exportActions.hidden = onboarding;
  if (recordTools) recordTools.hidden = onboarding;
  if (updateFullButton) updateFullButton.hidden = onboarding || running || waitingForVerification;
  const stopButton = document.querySelector('#stop');
  if (stopButton) stopButton.hidden = firstRunWelcome || !running;
}

function diagnosticForProgress(progress) {
  if (!progress) return '';
  if (progress.finalizing === true) return '';
  const code = typeof progress.errorCode === 'string' ? progress.errorCode : '';
  if (code === 'SITE_VERIFICATION_REQUIRED') {
    return progress?.verificationRequired === false ? '' : progressErrorMessages[code];
  }
  if (verificationWaiting(progress)) return progressErrorMessages.SITE_VERIFICATION_REQUIRED;
  if (typeof progress.errorDetails === 'string' && progress.errorDetails) return progress.errorDetails.slice(0, 180);
  if (progressErrorMessages[code]) return progressErrorMessages[code];
  if (progress.errorDetails && typeof progress.errorDetails === 'object') {
    const details = progress.errorDetails;
    const safeParts = [];
    if (Number.isFinite(details.httpStatus)) safeParts.push(`HTTP ${details.httpStatus}`);
    if (typeof details.contentType === 'string') safeParts.push(details.contentType.slice(0, 80));
    if (typeof details.responseKind === 'string') safeParts.push(details.responseKind.slice(0, 80));
    if (safeParts.length) return safeParts.join(' · ');
  }
  const raw = String(progress.error || '');
  if (/Unexpected token[\s\S]{0,100}(?:<\/?(?:!doctype|html)|<)/iu.test(raw)) {
    return progressErrorMessages.SITE_NON_JSON_RESPONSE;
  }
  if (code) return code.slice(0, 100);
  return raw.slice(0, 180);
}

function operationStatus(type, progress) {
  const state = progressState(progress);
  if (state === 'stopping' || progress?.finalizing === true) return '正在保存停止前已读取的内容。';
  if (verificationWaiting(progress)) {
    if (type === 'EXPORT_AI_INPUT') return 'AI 输入已导出；请先在 BOSS 页面完成验证，再继续采集。';
    if (type === 'EXPORT_ACCOUNT_BACKUP') return '账号备份已导出；请先在 BOSS 页面完成验证，再继续采集。';
    return '请在 BOSS 页面完成人工验证，再点击“我已完成验证，继续采集”。';
  }
  if (isProgressRunning(progress)) {
    if (state === 'failed') return '采集遇到错误，正在保存此前已读取的内容。';
    if (state === 'interrupted') return '更新已中断，正在保存此前已读取的内容。';
    if (type === 'START_UPDATE' && firstCollectionInThisPopup) {
      return '首次采集已启动，正在读取当前账号可读取的会话。';
    }
    if (type === 'EXPORT_AI_INPUT') return 'AI 输入已导出；后台更新仍在进行。';
    if (type === 'EXPORT_ACCOUNT_BACKUP') return '账号备份已导出；后台更新仍在进行。';
    return '更新任务已启动，正在后台继续。';
  }
  if (state === 'failed' || state === 'interrupted') {
    const diagnostic = diagnosticForProgress(progress);
    const prefix = type === 'START_UPDATE' ? '' : '操作已完成；';
    return `${prefix}${progressName(progress) || '更新未完成'}${diagnostic ? `：${diagnostic}` : '。'}`;
  }
  if (state === 'stopped') return '更新已停止。';
  if (type === 'START_UPDATE' && state === 'completed') return '更新已完成。';
  if (type === 'STOP_UPDATE') return '当前账号没有正在运行的更新任务。';
  if (type === 'EXPORT_AI_INPUT') return 'AI 输入已导出。';
  if (type === 'EXPORT_ACCOUNT_BACKUP') return '账号备份已导出。';
  if (type === 'CLEAR_ACCOUNT') return '当前账号本地记录已清除。';
  return '操作已完成。';
}

function setEnabled(enabled) {
  const busy = mutationCount > 0;
  const running = isProgressRunning(lastProgress);
  for (const button of controlButtons) {
    if (button === document.querySelector('#stop')) {
      // STOP stays available while another mutation is waiting on a slow page.
      button.disabled = !enabled || !currentAccountUid;
      continue;
    }
    const accountRequired = button !== updateIncrementalButton;
    button.disabled = !enabled || (accountRequired && !currentAccountUid) ||
      (busy && mutationButtons.includes(button));
  }
  const waitingForVerification = verificationWaiting(lastProgress);
  if (updateIncrementalButton) {
    updateIncrementalButton.textContent = primaryActionLabel();
    const mayStartWithoutUid = firstRunWelcome || firstStartRetryAvailable;
    updateIncrementalButton.disabled = (!enabled && !mayStartWithoutUid) ||
      (busy && mutationButtons.includes(updateIncrementalButton)) ||
      running;
  }
  if (updateFullButton) {
    updateFullButton.disabled = updateFullButton.disabled || running || waitingForVerification;
  }
  updateViewVisibility();
}

function setBackgroundStatus(message) {
  if (foregroundActions.length === 0) statusLabel.textContent = message;
}

function setMutationBusy(busy) {
  mutationCount = Math.max(0, mutationCount + (busy ? 1 : -1));
  setEnabled(Boolean(currentAccountUid));
}

function clearView(message, { welcome = false, preserveFirstStartRetry = false } = {}) {
  viewEpoch++;
  currentAccountUid = null;
  lastProgress = null;
  firstRunStarting = false;
  firstCollectionInThisPopup = false;
  summaryIsKnownEmpty = welcome;
  hasCollectionHistory = welcome ? false : null;
  firstRunWelcome = welcome;
  if (welcome) firstStartRetryAvailable = false;
  else if (!preserveFirstStartRetry) firstStartRetryAvailable = false;
  if (!welcome) legacyPopupViewConfirmedEmpty = false;
  accountLabel.textContent = '尚无本地记录';
  contactCount.textContent = '—';
  messageCount.textContent = '—';
  progressLabel.textContent = welcome ? '尚未采集' : '尚无可显示的本地更新记录';
  statusLabel.textContent = message;
  setEnabled(true);
}

function statusForError(error) {
  if (error === 'POPUP_VIEW_TIMEOUT') return '读取本地记录超时，请重试。';
  if (progressErrorMessages[error]) return progressErrorMessages[error];
  if (error === 'UNSUPPORTED_PAGE' || error === 'TAB_ID_REQUIRED' || error === 'TAB_NOT_AVAILABLE') {
    return '请打开 BOSS 直聘沟通页后再使用扩展。';
  }
  if (error === 'ACCOUNT_IDENTITY_UNAVAILABLE' || error === 'ACCOUNT_CONTEXT_CHANGED') {
    return '无法确认当前登录账号，已隐藏所有本地记录。';
  }
  if (error === 'NO_CURRENT_COLLECTION' || error === 'BULK_COLLECTOR_NOT_RUNNING') {
    return '当前账号没有正在运行的更新任务。';
  }
  return '操作未完成，请刷新状态后重试。';
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Number.isSafeInteger(tab?.id) && tab.id >= 0 ? tab.id : null;
}

async function request(type, fields = {}, expectedAccountUid = currentAccountUid) {
  const frozenExpectedAccountUid = expectedAccountUid;
  let tabId;
  try { tabId = await withTimeout(activeTabId(), 5000, 'TAB_QUERY_TIMEOUT'); }
  catch (error) { return { ok: false, error: error?.message || 'TAB_QUERY_TIMEOUT' }; }
  if (tabId === null) {
    return { ok: false, error: 'TAB_NOT_AVAILABLE' };
  }
  const message = { type, tabId };
  if (frozenExpectedAccountUid) message.expectedAccountUid = frozenExpectedAccountUid;
  try {
    const timeoutMs = requestDeadlines[type] || actionRequestTimeoutMs;
    const result = await withTimeout(chrome.runtime.sendMessage({ ...message, ...fields }),
      timeoutMs, 'POPUP_REQUEST_TIMEOUT');
    return result || { ok: false, error: 'EMPTY_WORKER_RESPONSE' };
  } catch (error) {
    return { ok: false, error: error?.message || 'EXTENSION_RUNTIME_ERROR' };
  }
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function renderProgress(progress) {
  lastProgress = progress || null;
  if (!progress) {
    progressLabel.textContent = firstRunWelcome ? '尚未采集' : '尚无更新记录';
    setEnabled(Boolean(currentAccountUid));
    return;
  }
  const state = progressState(progress);
  if (terminalStates.has(state)) firstCollectionInThisPopup = false;
  const label = state === 'running' && (summaryIsKnownEmpty || firstCollectionInThisPopup)
    ? '正在采集' : progressName(progress);
  const parts = [label];
  const checked = Number.isFinite(progress.completed) ? progress.completed : progress.scannedCount;
  const total = Number.isFinite(progress.discovered) ? progress.discovered : progress.currentScopeCount;
  if (Number.isFinite(checked) && Number.isFinite(total)) parts.push(`检查 ${checked}/${total}`);
  if (Number.isFinite(progress.refreshedCount)) parts.push(`已更新 ${progress.refreshedCount}`);
  if (Number.isFinite(progress.skippedUnchangedCount)) parts.push(`跳过 ${progress.skippedUnchangedCount}`);
  if (Number.isFinite(progress.failed)) parts.push(`失败 ${progress.failed}`);
  if (Number.isFinite(progress.newMessageCount)) parts.push(`新增消息 ${progress.newMessageCount}`);
  else if (Number.isFinite(progress.messageCount)) parts.push(`读取消息 ${progress.messageCount}`);
  const diagnostic = diagnosticForProgress(progress);
  if (diagnostic && (terminalStates.has(state) || progress.errorCode)) parts.push(diagnostic);
  progressLabel.textContent = parts.join(' · ');
  setEnabled(Boolean(currentAccountUid));
}

function applyState(result, { preserveFirstCollection = false } = {}) {
  if (!result?.accountUid || !result.summary) {
    clearView(statusForError(result?.error));
    return false;
  }
  currentAccountUid = result.accountUid;
  firstRunStarting = false;
  if (!preserveFirstCollection) firstCollectionInThisPopup = false;
  legacyPopupViewConfirmedEmpty = false;
  accountLabel.textContent = result.accountUid;
  const contactCountKnown = Number.isFinite(result.summary.contactCount);
  const messageCountKnown = Number.isFinite(result.summary.messageCount);
  contactCount.textContent = contactCountKnown ? String(result.summary.contactCount) : '—';
  messageCount.textContent = messageCountKnown ? String(result.summary.messageCount) : '—';
  summaryIsKnownEmpty = contactCountKnown && messageCountKnown &&
    result.summary.contactCount === 0 && result.summary.messageCount === 0;
  const progress = progressFromResponse(result);
  hasCollectionHistory = resolveCollectionHistory(result.hasCollectionHistory, result.summary, progress);
  firstRunWelcome = hasCollectionHistory === false && summaryIsKnownEmpty && !progress;
  firstStartRetryAvailable = false;
  renderProgress(progress);
  const cacheTime = result.updatedAt ? new Date(result.updatedAt).toLocaleString() : null;
  const diagnostic = diagnosticForProgress(progress);
  if (diagnostic) setBackgroundStatus(diagnostic);
  else if (['failed', 'interrupted'].includes(progressState(progress))) {
    setBackgroundStatus(progressName(progress));
  } else if (firstRunWelcome) setBackgroundStatus('准备好后，点击下方按钮开始。');
  else setBackgroundStatus(cacheTime ? `已显示本地记录缓存（${cacheTime}）。` : '已显示本地记录缓存。');
  return true;
}

async function refreshState({ quiet = false, force = false } = {}) {
  if (stateRefreshPromise) {
    const inFlight = stateRefreshPromise;
    if (!force) return inFlight;
    await inFlight;
    if (stateRefreshPromise && stateRefreshPromise !== inFlight) return stateRefreshPromise;
    return refreshState({ quiet, force: false });
  }
  if (progressRefreshPromise) {
    const inFlight = progressRefreshPromise;
    await inFlight;
    return refreshState({ quiet, force: false });
  }
  const epoch = ++viewEpoch;
  stateRefreshPromise = (async () => {
    try {
      const result = await readLocalPopupView();
      if (epoch !== viewEpoch) return null;
      if (result?.accountUid && result.summary) {
        applyState(result);
        if (quiet && currentAccountUid && !isProgressRunning(lastProgress)) setBackgroundStatus('已显示本地记录缓存。');
        return result;
      }
      let legacyResult = null;
      if (!legacyPopupViewLookupAttempted) {
        legacyPopupViewLookupAttempted = true;
        legacyResult = await withTimeout(chrome.runtime.sendMessage({ type: 'GET_STATE' }),
          30000, 'POPUP_REQUEST_TIMEOUT');
        if (epoch !== viewEpoch) return null;
        const migratedView = popupViewFromPayload(legacyResult, null);
        if (legacyResult?.ok && migratedView?.accountUid) {
          legacyPopupViewConfirmedEmpty = false;
          applyState(migratedView);
          return migratedView;
        }
        if (['ACCOUNT_UID_REQUIRED', 'NO_LOCAL_ACCOUNT'].includes(legacyResult?.error)) {
          legacyPopupViewConfirmedEmpty = true;
        } else if (legacyResult?.error) {
          clearView(statusForError(legacyResult.error));
          return null;
        }
      }
      if (legacyPopupViewConfirmedEmpty) {
        clearView('尚无本地记录。打开 BOSS 直聘沟通页后，可开始首次采集。', { welcome: true });
      } else {
        clearView('尚无本地记录缓存。请刷新状态后重试。');
      }
      return result;
    } catch (error) {
      if (epoch === viewEpoch) clearView(statusForError(error?.message));
      return null;
    }
  })();
  try { return await stateRefreshPromise; }
  finally { stateRefreshPromise = null; }
}

async function adoptLocalViewAfterSwitch(result, requestedUid, statusText = null) {
  let view = popupViewFromPayload(result, null);
  if (!view) {
    try { view = await readLocalPopupView(); } catch { view = null; }
  }
  if (!view) {
    clearView('本地记录账号已变化。请点击“更新变化会话”确认新账号后继续。');
    return;
  }
  if (view.accountUid !== requestedUid) viewEpoch++;
  applyState(view);
  statusLabel.textContent = statusText || `本地记录账号已切换为 ${view.accountUid}。`;
}

async function refreshProgress() {
  if (progressRefreshPromise) return progressRefreshPromise;
  if (stateRefreshPromise) return stateRefreshPromise;
  if (!currentAccountUid) return null;
  const epoch = viewEpoch;
  const requestedUid = currentAccountUid;
  progressRefreshPromise = (async () => {
    try {
      const result = await request('GET_BULK_PROGRESS', {}, requestedUid);
      if (epoch !== viewEpoch) return;
      if (!result.ok) {
        if (result.error === 'ACCOUNT_CONTEXT_CHANGED') {
          await adoptLocalViewAfterSwitch(result, requestedUid);
          return;
        }
        if (['UNSUPPORTED_PAGE', 'TAB_ID_REQUIRED', 'TAB_NOT_AVAILABLE', 'ACCOUNT_IDENTITY_UNAVAILABLE',
          'SITE_VERIFICATION_REQUIRED']
          .includes(result.error)) clearView(statusForError(result.error));
        else setBackgroundStatus(statusForError(result.error));
        return;
      }
      if (result.accountUid !== requestedUid) {
        await adoptLocalViewAfterSwitch(result, requestedUid);
        return;
      }
      if (result.summary) {
        const contactCountKnown = Number.isFinite(result.summary.contactCount);
        const messageCountKnown = Number.isFinite(result.summary.messageCount);
        contactCount.textContent = contactCountKnown ? String(result.summary.contactCount) : '—';
        messageCount.textContent = messageCountKnown ? String(result.summary.messageCount) : '—';
        summaryIsKnownEmpty = contactCountKnown && messageCountKnown &&
          result.summary.contactCount === 0 && result.summary.messageCount === 0;
      }
      const wasFirstRunWelcome = firstRunWelcome;
      const progress = progressFromResponse(result);
      const displayedSummary = result.summary || {
        contactCount: Number.isFinite(Number(contactCount.textContent)) ? Number(contactCount.textContent) : null,
        messageCount: Number.isFinite(Number(messageCount.textContent)) ? Number(messageCount.textContent) : null,
      };
      hasCollectionHistory = resolveCollectionHistory(result.hasCollectionHistory, displayedSummary,
        progress, hasCollectionHistory);
      firstRunWelcome = hasCollectionHistory === false && summaryIsKnownEmpty && !progress;
      renderProgress(progress);
      const diagnostic = diagnosticForProgress(progress);
      if (diagnostic) setBackgroundStatus(diagnostic);
      else if (['failed', 'interrupted'].includes(progressState(progress))) {
        setBackgroundStatus(progressName(progress));
      } else if (wasFirstRunWelcome &&
        (progress?.finalizing === true || progressState(progress) === 'stopping')) {
        setBackgroundStatus('正在保存停止前已读取的内容。');
      } else if (wasFirstRunWelcome && progress && isProgressRunning(progress)) {
        setBackgroundStatus('首次采集已启动，正在读取当前账号可读取的会话。');
      } else if (wasFirstRunWelcome && progressState(progress) === 'completed') {
        setBackgroundStatus('首次采集已完成。');
      } else if (wasFirstRunWelcome && ['paused', 'stopped'].includes(progressState(progress))) {
        setBackgroundStatus(progressName(progress));
      } else if (wasFirstRunWelcome && !firstRunWelcome) {
        setBackgroundStatus('本机记录已加载。');
      }
      if (popupTimeoutStatuses.has(statusLabel.textContent)) {
        setBackgroundStatus('当前账号记录已加载。');
      }
    } catch {
      if (epoch === viewEpoch) clearView('无法确认当前登录账号，已隐藏所有本地记录。');
    }
  })();
  try { return await progressRefreshPromise; }
  finally { progressRefreshPromise = null; }
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function runAction(label, action, onSuccess = null, { mutation = false, allowBusy = false,
  messageType = '' } = {}) {
  const firstStart = !currentAccountUid && messageType === 'START_UPDATE';
  const firstCollectionStart = (firstRunWelcome || firstStartRetryAvailable) && messageType === 'START_UPDATE';
  if ((!currentAccountUid && !firstStart) || (mutation && mutationCount > 0 && !allowBusy)) return;
  const startingUid = currentAccountUid;
  const epoch = viewEpoch;
  const wasFirstRunWelcome = firstRunWelcome;
  const wasFirstStartRetryAvailable = firstStartRetryAvailable;
  if (firstCollectionStart) {
    firstRunWelcome = false;
    firstStartRetryAvailable = true;
    firstRunStarting = true;
    firstCollectionInThisPopup = true;
    summaryIsKnownEmpty = true;
    progressLabel.textContent = '正在启动首次采集…';
  }
  if (foregroundActions.length === 0 && progressTimer !== null) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  const foregroundAction = { label, accountUid: startingUid, messageType };
  foregroundActions.push(foregroundAction);
  if (mutation) setMutationBusy(true);
  statusLabel.textContent = label;
  try {
    const result = await action(startingUid);
    if (epoch !== viewEpoch) return;
    if (!result?.ok) {
      if (result?.error === 'ACCOUNT_CONTEXT_CHANGED') {
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        const viewUid = result.accountUid || result.view?.accountUid || '新账号';
        const message = `本地记录账号已切换为 ${viewUid}；本次操作未执行。`;
        await adoptLocalViewAfterSwitch(result, startingUid, message);
        return;
      }
      if (firstCollectionStart) {
        firstRunWelcome = wasFirstRunWelcome;
        firstStartRetryAvailable = wasFirstRunWelcome || wasFirstStartRetryAvailable;
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        setEnabled(Boolean(currentAccountUid));
      }
      statusLabel.textContent = statusForError(result?.error);
      if (['UNSUPPORTED_PAGE', 'TAB_NOT_AVAILABLE', 'ACCOUNT_IDENTITY_UNAVAILABLE',
        'SITE_VERIFICATION_REQUIRED'].includes(result?.error)) {
        clearView(statusForError(result.error), { preserveFirstStartRetry: firstCollectionStart });
      }
      return;
    }
    const switchedDuringStart = Boolean(startingUid && result.accountUid && result.accountUid !== startingUid &&
      messageType === 'START_UPDATE');
    if (startingUid && result.accountUid && result.accountUid !== startingUid && !switchedDuringStart) {
      const message = `本地记录账号已切换为 ${result.accountUid}；本次操作未执行。`;
      await adoptLocalViewAfterSwitch(result, startingUid, message);
      return;
    }
    if (firstStart && !result.accountUid) {
      if (firstCollectionStart) {
        firstRunWelcome = wasFirstRunWelcome;
        firstStartRetryAvailable = wasFirstRunWelcome || wasFirstStartRetryAvailable;
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        setEnabled(Boolean(currentAccountUid));
      }
      statusLabel.textContent = '扩展未返回已确认的本地记录账号，请重试。';
      return;
    }
    if (firstCollectionStart) {
      firstRunStarting = false;
      firstStartRetryAvailable = false;
    }
    const viewPayload = messageType === 'CLEAR_ACCOUNT' && result.cleared && !Object.hasOwn(result, 'progress')
      ? { ...result, progress: null } : result;
    const view = popupViewFromPayload(viewPayload, startingUid);
    const updatesLocalView = ['START_UPDATE', 'STOP_UPDATE', 'CLEAR_ACCOUNT']
      .includes(messageType) || Boolean(result.view);
    if (switchedDuringStart) viewEpoch++;
    if (view && updatesLocalView) applyState(view, { preserveFirstCollection: firstCollectionStart });
    if (onSuccess) onSuccess(result);
    const latestProgress = progressFromResponse(viewPayload) || (updatesLocalView ? view?.progress : lastProgress);
    if (updatesLocalView && view) renderProgress(latestProgress || null);
    else if (latestProgress && updatesLocalView) renderProgress(latestProgress);
    statusLabel.textContent = switchedDuringStart
      ? `已按当前登录账号 ${result.accountUid} 开始采集。`
      : operationStatus(messageType, latestProgress);
  } catch {
    if (epoch === viewEpoch) {
      if (firstCollectionStart) {
        firstRunWelcome = wasFirstRunWelcome;
        firstStartRetryAvailable = wasFirstRunWelcome || wasFirstStartRetryAvailable;
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        setEnabled(Boolean(currentAccountUid));
      }
      statusLabel.textContent = statusForError('POPUP_REQUEST_TIMEOUT');
    }
  } finally {
    const index = foregroundActions.lastIndexOf(foregroundAction);
    if (index >= 0) foregroundActions.splice(index, 1);
    if (currentAccountUid && foregroundActions.length > 0) {
      statusLabel.textContent = foregroundActions[foregroundActions.length - 1].label;
    } else if (currentAccountUid) {
      scheduleProgressPoll();
    }
    if (mutation) setMutationBusy(false);
  }
}

document.querySelector('#refresh').addEventListener('click', () => refreshState({ force: true }));
document.querySelector('#update-incremental').addEventListener('click', () => {
  const accountUid = currentAccountUid;
  if (!accountUid) {
    return runAction('正在确认采集账号并启动…',
      expectedUid => request('START_UPDATE', { mode: 'incremental' }, expectedUid), null,
      { mutation: true, messageType: 'START_UPDATE' });
  }
  if (isProgressRunning(lastProgress)) return;
  const startLabel = firstRunWelcome ? '正在启动首次采集…' :
    unknownEmptyView() ? '正在启动采集…' : '正在更新变化会话…';
  return runAction(startLabel,
    expectedUid => request('START_UPDATE', { mode: 'incremental' }, expectedUid), null,
    { mutation: true, messageType: 'START_UPDATE' });
});
document.querySelector('#update-full').addEventListener('click', () => {
  if (!currentAccountUid || isProgressRunning(lastProgress) || verificationWaiting(lastProgress)) return;
  return runAction('正在重新读取全部会话…',
    expectedUid => request('START_UPDATE', { mode: 'full' }, expectedUid), null,
    { mutation: true, messageType: 'START_UPDATE' });
});
document.querySelector('#stop').addEventListener('click', () => runAction('正在停止更新…',
  expectedUid => request('STOP_UPDATE', {}, expectedUid), null,
  { mutation: true, allowBusy: true, messageType: 'STOP_UPDATE' }));
document.querySelector('#export-latest').addEventListener('click', () => runAction('正在准备本次更新的 AI 输入…',
  expectedUid => request('EXPORT_AI_INPUT', { scope: 'latest_update' }, expectedUid), result => {
    downloadJson(result.analysisInput, `boss-ai-latest-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_AI_INPUT' }));
document.querySelector('#export-all').addEventListener('click', () => runAction('正在准备全部记录的 AI 输入…',
  expectedUid => request('EXPORT_AI_INPUT', { scope: 'all' }, expectedUid), result => {
    downloadJson(result.analysisInput, `boss-ai-all-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_AI_INPUT' }));
document.querySelector('#backup').addEventListener('click', () => runAction('正在准备当前账号备份…',
  expectedUid => request('EXPORT_ACCOUNT_BACKUP', {}, expectedUid), result => {
    downloadJson(result.backup, `boss-backup-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_ACCOUNT_BACKUP' }));
document.querySelector('#clear').addEventListener('click', () => {
  if (!currentAccountUid || !window.confirm(`清除账号 ${currentAccountUid} 在本扩展中的全部本地会话和更新记录？此操作无法撤销。`)) return;
  runAction('正在清除当前账号记录…', expectedUid => request('CLEAR_ACCOUNT', {}, expectedUid), result => {
    if (result.cleared) progressLabel.textContent = '当前账号本地记录已清除';
  }, { mutation: true, messageType: 'CLEAR_ACCOUNT' });
});

function scheduleProgressPoll() {
  if (progressTimer !== null) clearTimeout(progressTimer);
  if (!currentAccountUid || verificationWaiting(lastProgress)) {
    progressTimer = null;
    return;
  }
  const delay = isProgressRunning(lastProgress) ? 5000 : 10000;
  progressTimer = setTimeout(async () => {
    progressTimer = null;
    if (foregroundActions.length === 0) await refreshProgress();
    scheduleProgressPoll();
  }, delay);
}
void refreshState().finally(scheduleProgressPoll);
window.addEventListener('unload', () => {
  if (progressTimer !== null) clearTimeout(progressTimer);
}, { once: true });
