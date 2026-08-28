import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the shared task editor allows empty acceptance criteria and test commands', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['editCriteria', 'editCommands']) {
    const field = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(field, `missing textarea #${id}`);
    assert.equal(/\brequired\b/.test(field), false, `#${id} must remain optional for PLANNED drafts`);
  }
});

test('the shared task editor exposes an optional issue reference', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['editIssue']) {
    const field = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(field, `missing input #${id}`);
    assert.equal(/\brequired\b/.test(field), false, `#${id} must remain optional`);
  }
});

test('task forms expose star and scheduled date controls and the board exposes a star filter', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['editStarred']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*type="checkbox"[^>]*>`));
  }
  for (const id of ['editScheduledFor']) {
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
  for (const id of ['editDependencies']) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*multiple[^>]*>`));
  }
  for (const id of ['editParallelPolicy']) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*>`));
  }
  assert.match(app, /dependsOnTaskIds: selectedOptionValues/);
  assert.match(app, /parallelPolicy: elements\.editParallelPolicy\.value/);
  assert.match(app, /class="parallel-slot"/);
  assert.match(app, /taskDependenciesSatisfied/);
});

test('topbar and project detail task actions reuse one editor and one server-normalized project snapshot', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.equal((html.match(/id="taskEditorForm"/g) ?? []).length, 1);
  assert.match(html, /id="taskLauncherForm"/);
  assert.doesNotMatch(html, /id="workItemForm"/);
  assert.match(app, /taskLauncherForm\.addEventListener\('submit', openGlobalTaskCreator\)/);
  assert.match(app, /addDetailTask\.addEventListener\('click', openTaskCreator\)/);
  assert.doesNotMatch(app, /function recommendationDefaults|function inferKind/);

  const refresh = app.match(/async function refresh\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(refresh, /api\('\/api\/dashboard'\)/);
  assert.doesNotMatch(refresh, /api\('\/api\/projects'\)/);
  assert.match(refresh, /state\.projects = state\.dashboard\.projects/);
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
  assert.match(app, /data-current-phase="true"/);
  assert.match(app, /currentPhase\.offsetLeft/);
  const filterHandler = app.match(/elements\.boardFilters\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.match(filterHandler, /applyBoardFilter\(\);/);
  assert.doesNotMatch(filterHandler, /renderBoard\(\);/);
  const viewHandler = app.match(/elements\.detailControls\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.match(viewHandler, /renderBoard\(\);/);
});

test('detail card view uses a wider five-column grid without vertical overflow', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(styles, /\.detail-task-list\.view-card\s*\{[\s\S]*?grid-template-columns: repeat\(5, minmax\(230px, 280px\)\);[\s\S]*?grid-auto-rows: 228px;[\s\S]*?gap: var\(--space-2\);/);
  assert.match(styles, /\.detail-task\.card\s*\{[\s\S]*?width: 100%;[\s\S]*?height: 228px;[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?border-radius: var\(--radius-md\);/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.detail-task\.card, \.task-drop-placeholder\.card \{ width: 100%; \}/);
  assert.match(styles, /\.detail-task\.card\s*\{[\s\S]*?overflow: hidden;/);
  assert.match(styles, /grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.detail-task\.card \.detail-task-content\s*\{[\s\S]*?grid-template-rows: auto auto auto minmax\(0, 1fr\) auto;/);
  assert.match(styles, /\.detail-task\.card \.completion-line\s*\{[\s\S]*?display: none;/);
  assert.match(styles, /\.detail-task\.card \.task-meta\s*\{[\s\S]*?max-height: 50px;[\s\S]*?overflow: hidden;/);
  assert.match(app, /nearestTooltipEdge\(anchorRect, pointer\)/);
  assert.match(app, /resolveTooltipPlacement\(anchorRect, tooltipRect, preferredDirection, gap\)/);
  assert.match(app, /left: Math\.abs\(pointer\.x - rect\.left\)[\s\S]*?bottom: Math\.abs\(rect\.bottom - pointer\.y\)/);
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
  assert.match(app, /actor === 'luna_worker'/);
  assert.match(app, /Luna Worker/);
  assert.match(app, /recommendation\.validationProfile/);
});

test('historical routing calibration reaches recommendations, cards, filters and task details', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function effectiveTaskRouting\(task\)/);
  assert.match(app, /decision\.recommendedModelRef/);
  assert.match(app, /decision\.recommendationSource === 'HISTORY_CALIBRATED'/);
  assert.match(app, /HISTORY_CALIBRATED_MODEL: '历史表现推荐模型'/);
  assert.match(app, /const routing = effectiveTaskRouting\(item\)/);
  assert.match(app, /const compute = effectiveTaskRouting\(item\)\.compute/);
  assert.match(app, /推荐执行/);
  assert.match(app, /历史结果校准/);
});

test('overview and detail consume the API-derived phase and project health state', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /groupPhases\(projectItems, project\.phases\)/);
  assert.match(app, /phase\.computedStatus === 'COMPLETED'/);
  assert.match(app, /phaseStatusView\(phase\.computedStatus\)/);
  assert.match(app, /projectHealthView\(dashboardProject\.health/);
  assert.match(app, /task\.decision\?\.recommendedModelRef/);
});

test('dispatch explanation can undo cancellation and resume deferred work', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-reverse-change=/);
  assert.match(app, /change\.reversalAction === 'RESUME'/);
  assert.match(app, /status: 'PLANNED'/);
  assert.match(app, /work_item\.deferred/);
  assert.match(app, /重新排入近期/);
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
