import { LANGUAGE_STORAGE_KEY, PROGRESS_ERROR_CODES, resolveLocale, translate, formatDate } from './i18n.mjs';

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
const progressErrorCodes = new Set(PROGRESS_ERROR_CODES);
const popupTimeoutCodes = new Set(['error.POPUP_REQUEST_TIMEOUT', 'error.TAB_QUERY_TIMEOUT']);
const progressStates = new Set(['running', 'stopping', 'completed', 'interrupted', 'failed', 'stopped', 'paused']);
const terminalStates = new Set(['completed', 'interrupted', 'failed', 'stopped', 'paused']);
const languageSelect = document.querySelector('#language-select');
const languageStatus = document.querySelector('#language-status');
const browserLanguage = chrome.i18n?.getUILanguage?.();
let locale = resolveLocale(null, browserLanguage);
let preferenceRead = false;
let languageRevision = 0;
let languageSavePromise = Promise.resolve();
let languageSaveFailed = false;
let viewReady = false;
let accountPresentation = message('account.loading');
let progressPresentation = message('progress.loading');
let statusPresentation = message('status.readingLocal');

function message(key, values = {}) { return { key, values }; }
function t(key, values) { return translate(locale, key, values); }

// Keep view text as local presentation data, so changing language never reruns an action or a state lookup.
function renderMessage(value) {
  if (typeof value === 'string') return value;
  if (value?.kind === 'diagnostic') return diagnosticForProgress(value.progress);
  if (value?.kind === 'progressName') return progressName(value.progress);
  if (value?.kind === 'operation') return operationStatus(value.type, value.progress, value.firstCollection);
  if (value?.kind === 'progress') return progressText(value.progress, value.collecting);
  if (value?.kind === 'cacheTime') return t('status.cachedAt', { date: formatDate(locale, value.updatedAt) });
  const values = Object.fromEntries(Object.entries(value?.values || {}).map(([key, item]) =>
    [key, item && typeof item === 'object' ? renderMessage(item) : item]));
  return t(value?.key || 'status.done', values);
}

function setAccountText(value) {
  accountPresentation = value;
  accountLabel.textContent = renderMessage(value);
}

function setProgressText(value) {
  progressPresentation = value;
  progressLabel.textContent = renderMessage(value);
}

function setStatus(value) {
  statusPresentation = value;
  statusLabel.textContent = renderMessage(value);
}

function renderLanguage() {
  document.documentElement.lang = locale;
  document.title = t('app.title');
  for (const attribute of ['data-i18n', 'data-i18n-aria-label', 'data-i18n-title']) {
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      const text = t(element.getAttribute(attribute));
      if (attribute === 'data-i18n') element.textContent = text;
      else element.setAttribute(attribute.slice('data-i18n-'.length), text);
    }
  }
  if (languageSelect) languageSelect.value = locale;
  if (languageStatus) {
    languageStatus.hidden = !languageSaveFailed;
    languageStatus.textContent = languageSaveFailed ? t('language.saveFailed') : '';
  }
  accountLabel.textContent = renderMessage(accountPresentation);
  progressLabel.textContent = renderMessage(progressPresentation);
  statusLabel.textContent = renderMessage(statusPresentation);
  // Translation preserves action availability, including recovery without a cached UID.
  if (updateIncrementalButton) updateIncrementalButton.textContent = primaryActionLabel();
}

function progressState(progress) {
  return progress?.status || progress?.state || 'unknown';
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
  const includePreference = !preferenceRead;
  const revision = languageRevision;
  const keys = includePreference ? [POPUP_VIEW_STORAGE_KEY, LANGUAGE_STORAGE_KEY] : POPUP_VIEW_STORAGE_KEY;
  const record = await withTimeout(chrome.storage.local.get(keys), 5000, 'POPUP_VIEW_TIMEOUT');
  preferenceRead = true;
  if (includePreference && revision === languageRevision) {
    locale = resolveLocale(record?.[LANGUAGE_STORAGE_KEY], browserLanguage);
    renderLanguage();
  }
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
    return t('progress.stopping');
  }
  if (verificationWaiting(progress)) return t('progress.verification');
  const state = progressState(progress);
  if (['failed', 'interrupted'].includes(state) && progress?.errorCode === 'SITE_VERIFICATION_REQUIRED' &&
      progress?.verificationRequired !== false) {
    return t('progress.updatePaused');
  }
  return state === 'unknown' || progressStates.has(state) ? t(`progress.${state}`) : state;
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
  if (!viewReady) return t('actions.loading');
  if (firstRunStarting) return t(currentAccountUid ? 'actions.startingFirst' : 'actions.confirming');
  if (verificationWaiting(lastProgress)) return t('actions.verifyResume');
  if (firstStartRetryAvailable && !currentAccountUid) return t('actions.first');
  if (lastProgress?.finalizing === true || progressState(lastProgress) === 'stopping') {
    if (summaryIsKnownEmpty || firstCollectionInThisPopup) return t('actions.saving');
    return t('actions.update');
  }
  if (isProgressRunning(lastProgress)) {
    return t(summaryIsKnownEmpty || firstCollectionInThisPopup ? 'actions.collecting' : 'actions.updating');
  }
  if (canResumeProgress(lastProgress)) return t('actions.resume');
  if (unknownEmptyView()) return t('actions.start');
  return t(firstRunWelcome ? 'actions.first' : 'actions.update');
}

function updateViewVisibility() {
  const running = isProgressRunning(lastProgress);
  const waitingForVerification = verificationWaiting(lastProgress);
  const onboarding = !viewReady || firstRunWelcome || firstRunStarting;
  if (accountCard) accountCard.hidden = onboarding;
  if (progressCard) progressCard.hidden = !viewReady || firstRunWelcome;
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
    return progress?.verificationRequired === false ? '' : t(`error.${code}`);
  }
  if (verificationWaiting(progress)) return t('error.SITE_VERIFICATION_REQUIRED');
  // Stable codes take precedence over retained diagnostics written in a previous UI language.
  if (progressErrorCodes.has(code)) return t(`error.${code}`);
  if (typeof progress.errorDetails === 'string' && progress.errorDetails) return progress.errorDetails.slice(0, 180);
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
    return t('error.SITE_NON_JSON_RESPONSE');
  }
  if (code) return code.slice(0, 100);
  return raw.slice(0, 180);
}

function operationStatus(type, progress, firstCollection = firstCollectionInThisPopup) {
  const state = progressState(progress);
  if (state === 'stopping' || progress?.finalizing === true) return t('status.saving');
  if (verificationWaiting(progress)) {
    if (type === 'EXPORT_AI_INPUT') return t('status.exportVerification');
    if (type === 'EXPORT_ACCOUNT_BACKUP') return t('status.backupVerification');
    return t('status.completeVerification');
  }
  if (isProgressRunning(progress)) {
    if (state === 'failed') return t('status.failedSaving');
    if (state === 'interrupted') return t('status.interruptedSaving');
    if (type === 'START_UPDATE' && firstCollection) {
      return t('status.firstStarted');
    }
    if (type === 'EXPORT_AI_INPUT') return t('status.exportRunning');
    if (type === 'EXPORT_ACCOUNT_BACKUP') return t('status.backupRunning');
    return t('status.started');
  }
  if (state === 'failed' || state === 'interrupted') {
    const diagnostic = diagnosticForProgress(progress);
    return t('status.unfinished', { prefix: type === 'START_UPDATE' ? '' : t('status.operationPrefix'),
      state: progressName(progress), diagnostic: diagnostic ? t('status.diagnosticSuffix', { diagnostic }) : t('status.period') });
  }
  if (state === 'stopped') return t('status.stopped');
  if (type === 'START_UPDATE' && state === 'completed') return t('status.completed');
  if (type === 'STOP_UPDATE') return t('status.noRunning');
  if (type === 'EXPORT_AI_INPUT') return t('status.exported');
  if (type === 'EXPORT_ACCOUNT_BACKUP') return t('status.backedUp');
  if (type === 'CLEAR_ACCOUNT') return t('status.cleared');
  return t('status.done');
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
  if (foregroundActions.length === 0) setStatus(message);
}

function setMutationBusy(busy) {
  mutationCount = Math.max(0, mutationCount + (busy ? 1 : -1));
  setEnabled(Boolean(currentAccountUid));
}

function clearView(message, { welcome = false, preserveFirstStartRetry = false } = {}) {
  viewReady = true;
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
  setAccountText({ key: 'account.empty' });
  contactCount.textContent = '—';
  messageCount.textContent = '—';
  setProgressText({ key: welcome ? 'progress.notCollected' : 'progress.noVisibleRecords' });
  setStatus(message);
  setEnabled(true);
}

function statusForError(error) {
  if (error === 'POPUP_VIEW_TIMEOUT') return message('error.localReadTimeout');
  if (progressErrorCodes.has(error)) return message(`error.${error}`);
  if (error === 'UNSUPPORTED_PAGE' || error === 'TAB_ID_REQUIRED' || error === 'TAB_NOT_AVAILABLE') {
    return message('error.unsupportedPage');
  }
  if (error === 'ACCOUNT_IDENTITY_UNAVAILABLE' || error === 'ACCOUNT_CONTEXT_CHANGED') {
    return message('error.identity');
  }
  if (error === 'NO_CURRENT_COLLECTION' || error === 'BULK_COLLECTOR_NOT_RUNNING') {
    return message('status.noRunning');
  }
  return message('error.operation');
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
    setProgressText(message(firstRunWelcome ? 'progress.notCollected' : 'progress.none'));
    setEnabled(Boolean(currentAccountUid));
    return;
  }
  const state = progressState(progress);
  if (terminalStates.has(state)) firstCollectionInThisPopup = false;
  setProgressText({ kind: 'progress', progress,
    collecting: state === 'running' && (summaryIsKnownEmpty || firstCollectionInThisPopup) });
  setEnabled(Boolean(currentAccountUid));
}

function progressText(progress, collecting) {
  const state = progressState(progress);
  const label = collecting ? t('progress.collecting') : progressName(progress);
  const parts = [label];
  const checked = Number.isFinite(progress.completed) ? progress.completed : progress.scannedCount;
  const total = Number.isFinite(progress.discovered) ? progress.discovered : progress.currentScopeCount;
  if (Number.isFinite(checked) && Number.isFinite(total)) parts.push(t('progress.checked', { checked, total }));
  if (Number.isFinite(progress.refreshedCount)) parts.push(t('progress.refreshed', { count: progress.refreshedCount }));
  if (Number.isFinite(progress.skippedUnchangedCount)) parts.push(t('progress.skipped', { count: progress.skippedUnchangedCount }));
  if (Number.isFinite(progress.failed)) parts.push(t('progress.failures', { count: progress.failed }));
  if (Number.isFinite(progress.newMessageCount)) parts.push(t('progress.newMessages', { count: progress.newMessageCount }));
  else if (Number.isFinite(progress.messageCount)) parts.push(t('progress.readMessages', { count: progress.messageCount }));
  const diagnostic = diagnosticForProgress(progress);
  if (diagnostic && (terminalStates.has(state) || progress.errorCode)) parts.push(diagnostic);
  return parts.join(' · ');
}

function applyState(result, { preserveFirstCollection = false } = {}) {
  if (!result?.accountUid || !result.summary) {
    clearView(statusForError(result?.error));
    return false;
  }
  currentAccountUid = result.accountUid;
  viewReady = true;
  firstRunStarting = false;
  if (!preserveFirstCollection) firstCollectionInThisPopup = false;
  legacyPopupViewConfirmedEmpty = false;
  setAccountText(result.accountUid);
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
  const diagnostic = diagnosticForProgress(progress);
  if (diagnostic) setBackgroundStatus({ kind: 'diagnostic', progress });
  else if (['failed', 'interrupted'].includes(progressState(progress))) {
    setBackgroundStatus({ kind: 'progressName', progress });
  } else if (firstRunWelcome) setBackgroundStatus(message('status.ready'));
  else setBackgroundStatus(result.updatedAt ? { kind: 'cacheTime', updatedAt: result.updatedAt } : message('status.cached'));
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
        if (quiet && currentAccountUid && !isProgressRunning(lastProgress)) setBackgroundStatus(message('status.cached'));
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
        clearView(message('status.welcome'), { welcome: true });
      } else {
        clearView(message('status.noCache'));
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
    clearView(message('status.accountChanged'));
    return;
  }
  if (view.accountUid !== requestedUid) viewEpoch++;
  applyState(view);
  setStatus(statusText || message('status.accountSwitched', { uid: view.accountUid }));
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
      if (diagnostic) setBackgroundStatus({ kind: 'diagnostic', progress });
      else if (['failed', 'interrupted'].includes(progressState(progress))) {
        setBackgroundStatus({ kind: 'progressName', progress });
      } else if (wasFirstRunWelcome &&
        (progress?.finalizing === true || progressState(progress) === 'stopping')) {
        setBackgroundStatus(message('status.saving'));
      } else if (wasFirstRunWelcome && progress && isProgressRunning(progress)) {
        setBackgroundStatus(message('status.firstStarted'));
      } else if (wasFirstRunWelcome && progressState(progress) === 'completed') {
        setBackgroundStatus(message('status.firstCompleted'));
      } else if (wasFirstRunWelcome && ['paused', 'stopped'].includes(progressState(progress))) {
        setBackgroundStatus({ kind: 'progressName', progress });
      } else if (wasFirstRunWelcome && !firstRunWelcome) {
        setBackgroundStatus(message('status.localLoaded'));
      }
      if (popupTimeoutCodes.has(statusPresentation?.key)) {
        setBackgroundStatus(message('status.accountLoaded'));
      }
    } catch {
      if (epoch === viewEpoch) clearView(message('error.identity'));
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
    setProgressText(message('actions.startingFirst'));
  }
  if (foregroundActions.length === 0 && progressTimer !== null) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  const foregroundAction = { label, accountUid: startingUid, messageType };
  foregroundActions.push(foregroundAction);
  if (mutation) setMutationBusy(true);
  setStatus(label);
  try {
    const result = await action(startingUid);
    if (epoch !== viewEpoch) return;
    if (!result?.ok) {
      if (result?.error === 'ACCOUNT_CONTEXT_CHANGED') {
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        const viewUid = result.accountUid || result.view?.accountUid || message('status.newAccount');
        await adoptLocalViewAfterSwitch(result, startingUid, message('status.accountSwitchedNoAction', { uid: viewUid }));
        return;
      }
      if (firstCollectionStart) {
        firstRunWelcome = wasFirstRunWelcome;
        firstStartRetryAvailable = wasFirstRunWelcome || wasFirstStartRetryAvailable;
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        setEnabled(Boolean(currentAccountUid));
      }
      setStatus(statusForError(result?.error));
      if (['UNSUPPORTED_PAGE', 'TAB_NOT_AVAILABLE', 'ACCOUNT_IDENTITY_UNAVAILABLE',
        'SITE_VERIFICATION_REQUIRED'].includes(result?.error)) {
        clearView(statusForError(result.error), { preserveFirstStartRetry: firstCollectionStart });
      }
      return;
    }
    const switchedDuringStart = Boolean(startingUid && result.accountUid && result.accountUid !== startingUid &&
      messageType === 'START_UPDATE');
    if (startingUid && result.accountUid && result.accountUid !== startingUid && !switchedDuringStart) {
      await adoptLocalViewAfterSwitch(result, startingUid,
        message('status.accountSwitchedNoAction', { uid: result.accountUid }));
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
      setStatus(message('status.noConfirmedAccount'));
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
    setStatus(switchedDuringStart
      ? message('status.startedCurrentAccount', { uid: result.accountUid })
      : { kind: 'operation', type: messageType, progress: latestProgress, firstCollection: firstCollectionInThisPopup });
  } catch {
    if (epoch === viewEpoch) {
      if (firstCollectionStart) {
        firstRunWelcome = wasFirstRunWelcome;
        firstStartRetryAvailable = wasFirstRunWelcome || wasFirstStartRetryAvailable;
        firstRunStarting = false;
        firstCollectionInThisPopup = false;
        setEnabled(Boolean(currentAccountUid));
      }
      setStatus(statusForError('POPUP_REQUEST_TIMEOUT'));
    }
  } finally {
    const index = foregroundActions.lastIndexOf(foregroundAction);
    if (index >= 0) foregroundActions.splice(index, 1);
    if (currentAccountUid && foregroundActions.length > 0) {
      setStatus(foregroundActions[foregroundActions.length - 1].label);
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
    return runAction(message('status.confirmingStart'),
      expectedUid => request('START_UPDATE', { mode: 'incremental' }, expectedUid), null,
      { mutation: true, messageType: 'START_UPDATE' });
  }
  if (isProgressRunning(lastProgress)) return;
  const startLabel = message(firstRunWelcome ? 'actions.startingFirst' :
    unknownEmptyView() ? 'status.starting' : 'status.updating');
  return runAction(startLabel,
    expectedUid => request('START_UPDATE', { mode: 'incremental' }, expectedUid), null,
    { mutation: true, messageType: 'START_UPDATE' });
});
document.querySelector('#update-full').addEventListener('click', () => {
  if (!currentAccountUid || isProgressRunning(lastProgress) || verificationWaiting(lastProgress)) return;
  return runAction(message('status.rereading'),
    expectedUid => request('START_UPDATE', { mode: 'full' }, expectedUid), null,
    { mutation: true, messageType: 'START_UPDATE' });
});
document.querySelector('#stop').addEventListener('click', () => runAction(message('status.stopping'),
  expectedUid => request('STOP_UPDATE', {}, expectedUid), null,
  { mutation: true, allowBusy: true, messageType: 'STOP_UPDATE' }));
document.querySelector('#export-latest').addEventListener('click', () => runAction(message('status.preparingLatest'),
  expectedUid => request('EXPORT_AI_INPUT', { scope: 'latest_update' }, expectedUid), result => {
    downloadJson(result.analysisInput, `boss-ai-latest-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_AI_INPUT' }));
document.querySelector('#export-all').addEventListener('click', () => runAction(message('status.preparingAll'),
  expectedUid => request('EXPORT_AI_INPUT', { scope: 'all' }, expectedUid), result => {
    downloadJson(result.analysisInput, `boss-ai-all-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_AI_INPUT' }));
document.querySelector('#backup').addEventListener('click', () => runAction(message('status.preparingBackup'),
  expectedUid => request('EXPORT_ACCOUNT_BACKUP', {}, expectedUid), result => {
    downloadJson(result.backup, `boss-backup-${result.accountUid}.json`);
  }, { messageType: 'EXPORT_ACCOUNT_BACKUP' }));
document.querySelector('#clear').addEventListener('click', () => {
  if (!currentAccountUid || !window.confirm(t('clear.confirm', { uid: currentAccountUid }))) return;
  runAction(message('status.clearing'), expectedUid => request('CLEAR_ACCOUNT', {}, expectedUid), result => {
    if (result.cleared) setProgressText(message('clear.progress'));
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
languageSelect?.addEventListener('change', () => {
  const preference = resolveLocale(languageSelect.value, browserLanguage);
  const revision = ++languageRevision;
  locale = preference;
  languageSaveFailed = false;
  renderLanguage();
  // Serialize preference writes, without retrying or touching account data and collection IPC.
  languageSavePromise = languageSavePromise.then(async () => {
    try {
      await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: preference });
      if (revision === languageRevision) languageSaveFailed = false;
    } catch {
      if (revision === languageRevision) languageSaveFailed = true;
    }
    if (revision === languageRevision && languageStatus) {
      languageStatus.hidden = !languageSaveFailed;
      languageStatus.textContent = languageSaveFailed ? t('language.saveFailed') : '';
    }
  });
  return languageSavePromise;
});
renderLanguage();
void refreshState().finally(scheduleProgressPoll);
window.addEventListener('unload', () => {
  if (progressTimer !== null) clearTimeout(progressTimer);
}, { once: true });
