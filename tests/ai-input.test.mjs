import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiAnalysisInput } from '../extension-tracker/ai-input.mjs';

const keyA = JSON.stringify(['甲公司', '张女士', 'HR']);
const keyB = JSON.stringify(['乙公司', '李先生', '招聘经理']);
function fixture() {
  return {
    schemaVersion: 2, profileNamespace: 'fixture',
    contacts: {
      [keyA]: { identity: { company: '甲公司', hrName: '张女士', hrRole: 'HR', bossId: 'boss-a', jobTitle: 'Python开发' },
        progressLabel: '规则机器结论', firstObservedAt: '2026-10-10T08:00:00.000Z',
        historyCoverage: { availableHistoryComplete: true, scope: 'all_history_pages_currently_returned_by_site' },
        manualUpdates: [{ channel: '微信', date: '2026-10-14', note: '已电话确认地点', confirmed: true }] },
      [keyB]: { identity: { company: '乙公司', hrName: '李先生', bossId: 'boss-b' } },
    },
    messages: {
      last: { identityKey: keyA, messageId: 'a-new', direction: 'hr', kind: 'text', text: '明天下午三点可以面试吗？',
        sentAtISO: '2026-10-14T08:04:00.000Z', rawTimeLabel: '1791965040000',
        firstObservedAt: '2026-10-14T08:05:10.000Z' },
      first: { identityKey: keyA, messageId: 'a-old', direction: 'self', kind: 'text', text: '您好，对岗位感兴趣',
        sentAtISO: '2026-10-10T07:00:00.000Z', firstObservedAt: '2026-10-14T08:05:09.000Z' },
      other: { identityKey: keyB, messageId: 'b-old', direction: 'hr', kind: 'text', text: '您好',
        rawTimeLabel: '昨天 11:01', firstObservedAt: '2026-10-13T08:05:00.000Z' },
    },
    rawSources: {}, captures: [], unidentifiedMessages: [],
  };
}
function round(overrides = {}) {
  return {
    kind: 'api_v1', runId: 'round-new', runMode: 'incremental', status: 'completed',
    startedAt: '2026-10-14T08:05:00.000Z', finishedAt: '2026-10-14T08:06:00.000Z',
    scannedCount: 2, selectedCount: 1, refreshedCount: 1, skippedUnchangedCount: 1,
    newMessageCount: 2, listBoundaryReached: true, availableRecordsComplete: true,
    selectedApiKeys: ['boss-a'], refreshedApiKeys: ['boss-a'],
    // completedKeys includes unchanged B; its history result belongs to an old round.
    completedKeys: [keyA, keyB], completedApiKeys: ['boss-a', 'boss-b'],
    historyResults: {
      [keyA]: { refreshedInRunId: 'round-new', availableHistoryComplete: true, pageCount: 1,
        capturedAt: '2026-10-14T08:05:10.000Z' },
      [keyB]: { refreshedInRunId: 'round-old', availableHistoryComplete: true, pageCount: 1 },
    },
    ...overrides,
  };
}

test('latest update selects changed conversation and keeps its full chronological context', () => {
  const state = fixture();
  state.messages.notice = { identityKey: keyA, messageId: 'platform-notice', direction: 'hr',
    kind: 'platform_card', text: '对方已同意，您的附件简历已发送给对方',
    sentAtISO: '2026-10-09T07:00:00.000Z' };
  const input = createAiAnalysisInput(state, { progress: round() });
  assert.equal(input.scope.effective, 'latest_update');
  assert.equal(input.conversations.length, 1);
  const conversation = input.conversations[0];
  assert.equal(conversation.conversationId, keyA);
  assert.deepEqual(conversation.messages.map(message => message.messageId), ['platform-notice', 'a-old', 'a-new']);
  assert.equal(conversation.firstAvailableMessageAt, '2026-10-10T07:00:00.000Z');
  assert.equal(conversation.firstAvailableSender, 'self');
  assert.equal(conversation.manualUpdates[0].note, '已电话确认地点');
  assert.equal(conversation.firstAvailableMessageId, 'a-old');
  assert.equal(conversation.messages[1].firstObservedInLatestUpdate, true);
  assert.ok(input.instructions.some(instruction => instruction.includes('其中可能是旧历史')));
  assert.ok(!JSON.stringify(input).includes('规则机器结论'));
  assert.equal(Object.hasOwn(conversation, 'progressLabel'), false);
  assert.equal(Object.hasOwn(conversation, 'status'), false);
});

test('normal zero-change update stays empty even though previous results and completed keys remain', () => {
  const previous = round();
  const input = createAiAnalysisInput(fixture(), { progress: round({
    runId: 'zero-round', selectedCount: 0, refreshedCount: 0, skippedUnchangedCount: 2,
    selectedApiKeys: [], refreshedApiKeys: [], newMessageCount: 0,
    historyResults: previous.historyResults,
  }) });
  assert.equal(input.scope.noChanges, true);
  assert.equal(input.scope.effective, 'latest_update');
  assert.deepEqual(input.conversations, []);
});

test('all scope and initial export include local facts without inventing send dates', () => {
  const initial = createAiAnalysisInput(fixture());
  assert.equal(initial.scope.effective, 'all_saved_conversations');
  assert.equal(initial.scope.updateRecordAvailable, false);
  assert.equal(initial.conversations.length, 2);
  const all = createAiAnalysisInput(fixture(), { scope: 'all', progress: round() });
  assert.equal(all.conversations.length, 2);
  const undated = all.conversations.find(conversation => conversation.conversationId === keyB).messages[0];
  assert.equal(undated.sentAt, null);
  assert.equal(undated.rawTimeLabel, '昨天 11:01');
  assert.equal(undated.firstObservedInLatestUpdate, false);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(all)));
});

test('persisted partial pages are included but merely selected unread contacts are not called refreshed', () => {
  const state = fixture();
  state.captures = [{ sessionId: 'partial-run', identityKey: keyA }];
  const input = createAiAnalysisInput(state, { progress: round({
    runId: 'partial-run', status: 'failed', selectedCount: 2, refreshedCount: 0,
    selectedApiKeys: ['boss-a', 'boss-b'], refreshedApiKeys: [], failed: 1,
    historyResults: { [keyB]: { refreshedInRunId: 'partial-run', pageCount: 0, availableHistoryComplete: false } },
  }) });
  assert.deepEqual(input.conversations.map(conversation => conversation.conversationId), [keyA]);
  assert.equal(input.scope.noChanges, false);
  assert.equal(input.latestUpdate.failedCount, 1);
});

test('runtime chooses latest round and media exports summaries without raw tokens or machine conclusions', () => {
  const state = fixture();
  state.messages.media = { identityKey: keyA, messageId: 'file-1', direction: 'hr', kind: 'attachment',
    rawApiMessage: { mid: 'file-1', time: 1791965040000, body: { type: 3,
      file: { fileName: '面试地点.pdf', size: 1200, url: 'https://example.test/?token=private' } } } };
  const input = createAiAnalysisInput(state, { runtime: { progressByTab: {
    7: round({ updatedAt: '2026-10-14T08:06:00.000Z' }),
    8: round({ runId: 'old', updatedAt: '2026-10-13T08:06:00.000Z' }),
  } } });
  assert.equal(input.latestUpdate.runId, 'round-new');
  const file = input.conversations[0].messages.find(message => message.messageId === 'file-1');
  assert.ok(file.media.details.some(item => item.value === '面试地点.pdf'));
  assert.equal(file.media.contentAvailable, false);
  assert.ok(!JSON.stringify(input).includes('token=private'));
});

test('a paused round exports safe response metadata without response bodies or URL query credentials', () => {
  const input = createAiAnalysisInput(fixture(), { progress: round({
    status: 'interrupted', active: false, availableRecordsComplete: false,
    error: '网站返回了网页，采集已暂停。', errorCode: 'SITE_NON_JSON_RESPONSE',
    errorDetails: { endpoint: '/wapi/zpchat/geek/historyMsg?token=private-demo',
      finalPath: 'https://example.test/web/user/?token=private-demo',
      httpStatus: 200, contentType: 'text/html', redirected: true, responseKind: 'html',
      body: 'private-demo-page-body', accountUid: 'demo-user-a' },
  }) });
  assert.equal(input.latestUpdate.status, 'interrupted');
  assert.equal(input.latestUpdate.errorCode, 'SITE_NON_JSON_RESPONSE');
  assert.equal(input.latestUpdate.errorDetails.endpoint, '/wapi/zpchat/geek/historyMsg');
  assert.equal(input.latestUpdate.errorDetails.finalPath, '/web/user/');
  assert.equal(input.scope.noChanges, false);
  assert.ok(!JSON.stringify(input).includes('token=private-demo'));
  assert.ok(!JSON.stringify(input).includes('private-demo-page-body'));
  assert.ok(!JSON.stringify(input).includes('demo-user-a'));
});
