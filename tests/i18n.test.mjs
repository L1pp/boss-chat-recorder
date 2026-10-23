import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_STORAGE_KEY, MESSAGE_KEYS, PROGRESS_ERROR_CODES, normalizeLocale,
  resolveLocale, translate, formatDate } from '../extension-tracker/i18n.mjs';

test('locale selection adapts Chinese browser languages and falls back to English, with manual preference first', () => {
  for (const value of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh_CN']) {
    assert.equal(normalizeLocale(value), 'zh-CN');
  }
  for (const value of [undefined, null, '', 'fr-FR', 'de', 'en', 'en-US', 'EN-gb', 'en_AU']) {
    assert.equal(normalizeLocale(value), 'en');
  }
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('unsupported', 'en-US'), 'en');
  assert.equal(resolveLocale(undefined, 'fr-FR'), 'en');
  assert.equal(LANGUAGE_STORAGE_KEY, 'bossReadonlyTracker.uiLanguage.v1');
});

test('Chinese and English cover UI messages and placeholders without treating substitutions as HTML or new templates', () => {
  for (const key of MESSAGE_KEYS) {
    assert.notEqual(translate('zh-CN', key), key, key);
    assert.notEqual(translate('en', key), key, key);
    assert.deepEqual([...translate('zh-CN', key).matchAll(/\{([a-zA-Z]+)\}/gu)].map(match => match[1]).sort(),
      [...translate('en', key).matchAll(/\{([a-zA-Z]+)\}/gu)].map(match => match[1]).sort(), key);
    if (!['language.label', 'guide.openChat'].includes(key)) {
      assert.doesNotMatch(translate('en', key), /\p{Script=Han}/u, `English translation missing for ${key}`);
    }
  }
  assert.equal(translate('en', 'progress.checked', { checked: 3, total: 8 }), 'Checked 3/8');
  assert.equal(translate('zh-CN', 'status.accountSwitched', { uid: '<fake>{date}' }), '本地记录账号已切换为 <fake>{date}。');
  assert.equal(translate('en', 'clear.confirm', { uid: '$& account' }).includes('$& account'), true);
  assert.equal(translate('fr', 'actions.first'), 'Start first collection');
  assert.equal(PROGRESS_ERROR_CODES.includes('ARCHIVE_DECRYPT_FAILED'), true);
  assert.match(translate('en', 'error.SITE_VERIFICATION_REQUIRED'), /manual verification/u);
});

test('cached timestamps use the selected locale and retain an invalid diagnostic value', () => {
  const timestamp = '2026-10-17T12:00:00.000Z';
  assert.equal(formatDate('en', timestamp), new Date(timestamp).toLocaleString('en'));
  assert.equal(formatDate('zh-CN', timestamp), new Date(timestamp).toLocaleString('zh-CN'));
  assert.equal(formatDate('en', 'invalid timestamp'), 'invalid timestamp');
});
