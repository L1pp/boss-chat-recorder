import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiAnalysisInput } from '../extension-tracker/ai-input.mjs';

const FIXED_GENERATED_AT = '2026-10-17T12:00:00.000Z';
const FIXED_GENERATED_AT_MS = Date.parse(FIXED_GENERATED_AT);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function withFixedDate(callback) {
  const NativeDate = globalThis.Date;
  class DemoDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED_GENERATED_AT_MS]));
    }

    static now() {
      return FIXED_GENERATED_AT_MS;
    }
  }

  globalThis.Date = DemoDate;
  try {
    return callback();
  } finally {
    globalThis.Date = NativeDate;
  }
}

function contact({ key, company, hrName, hrRole, jobTitle, bossId, firstObservedAt,
  lastObservedAt, complete }) {
  return [key, {
    identity: { company, hrName, hrRole, jobTitle, bossId },
    firstObservedAt,
    lastObservedAt,
    historyCoverage: {
      availableHistoryComplete: complete,
      scope: complete ? 'demo_available_history' : 'demo_partial_history',
      completeReason: complete ? 'demo_history_boundary_reached' : 'demo_page_budget_reached',
    },
  }];
}

function message({ key, id, direction, kind = 'text', text = '', sentAtISO = null,
  firstObservedAt, rawTimeLabel = null, image = false }) {
  const value = {
    identityKey: key,
    messageId: id,
    direction,
    directionEvidenceQuality: 'demo_participant_match',
    kind,
    contentText: text,
    sentAtISO,
    rawTimeLabel,
    firstObservedAt,
    lastObservedAt: firstObservedAt,
  };
  if (image) {
    value.apiBodyType = 'demo_image';
    value.rawApiMessage = {
      body: {
        type: 'demo_image',
        image: { name: '合成岗位示意图.png', mimeType: 'image/png', width: 640, height: 360 },
      },
    };
  }
  return value;
}

function refreshedResult({ runId, capturedAt, complete, pageCount, refreshReason }) {
  return {
    refreshedInRunId: runId,
    capturedAt,
    refreshReason,
    availableHistoryComplete: complete,
    scope: complete ? 'demo_available_history' : 'demo_partial_history',
    completeReason: complete ? 'demo_history_boundary_reached' : 'demo_page_budget_reached',
    pageCount,
  };
}

function makeProgress({ account, runId, startedAt, finishedAt, selectedCount,
  refreshedCount, skippedUnchangedCount, newMessageCount, refreshedBossIds,
  historyResults, noChanges = false }) {
  return {
    kind: 'api_v1',
    runId,
    runMode: 'demo_incremental',
    status: 'completed',
    startedAt,
    finishedAt,
    updatedAt: finishedAt,
    scannedCount: 2,
    selectedCount,
    refreshedCount,
    skippedUnchangedCount,
    newMessageCount,
    failed: 0,
    listBoundaryReached: true,
    availableRecordsComplete: true,
    selectedApiKeys: [...refreshedBossIds],
    refreshedApiKeys: [...refreshedBossIds],
    completedApiKeys: ['demo-hr-shared', `demo-hr-${account}-second`],
    completedKeys: Object.keys(historyResults),
    historyResults,
    ...(noChanges ? { demoNoChangeRound: true } : {}),
  };
}

function makeAccount({ account, sharedKey, otherKey, sharedCompany, sharedName,
  sharedTime, sharedObservedAt, secondTime, sharedMessageText, sharedComplete,
  sharedPageCount, runId, startedAt, finishedAt, imageMessage }) {
  const otherBossId = `demo-hr-${account}-second`;
  const contacts = Object.fromEntries([
    contact({
      key: sharedKey,
      company: sharedCompany,
      hrName: sharedName,
      hrRole: '招聘顾问',
      jobTitle: account === 'account-a' ? '客户端工程师' : '数据分析师',
      bossId: 'demo-hr-shared',
      firstObservedAt: sharedObservedAt,
      lastObservedAt: finishedAt,
      complete: sharedComplete,
    }),
    contact({
      key: otherKey,
      company: account === 'account-a' ? '示例乙' : '示例丙',
      hrName: account === 'account-a' ? '顾问乙' : '顾问丙',
      hrRole: '人才伙伴',
      jobTitle: '产品助理',
      bossId: otherBossId,
      firstObservedAt: '2026-10-12T08:00:00.000Z',
      lastObservedAt: '2026-10-12T08:03:00.000Z',
      complete: true,
    }),
  ]);

  const sharedMessages = [
    message({
      key: sharedKey,
      id: 'demo-message-shared',
      direction: 'hr',
      text: sharedMessageText,
      sentAtISO: sharedTime,
      firstObservedAt: sharedObservedAt,
    }),
    message({
      key: sharedKey,
      id: `demo-message-${account}-reply`,
      direction: 'self',
      text: account === 'account-a' ? '谢谢介绍，我想进一步了解岗位内容。' : '您好，我可以补充项目经验。',
      sentAtISO: account === 'account-a' ? '2026-10-15T09:35:00.000Z' : '2026-10-15T16:02:00.000Z',
      firstObservedAt: sharedObservedAt,
    }),
  ];
  if (imageMessage) {
    sharedMessages.push(message({
      key: sharedKey,
      id: `demo-message-${account}-image`,
      direction: 'hr',
      kind: 'attachment',
      text: '',
      sentAtISO: '2026-10-15T09:40:00.000Z',
      firstObservedAt: sharedObservedAt,
      image: true,
    }));
  }

  const oldRunId = `demo-run-${account}-previous`;
  const previousCaptureAt = '2026-10-12T08:03:00.000Z';
  const oldResults = {
    [sharedKey]: refreshedResult({
      runId: oldRunId,
      capturedAt: previousCaptureAt,
      complete: sharedComplete,
      pageCount: sharedPageCount,
      refreshReason: 'demo_previous_round',
    }),
    [otherKey]: refreshedResult({
      runId: oldRunId,
      capturedAt: previousCaptureAt,
      complete: true,
      pageCount: 1,
      refreshReason: 'demo_previous_round',
    }),
  };

  const state = {
    schemaVersion: 2,
    profileNamespace: `demo-${account}`,
    createdAt: '2026-10-12T08:00:00.000Z',
    updatedAt: finishedAt,
    contacts,
    messages: Object.fromEntries([
      ...sharedMessages.map((item, index) => [`demo-storage-${account}-shared-${index + 1}`, item]),
      [`demo-storage-${account}-other`, message({
        key: otherKey,
        id: `demo-message-${account}-other`,
        direction: 'hr',
        text: '这是另一个会话中的合成示例消息。',
        sentAtISO: secondTime,
        firstObservedAt: '2026-10-12T08:03:00.000Z',
      })],
    ]),
    unidentifiedMessages: [],
    unassignedObservations: [],
    captures: [],
    rawSources: {},
    initialRowsByKey: {},
    closingRowsByKey: {},
    listBaselineInitialized: false,
  };

  const currentResults = {
    ...oldResults,
    [sharedKey]: refreshedResult({
      runId,
      capturedAt: sharedObservedAt,
      complete: sharedComplete,
      pageCount: sharedPageCount,
      refreshReason: 'demo_message_or_history_changed',
    }),
  };
  const progress = makeProgress({
    account,
    runId,
    startedAt,
    finishedAt,
    selectedCount: 1,
    refreshedCount: 1,
    skippedUnchangedCount: 1,
    newMessageCount: sharedMessages.length,
    refreshedBossIds: ['demo-hr-shared'],
    historyResults: currentResults,
  });
  const zeroProgress = makeProgress({
    account,
    runId: `demo-run-${account}-no-change`,
    startedAt: '2026-10-17T11:55:00.000Z',
    finishedAt: '2026-10-17T11:56:00.000Z',
    selectedCount: 0,
    refreshedCount: 0,
    skippedUnchangedCount: 2,
    newMessageCount: 0,
    refreshedBossIds: [],
    historyResults: currentResults,
    noChanges: true,
  });
  const runtime = { progressByTab: { [`demo-tab-${account}`]: progress } };
  const runtimeNoChange = { progressByTab: { [`demo-tab-${account}`]: zeroProgress } };
  return { state, runtime, runtimeNoChange, progress, zeroProgress };
}

function createAccounts() {
  return {
    'account-a': makeAccount({
      account: 'account-a',
      sharedKey: 'demo-conversation-account-a-shared',
      otherKey: 'demo-conversation-account-a-other',
      sharedCompany: '示例甲',
      sharedName: '顾问甲',
      sharedTime: '2026-10-15T09:30:00.000Z',
      sharedObservedAt: '2026-10-16T09:01:00.000Z',
      secondTime: '2026-10-12T08:02:00.000Z',
      sharedMessageText: '欢迎了解示例甲的客户端岗位。',
      sharedComplete: true,
      sharedPageCount: 2,
      runId: 'demo-run-account-a-change',
      startedAt: '2026-10-16T09:00:00.000Z',
      finishedAt: '2026-10-16T09:05:00.000Z',
      imageMessage: true,
    }),
    'account-b': makeAccount({
      account: 'account-b',
      sharedKey: 'demo-conversation-account-b-shared',
      otherKey: 'demo-conversation-account-b-other',
      sharedCompany: '示例甲',
      sharedName: '顾问甲',
      sharedTime: '2026-10-16T10:12:00.000Z',
      sharedObservedAt: '2026-10-16T10:02:00.000Z',
      secondTime: '2026-10-12T08:02:00.000Z',
      sharedMessageText: '欢迎了解示例甲的数据分析岗位。',
      sharedComplete: false,
      sharedPageCount: 1,
      runId: 'demo-run-account-b-change',
      startedAt: '2026-10-16T10:00:00.000Z',
      finishedAt: '2026-10-16T10:05:00.000Z',
      imageMessage: false,
    }),
  };
}

function htmlFor(accounts) {
  const previewData = Object.fromEntries(Object.entries(accounts).map(([account, bundle]) => [account, {
    latest: bundle.latest,
    all: bundle.all,
    noChange: bundle.noChange,
  }]));
  const embedded = JSON.stringify(previewData)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local synthetic demo</title>
  <style>
    :root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; color: #172033; background: #f4f6fa; }
    body { max-width: 920px; margin: 0 auto; padding: 28px 18px 56px; }
    .notice, article { background: white; border: 1px solid #dce2eb; border-radius: 12px; padding: 16px; margin: 14px 0; }
    .notice { border-left: 5px solid #3d68c7; }
    .language-picker { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 16px; }
    select { font: inherit; border: 1px solid #aab6ca; border-radius: 8px; background: white; padding: 7px 9px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
    button { border: 1px solid #aab6ca; border-radius: 8px; background: white; padding: 9px 13px; cursor: pointer; }
    button[aria-pressed="true"] { color: white; background: #254b9b; border-color: #254b9b; }
    h1, h2, h3 { line-height: 1.25; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.15rem; margin-top: 24px; }
    h3 { font-size: 1rem; }
    .meta { color: #4d5a70; }
    .message { padding: 10px 12px; border-left: 3px solid #b7c5df; background: #f8faff; margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .media { color: #46536b; font-size: .92rem; }
  </style>
</head>
<body>
  <div class="language-picker">
    <label for="language" data-text="language">Interface language</label>
    <select id="language">
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  </div>
  <header class="notice">
    <strong data-text="heading">Synthetic demo data</strong>
    <p data-text="notice">All accounts, messages, timestamps, and image summaries are handwritten examples. No real accounts or platform records are included. This page works offline; switch accounts and export scopes below. Language changes affect the interface only; messages and export data remain in their original language.</p>
  </header>
  <nav data-label="accounts" aria-label="Choose a demo account">
    <button type="button" data-account="account-a" data-text="accountA">Job seeker A</button>
    <button type="button" data-account="account-b" data-text="accountB">Job seeker B</button>
  </nav>
  <nav data-label="scopes" aria-label="Choose an export scope">
    <button type="button" data-scope="latest" data-text="latest">This round</button>
    <button type="button" data-scope="all" data-text="all">All saved</button>
    <button type="button" data-scope="noChange" data-text="noChange">No-change round</button>
  </nav>
  <main id="preview" aria-live="polite"></main>
  <script id="demo-data" type="application/json">${embedded}</script>
  <script>
    const data = JSON.parse(document.getElementById('demo-data').textContent);
    const main = document.getElementById('preview');
    const languagePicker = document.getElementById('language');
    const translations = {
      zh: {
        title: '本地合成演示数据', heading: '合成演示数据', language: '界面语言',
        notice: '所有账号、消息、时间和图片摘要均为手写示例，不包含真实账号或平台采集记录。页面可离线打开并切换账号与导出范围。切换语言仅改变界面，消息和导出数据保留原文。',
        accounts: '选择演示账号', scopes: '选择导出范围',
        accountA: '求职账号甲', accountB: '求职账号乙',
        latest: '本轮变化', all: '全部已保存', noChange: '无变化轮次',
        latestTitle: '本轮已更新的会话', allTitle: '全部已保存的会话', noChangeTitle: '本轮没有变化',
        conversations: '会话数：', noChanges: '无变化：', yes: '是', no: '否',
        conversation: '会话 ', hrId: 'HR 标识：', historyComplete: '可用历史完整：',
        self: '求职者', hr: '招聘方', other: '其他', unknownTime: '时间未知', media: '媒体摘要：',
      },
      en: {
        title: 'Local synthetic demo', heading: 'Synthetic demo data', language: 'Interface language',
        notice: 'All accounts, messages, timestamps, and image summaries are handwritten examples. No real accounts or platform records are included. This page works offline; switch accounts and export scopes below. Language changes affect the interface only; messages and export data remain in their original language.',
        accounts: 'Choose a demo account', scopes: 'Choose an export scope',
        accountA: 'Job seeker A', accountB: 'Job seeker B',
        latest: 'This round', all: 'All saved', noChange: 'No-change round',
        latestTitle: 'Conversations updated this round', allTitle: 'All saved conversations', noChangeTitle: 'No changes this round',
        conversations: 'Conversations: ', noChanges: 'No changes: ', yes: 'Yes', no: 'No',
        conversation: 'Conversation ', hrId: 'Recruiter ID: ', historyComplete: 'Available history complete: ',
        self: 'Job seeker', hr: 'Recruiter', other: 'Other', unknownTime: 'Time unknown', media: 'Media summary: ',
      },
    };
    const browserLanguage = navigator.language || navigator.languages?.[0] || '';
    let language = /^zh(?:-|$)/i.test(browserLanguage) ? 'zh' : 'en';
    let account = 'account-a';
    let scope = 'latest';

    function t(key) {
      return translations[language][key];
    }

    function addText(parent, tag, value, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value == null ? '' : String(value);
      parent.append(node);
      return node;
    }

    function render() {
      document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
      document.title = t('title');
      languagePicker.value = language;
      document.querySelectorAll('[data-text]').forEach(node => {
        node.textContent = t(node.dataset.text);
      });
      document.querySelectorAll('[data-label]').forEach(node => {
        node.setAttribute('aria-label', t(node.dataset.label));
      });
      document.querySelectorAll('[data-account]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.account === account));
      });
      document.querySelectorAll('[data-scope]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
      });
      const input = data[account][scope];
      const fragment = document.createDocumentFragment();
      addText(fragment, 'h1', t(account === 'account-a' ? 'accountA' : 'accountB') + ' · ' + t(scope + 'Title'));
      addText(fragment, 'p', t('conversations') + input.scope.conversationCount + ' · ' + t('noChanges') + t(input.scope.noChanges ? 'yes' : 'no'), 'meta');
      input.conversations.forEach(conversation => {
        const card = document.createElement('article');
        addText(card, 'h2', conversation.identity.company + ' · ' + conversation.identity.jobTitle);
        addText(card, 'p', conversation.identity.hrName + ' · ' + conversation.identity.hrRole + ' · ' + t('conversation') + conversation.conversationId, 'meta');
        addText(card, 'p', t('hrId') + conversation.bossId + ' · ' + t('historyComplete') + t(conversation.historyCoverage.availableHistoryComplete ? 'yes' : 'no'), 'meta');
        conversation.messages.forEach(message => {
          const label = t(message.direction === 'self' ? 'self' : message.direction === 'hr' ? 'hr' : 'other');
          const when = message.sentAt || message.rawTimeLabel || t('unknownTime');
          addText(card, 'p', label + ' · ' + when + ' · ' + message.text, 'message');
          if (message.media) addText(card, 'p', t('media') + JSON.stringify(message.media), 'media');
        });
        fragment.append(card);
      });
      main.replaceChildren(fragment);
    }

    languagePicker.addEventListener('change', () => {
      language = languagePicker.value === 'en' ? 'en' : 'zh';
      render();
    });
    document.querySelectorAll('[data-account]').forEach(button => button.addEventListener('click', () => {
      account = button.dataset.account;
      render();
    }));
    document.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', () => {
      scope = button.dataset.scope;
      render();
    }));
    render();
  </script>
</body>
</html>
`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function generateDemo(outputDirectory = path.resolve(scriptDirectory, '../examples')) {
  const accounts = createAccounts();
  const prepared = withFixedDate(() => Object.fromEntries(Object.entries(accounts).map(([account, bundle]) => {
    const latest = createAiAnalysisInput(bundle.state, { runtime: bundle.runtime });
    const all = createAiAnalysisInput(bundle.state, { scope: 'all', runtime: bundle.runtime });
    const noChange = createAiAnalysisInput(bundle.state, { runtime: bundle.runtimeNoChange });
    return [account, { ...bundle, latest, all, noChange }];
  })));

  for (const [account, bundle] of Object.entries(prepared)) {
    const directory = path.join(outputDirectory, 'demo-data', account);
    await writeJson(path.join(directory, 'state.json'), bundle.state);
    await writeJson(path.join(directory, 'runtime.json'), bundle.runtime);
    await writeJson(path.join(directory, 'runtime-no-change.json'), bundle.runtimeNoChange);
    await writeJson(path.join(directory, 'ai-export-latest.json'), bundle.latest);
    await writeJson(path.join(directory, 'ai-export-all.json'), bundle.all);
    await writeJson(path.join(directory, 'ai-export-no-change.json'), bundle.noChange);
  }

  await writeFile(path.join(outputDirectory, 'index.html'), htmlFor(prepared), 'utf8');
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(scriptDirectory, '../examples');
  await generateDemo(outputDirectory);
  console.log(`合成演示数据已生成：${outputDirectory}`);
}
