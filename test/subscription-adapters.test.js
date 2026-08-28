import assert from 'node:assert/strict';
import test from 'node:test';

await import('../extension/adapters.js');
const adapters = globalThis.LifelineSubscriptionAdapters;

test('Codex parser only records explicit remaining values', () => {
  const result = adapters.collect('https://chatgpt.com/codex/settings/usage', `
    Codex Usage
    5 hour usage 72% remaining
    Weekly limit remaining 41%
    Credits remaining 128
  `);
  assert.equal(result.provider, 'CODEX');
  assert.equal(result.reportedStatus, 'AVAILABLE');
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_5h').remainingRatio, 0.72);
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_weekly').remainingRatio, 0.41);
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_credits').remaining, 128);
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_credits').label, '额外 Credits');
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_credits').sourceKind, 'SCOPED_DOM');
});

test('Codex parser converts explicit used percentages to remaining percentages', () => {
  const result = adapters.collect('https://chatgpt.com/codex/settings/usage', '5 hour usage 72% used');
  assert.equal(result.measurements.find((entry) => entry.key === 'codex_5h').remainingRatio, 0.28);
});

test('Cursor parser keeps two usage pools separate', () => {
  const result = adapters.collect('https://cursor.com/dashboard?tab=usage', `
    Cursor Models $12 / $100 used
    Other Models $18 / $20 used
  `);
  assert.equal(result.measurements.length, 2);
  assert.equal(result.measurements.find((entry) => entry.key === 'cursor_models').remaining, 88);
  assert.equal(result.measurements.find((entry) => entry.key === 'other_models').remaining, 2);
});

test('Gemini, Grok, and Xiaoyunque safely fall back to availability', () => {
  const gemini = adapters.collect('https://gemini.google.com/app', 'Google AI Pro Usage limits are dynamic');
  const grok = adapters.collect('https://grok.com/', 'Welcome to Grok');
  const xiaoyunque = adapters.collect('https://xyq.jianying.com/home?tab_name=home', '小云雀 帮助灵感立即成片');
  assert.ok(gemini.measurements.every((entry) => entry.kind === 'availability'));
  assert.ok(grok.measurements.every((entry) => entry.kind === 'availability'));
  assert.ok(xiaoyunque.measurements.every((entry) => entry.kind === 'availability'));
  assert.equal(grok.reportedStatus, 'AVAILABLE');
});

test('limit banners become LIMITED without inventing a numeric balance', () => {
  const result = adapters.collect('https://grok.com/', 'You have reached your usage limit. Resets later.');
  assert.equal(result.reportedStatus, 'LIMITED');
  assert.equal(result.measurements[0].kind, 'availability');
  assert.equal(result.measurements[0].remaining, null);
});

test('Xiaoyunque ignores unrelated page numbers until an exact quota component is calibrated', () => {
  const result = adapters.collect('https://xyq.jianying.com/home?tab_name=home', `
    小云雀创作中心
    活动赠送 720 积分
    已有 12 个作品
  `);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0].kind, 'availability');
  assert.equal(result.measurements[0].remaining, null);
  assert.equal(result.measurements[0].sourceKind, 'STATUS_INFERENCE');
});

test('collector only accepts quota routes and strips query or fragment data from reported URLs', () => {
  assert.equal(adapters.isSupportedQuotaPage('https://chatgpt.com/codex/settings/usage'), true);
  assert.equal(adapters.isSupportedQuotaPage('https://chatgpt.com/c/secret-conversation'), false);
  assert.equal(adapters.isSupportedQuotaPage('https://x.com/messages/secret-thread'), false);
  assert.equal(adapters.isSupportedQuotaPage('https://grok.com/secret-chat'), false);
  assert.equal(adapters.sanitizeSourceUrl('https://cursor.com/dashboard?tab=usage#quota'), 'https://cursor.com/dashboard');
});
