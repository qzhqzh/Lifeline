import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function uiSources() {
  const [html, app, styles] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  return { html, app, styles };
}

test('first screen exposes autonomous capacity, recommendations, and a collapsed trajectory', async () => {
  const { html, app } = await uiSources();
  for (const label of ['正在执行', '下一批', '待复核', '停滞项目', '剩余执行槽']) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /下一批 · 高算力/);
  assert.match(app, /下一批 · 低算力/);
  assert.match(app, /decisionReasonSummary\(decision\.reasonCodes\)/);
  assert.match(html, /<details class="trajectory-disclosure" id="trajectoryDisclosure">/);
  assert.doesNotMatch(html, /<details class="trajectory-disclosure" id="trajectoryDisclosure" open>/);
  assert.match(app, /change\.reversalAction === 'REORDER' \? '撤销重排'/);
  assert.match(app, /orderedTaskIds: change\.reversalOrder/);
  assert.match(app, /status: item\.effectiveStatus \?\? item\.status/);
});

test('keyed refresh preserves fixed lanes, scroll, focus, drag state, and current-phase centering', async () => {
  const { app, styles } = await uiSources();
  assert.match(app, /boardRowSignatures: new Map\(\)/);
  assert.match(app, /state\.boardRowSignatures\.get\(project\.id\) !== markup/);
  assert.match(app, /captureBoardScrollPositions\(\)/);
  assert.match(app, /restoreBoardScrollPositions\(\)/);
  assert.match(app, /captureBoardFocus\(\)/);
  assert.match(app, /restoreBoardFocus\(focusSnapshot\)/);
  assert.match(app, /if \(state\.draggedTaskId && elements\.board\.children\.length > 0\) return/);
  assert.match(app, /currentPhase\.offsetLeft/);
  assert.match(styles, /@media \(min-width: 721px\)[\s\S]*?\.project-row \{ height: 224px; \}/);
  assert.match(styles, /\.board-scroll \{[\s\S]*?max-height: min\(70vh, 760px\);[\s\S]*?overflow-y: auto/);
});

test('detail cards and rich tooltip follow the required responsive and motion contracts', async () => {
  const { app, styles } = await uiSources();
  assert.match(styles, /\.detail-task-list\.view-card \{[\s\S]*?repeat\(5, minmax\(230px, 280px\)\)/);
  assert.match(styles, /@media \(max-width: 1420px\)[\s\S]*?repeat\(4,/);
  assert.match(styles, /@media \(max-width: 940px\)[\s\S]*?repeat\(2,/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.detail-task\.card \{[\s\S]*?height: 228px;[\s\S]*?overflow: hidden/);
  assert.match(app, /nearestTooltipEdge\(anchorRect, pointer\)/);
  assert.match(app, /resolveTooltipPlacement\(anchorRect, tooltipRect, preferredDirection, gap\)/);
  assert.match(styles, /body\.task-dragging \.task-tooltip \{ display: none !important; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /transition:[^;]*(?:[2-9]\d{2}|\d{4,})ms/);
});
