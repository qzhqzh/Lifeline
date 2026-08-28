import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home links to a compact subscription summary without changing the project board', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="subscriptionSummaryLink" href="\/subscriptions\.html"/);
  assert.match(html, /id="portfolioBoard"/);
  assert.match(app, /\/api\/subscriptions\/summary/);
  assert.match(app, /window\.setInterval\(loadSubscriptionSummary, 10_000\)/);
  assert.doesNotMatch(app, /totalRemainingPercentage|combinedBalance/);
});

test('subscription page exposes six-account controls, freshness, filters, and 90-day history', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL('../public/subscriptions.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/subscriptions.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/subscriptions.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /六个账号，各自说真话/);
  assert.match(html, /data-status="LOW"/);
  assert.match(html, /data-status="LIMITED"/);
  assert.match(html, /data-status="STALE"/);
  assert.match(html, /data-window="90d"/);
  assert.match(app, /data-edit-alias/);
  assert.match(app, /data-pair-account/);
  assert.match(app, /打开额度页并同步/);
  assert.match(app, /已配对，但尚未收到额度页上报/);
  assert.match(app, /collectorStateLabel/);
  assert.match(app, /数值待校准/);
  assert.match(app, /measurementSourceLabel/);
  assert.match(app, /entry\.displayable !== false/);
  assert.match(app, /state\.countdown = 10/);
  assert.match(app, /window\.sessionStorage\.getItem\('lifelineOwnerToken'\)/);
  assert.match(app, /具有 schedule:write 权限的 Lifeline 管理令牌/);
  assert.match(app, /Authorization: `Bearer \$\{state\.ownerToken\}`/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});
