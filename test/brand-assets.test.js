import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

test('topbar uses the lightweight Lifeline logo and a real favicon', async () => {
  const [html, styles, logo, favicon] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    stat(new URL('../public/assets/lifeline-logo.webp', import.meta.url)),
    stat(new URL('../public/assets/lifeline-logo-64.png', import.meta.url))
  ]);

  assert.match(html, /<img class="brand-mark" src="\/assets\/lifeline-logo\.webp" alt="" width="36" height="36" \/>/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\/assets\/lifeline-logo-64\.png" \/>/);
  assert.match(styles, /\.brand-mark \{[\s\S]*?object-fit: contain;/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.brand-mark \{ width: 32px; height: 32px;/);
  assert.ok(logo.size < 20_000, `topbar logo should remain lightweight, got ${logo.size} bytes`);
  assert.ok(favicon.size < 10_000, `favicon should remain lightweight, got ${favicon.size} bytes`);
  assert.doesNotMatch(html, /three(?:\.module)?\.js|WebGLRenderer/);
});

test('homepage embeds the interactive 3D emblem beside the headline', async () => {
  const [html, styles, sceneHtml, sceneScript] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/brand/lifeline-3d/index.html', import.meta.url), 'utf8'),
    stat(new URL('../public/brand/lifeline-3d/assets/emblem.js', import.meta.url))
  ]);

  assert.match(html, /class="brand-3d"[\s\S]*?<iframe[\s\S]*?src="\/brand\/lifeline-3d\/index\.html\?embed=1"/);
  assert.match(html, /class="brand-3d-fallback" src="\/assets\/lifeline-logo\.webp"/);
  assert.match(styles, /\.brand-3d \{[\s\S]*?width: 320px;[\s\S]*?height: 190px;/);
  assert.match(styles, /\.brand-3d \{[\s\S]*?background: transparent;/);
  assert.doesNotMatch(html, /实时 3D|拖动查看/);
  assert.match(sceneHtml, /\.\/assets\/emblem\.js/);
  assert.match(sceneHtml, /\.\/fallback-logo\.webp/);
  assert.ok(sceneScript.size > 100_000, 'embedded scene must contain the real Three.js runtime, not a static poster');
});

test('global creation actions sit before control-plane health in the compact topbar', async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  const topbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.ok(topbar.indexOf('id="seedDemo"') < topbar.indexOf('id="health"'));
  assert.ok(topbar.indexOf('id="openCreationDrawer"') < topbar.indexOf('id="health"'));
  assert.equal((html.match(/id="seedDemo"/g) ?? []).length, 1);
  assert.equal((html.match(/id="openCreationDrawer"/g) ?? []).length, 1);
  assert.match(styles, /\.topbar \{[\s\S]*?min-height: 60px;/);
  assert.match(styles, /\.topbar-button \{ min-height: 32px;/);
});
