import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Manifest V3 collector has narrow permissions and never requests cookies or request interception', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('webRequest'));
  assert.ok(manifest.host_permissions.includes('https://xyq.jianying.com/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
  assert.ok(!manifest.host_permissions.some((pattern) => /^http:\/\/192\.168\./.test(pattern)));
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*']);
  assert.ok(manifest.content_scripts[0].matches.every((pattern) => !pattern.endsWith('/*')));
});

test('collector only runs on open pages and resamples every five minutes', async () => {
  const [content, background, popup, popupHtml] = await Promise.all([
    readFile(new URL('../extension/content.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/popup.html', import.meta.url), 'utf8')
  ]);
  assert.match(content, /MutationObserver/);
  assert.match(content, /5 \* 60 \* 1000/);
  assert.doesNotMatch(content + background, /chrome\.tabs|chrome\.cookies|webRequest/);
  assert.match(background, /Authorization: `Bearer \$\{connection\.collectorToken\}`/);
  assert.match(popup, /isPrivateHost/);
  assert.match(popup, /chrome\.permissions\.request\(\{ origins:/);
  assert.match(popup, /未授权访问这个 Lifeline 地址；连接未保存/);
  assert.match(popup, /\/api\/health/);
  assert.match(popup, /服务不可达/);
  assert.match(background, /updateTelemetry/);
  assert.match(background, /最近一次额度上报成功/);
  assert.match(content + background, /sanitizeSourceUrl/);
  assert.doesNotMatch(content, /document\.body\?\.innerText/);
  assert.match(content, /QUOTA_COMPONENT_NOT_FOUND/);
  assert.match(content, /XIAOYUNQUE: \['\[data-testid\*="credit"\]'/);
  assert.doesNotMatch(content, /GEMINI: \[[^\n]*'main'/);
  assert.match(popupHtml, /value="http:\/\/127\.0\.0\.1:8019"/);
  assert.match(popupHtml, /<script type="module" src="popup\.js"><\/script>/);
});

test('collector revocation keeps the local connection when the server request fails', async () => {
  const popup = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /if \(!response\.ok && response\.status !== 404\)/);
  assert.match(popup, /Authorization: `Bearer \$\{connection\.collectorToken\}`/);
  assert.match(popup, /撤销失败，连接已保留/);
  assert.doesNotMatch(popup, /method: 'DELETE' \}\)\.catch\(\(\) => undefined\)/);
});
