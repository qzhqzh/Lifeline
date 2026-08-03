import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('task drafts allow empty acceptance criteria and test commands in both drawers', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['criteria', 'commands', 'editCriteria', 'editCommands']) {
    const field = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(field, `missing textarea #${id}`);
    assert.equal(/\brequired\b/.test(field), false, `#${id} must remain optional for PLANNED drafts`);
  }
});

test('task creation and editing expose an optional issue reference', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['issue', 'editIssue']) {
    const field = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(field, `missing input #${id}`);
    assert.equal(/\brequired\b/.test(field), false, `#${id} must remain optional`);
  }
});

test('task forms expose star and scheduled date controls and the board exposes a star filter', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['starred', 'editStarred']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*type="checkbox"[^>]*>`));
  }
  for (const id of ['scheduledFor', 'editScheduledFor']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*type="date"[^>]*>`));
  }
  assert.match(html, /data-filter="starred"/);
});

test('project detail exposes keyboard reorder, phase move preview, and undo feedback', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="phaseMoveHint"/);
  assert.match(app, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(app, /event\.altKey/);
  assert.match(app, /label: '撤销'/);
  assert.match(app, /label: '撤销移动'/);
});

test('task forms expose dependency and parallel scheduling without adding a third hierarchy level', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  for (const id of ['createDependencies', 'editDependencies']) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*multiple[^>]*>`));
  }
  for (const id of ['createParallelPolicy', 'editParallelPolicy']) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*>`));
  }
  assert.match(app, /dependsOnTaskIds: selectedOptionValues/);
  assert.match(app, /parallelPolicy: elements\.(create|edit)ParallelPolicy\.value/);
  assert.match(app, /class="parallel-slot"/);
  assert.match(app, /taskDependenciesSatisfied/);
});

test('project detail supports inline Phase editing and unobtrusive lock and Issue hints', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-phase-edit-field="title"/);
  assert.match(app, /data-phase-edit-field="goal"/);
  assert.match(app, /startPhaseInlineEdit/);
  assert.match(app, /\/api\/phases\/\$\{encodeURIComponent\(phase\.id\)\}/);
  assert.match(app, /class="task-lock-indicator"/);
  assert.match(app, /待关联 Issue/);
  assert.doesNotMatch(app, /⌑ 已锁定/);
});

test('board filters keep lane DOM and horizontal scroll stable', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /boardScrollPositions: new Map\(\)/);
  assert.match(app, /data-project-track=/);
  assert.match(app, /function applyBoardFilter\(\)/);
  assert.match(app, /function restoreBoardScrollPositions\(\)/);
  const filterHandler = app.match(/elements\.boardFilters\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.match(filterHandler, /applyBoardFilter\(\);/);
  assert.doesNotMatch(filterHandler, /renderBoard\(\);/);
  const viewHandler = app.match(/elements\.detailControls\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.match(viewHandler, /renderBoard\(\);/);
});

test('task star actions use a compact top-right icon and titles clamp to two lines', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(app, /function renderStarControl\(task, editable\)/);
  assert.match(app, /class="star-toggle\$\{active/);
  assert.match(app, /aria-label="\$\{label\}" title="\$\{label\}"/);
  assert.doesNotMatch(app, /button class="button quiet compact star-toggle/);
  assert.match(app, /class="task-title" title="\$\{escapeHtml\((task|item)\.title\)\}"/);
  assert.match(styles, /\.task-title-row \.task-title[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.task-title-controls[\s\S]*?flex: 0 0 auto/);
});

test('routing labels expose Luna Worker and validation profiles', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /recommendation\.executor === 'luna_worker'/);
  assert.match(app, /Luna Worker/);
  assert.match(app, /recommendation\.validationProfile/);
});

test('home replaces Mock Run replay with a stable real-result trajectory', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="trajectory"/);
  assert.match(html, /data-trajectory-window="24h"/);
  assert.match(html, /data-trajectory-window="7d"/);
  assert.match(html, /data-trajectory-window="30d"/);
  assert.match(html, /id="trajectoryDrawer"/);
  assert.doesNotMatch(html, /执行工作台|运行回放|id="timeline"|id="runStatus"/);
  assert.match(app, /\/api\/trajectory\?window=/);
  assert.match(app, /function assignTrajectoryLanes/);
  assert.match(app, /未记录推进/);
  assert.match(app, /lifeline_submit_completion/);
  assert.match(app, /NOT_APPLICABLE: '不适用，需重新推进'/);
  assert.doesNotMatch(app, /\/api\/work-items\/\$\{encodeURIComponent\(workItemId\)\}\/queue/);
  assert.doesNotMatch(app, /evidenceScore/);
  assert.match(styles, /\.trajectory-board\s*\{[^}]*min-height:/);
  assert.match(styles, /\.trajectory-project\s*\{[^}]*grid-template-columns:/);
  assert.doesNotMatch(styles, /\.board-scroll\s*\{[^}]*max-height:\s*none/);
});
