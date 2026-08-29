import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LifelineService } from '../src/service.js';
import { JsonStore } from '../src/store.js';
import {
  MAX_CELL_PREVIEW,
  buildClientBoard,
  canClientMoveTask,
  clientMoveTargets,
  currentClientPhase,
  filterClientTasks,
  groupCompletedTasks,
  latestCompletedClientTask,
  taskClientStatus
} from '../public/client-data.js';

function task(id, status, overrides = {}) {
  return {
    id,
    phaseId: 'phase-a',
    title: `任务 ${id}`,
    status,
    planning: { phaseId: 'phase-a', phase: '功能 A', commitment: 'COMMITTED' },
    scheduledFor: '2026-08-28',
    ...overrides
  };
}

test('customer status mapping hides control-plane detail behind four active states and archive', () => {
  assert.equal(taskClientStatus(task('tentative', 'PLANNED', { planning: { commitment: 'TENTATIVE' } })), 'pending');
  assert.equal(taskClientStatus(task('deferred', 'DEFERRED')), 'pending');
  assert.equal(taskClientStatus(task('planned', 'PLANNED')), 'scheduled');
  assert.equal(taskClientStatus(task('ready', 'READY')), 'scheduled');
  assert.equal(taskClientStatus(task('running', 'RUNNING')), 'running');
  assert.equal(taskClientStatus(task('review', 'REVIEW')), 'review');
  assert.equal(taskClientStatus(task('verified', 'VERIFIED')), 'completed');
  assert.equal(taskClientStatus(task('released', 'RELEASED')), 'completed');
  assert.equal(taskClientStatus(task('archived', 'ARCHIVED')), 'completed');
  assert.equal(taskClientStatus(task('cancelled', 'CANCELLED')), null);
});

test('busy swimlane cells keep a stable three-card preview while preserving the full count', () => {
  const pending = Array.from({ length: 7 }, (_, index) => task(`pending-${index + 1}`, 'PLANNED', {
    planning: { phaseId: 'phase-a', phase: '功能 A', commitment: 'TENTATIVE' }
  }));
  const schedule = {
    phases: [
      { id: 'phase-b', title: '功能 B', phaseOrder: 2, tasks: [task('done', 'VERIFIED', { phaseId: 'phase-b' })] },
      { id: 'phase-a', title: '功能 A', phaseOrder: 1, tasks: pending }
    ]
  };

  const board = buildClientBoard(schedule);
  const cell = board.rows[0].cells.pending;

  assert.deepEqual(board.phases.map((phase) => phase.id), ['phase-a', 'phase-b']);
  assert.equal(cell.total, 7);
  assert.equal(cell.preview.length, MAX_CELL_PREVIEW);
  assert.equal(cell.tasks.length, 7);
  assert.equal(board.completed.length, 1);
});

test('shared board drag policy allows every active card to move in all directions and across phases', () => {
  const pending = task('pending', 'PLANNED', { planning: { phaseId: 'phase-a', commitment: 'TENTATIVE' } });
  const scheduled = task('scheduled', 'PLANNED');
  const running = task('running', 'RUNNING');
  const review = task('review', 'REVIEW');
  const targets = ['pending', 'scheduled', 'running', 'review'];

  assert.deepEqual(clientMoveTargets(pending), targets);
  assert.deepEqual(clientMoveTargets(scheduled), targets);
  assert.deepEqual(clientMoveTargets(running), targets);
  assert.deepEqual(clientMoveTargets(review), targets);
  assert.deepEqual(clientMoveTargets(task('done', 'VERIFIED')), []);
  assert.equal(canClientMoveTask(pending, { phaseId: 'phase-a', statusId: 'pending' }), false);
  assert.equal(canClientMoveTask(pending, { phaseId: 'phase-a', statusId: 'scheduled' }), true);
  assert.equal(canClientMoveTask(pending, { phaseId: 'phase-a', statusId: 'running' }), true);
  assert.equal(canClientMoveTask(pending, { phaseId: 'phase-b', statusId: 'scheduled' }), true);
  assert.equal(canClientMoveTask(scheduled, { phaseId: 'phase-b', statusId: 'scheduled' }), true);
  assert.equal(canClientMoveTask(review, { phaseId: 'phase-b', statusId: 'pending' }), true);
});

test('shared board placement persists status and phase while reconciling active Runs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-client-board-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createService(join(directory, 'state.json'));
  const project = await service.createProject({ name: 'Shared customer board' });
  const firstPhase = await service.createPhase({ projectId: project.id, title: 'Intake', phaseOrder: 1 });
  const secondPhase = await service.createPhase({ projectId: project.id, title: 'Delivery', phaseOrder: 2 });
  const item = await service.createWorkItem(serviceTaskInput(project.id, firstPhase.id, 'Movable task', 1));
  const options = (idempotencyKey) => ({
    actor: 'owner',
    client: 'web',
    idempotencyKey,
    source: { kind: 'customer-board' }
  });

  let schedule = await service.getSchedule(project.id);
  let moved = await service.moveWorkItemOnClientBoard(item.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    phaseId: secondPhase.id,
    statusId: 'running'
  }, options('move-running'));
  assert.equal(moved.status, 'RUNNING');
  assert.equal(moved.phaseId, secondPhase.id);
  assert.equal(moved.planning.commitment, 'COMMITTED');

  schedule = await service.getSchedule(project.id);
  moved = await service.moveWorkItemOnClientBoard(item.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    phaseId: secondPhase.id,
    statusId: 'review'
  }, options('move-review'));
  assert.equal(moved.status, 'REVIEW');

  schedule = await service.getSchedule(project.id);
  moved = await service.moveWorkItemOnClientBoard(item.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    phaseId: firstPhase.id,
    statusId: 'pending'
  }, options('move-pending'));
  assert.equal(moved.status, 'PLANNED');
  assert.equal(moved.phaseId, firstPhase.id);
  assert.equal(moved.planning.commitment, 'TENTATIVE');

  schedule = await service.getSchedule(project.id);
  moved = await service.moveWorkItemOnClientBoard(item.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    phaseId: firstPhase.id,
    statusId: 'scheduled'
  }, options('move-scheduled'));
  assert.equal(moved.status, 'PLANNED');
  assert.equal(moved.planning.commitment, 'COMMITTED');

  await assert.rejects(
    service.moveWorkItemOnClientBoard(item.id, {
      expectedScheduleVersion: schedule.scheduleVersion,
      phaseId: firstPhase.id,
      statusId: 'running'
    }, options('stale-move')),
    (error) => error.code === 'SCHEDULE_VERSION_CONFLICT'
  );

  const claimed = await service.createWorkItem(serviceTaskInput(project.id, firstPhase.id, 'Claimed task', 2));
  const started = await service.startTask(claimed.id, {
    agentId: 'agent-a',
    executor: 'codex',
    modelRef: 'gpt-5'
  }, options('start-claimed'));
  schedule = await service.getSchedule(project.id);
  moved = await service.moveWorkItemOnClientBoard(claimed.id, {
    expectedScheduleVersion: schedule.scheduleVersion,
    phaseId: secondPhase.id,
    statusId: 'scheduled'
  }, options('release-claimed'));
  assert.equal(moved.status, 'PLANNED');
  assert.equal(moved.currentRunId, null);
  const releasedRun = await service.getRun(started.run.id);
  assert.equal(releasedRun.status, 'CANCELLED');
  assert.equal(releasedRun.releaseReason, 'CLIENT_BOARD_MOVE');
  assert.equal(releasedRun.events.at(-1).type, 'run.client_board_released');
});

test('drawer and archive filters retain searchable, due-date, phase and completion semantics', () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const tasks = [
    task('overdue', 'PLANNED', { title: '样本接收', scheduledFor: '2026-08-20' }),
    task('this-week', 'PLANNED', { title: '报告签发', phaseId: 'phase-b', scheduledFor: '2026-08-30' }),
    task('released', 'RELEASED', {
      title: '客户验收',
      effectiveStatus: 'RELEASED',
      latestCompletion: { completedAt: '2026-08-25T09:00:00Z' }
    })
  ];

  assert.deepEqual(filterClientTasks(tasks, { due: 'overdue', now }).map(({ id }) => id), ['overdue']);
  assert.deepEqual(filterClientTasks(tasks, { query: '报告', phaseId: 'phase-b', now }).map(({ id }) => id), ['this-week']);
  assert.deepEqual(filterClientTasks(tasks, { completionStatus: 'RELEASED', range: 'week', now }).map(({ id }) => id), ['released']);
  assert.equal(groupCompletedTasks([tasks[2]], now)[0].label, '本周');
});

test('customer progress uses the project current task to identify the real active phase', () => {
  const schedule = {
    project: { currentTaskId: 'current-task' },
    phases: [
      { id: 'phase-old', phaseOrder: 1, computedStatus: 'PLANNED', tasks: [task('old-task', 'PLANNED')] },
      { id: 'phase-current', phaseOrder: 2, computedStatus: 'ACTIVE', tasks: [task('current-task', 'PLANNED')] }
    ]
  };

  assert.equal(currentClientPhase(schedule)?.id, 'phase-current');
});

test('customer progress selects the most recently completed task as the latest delivery', () => {
  const tasks = [
    task('earlier', 'VERIFIED', { latestCompletion: { completedAt: '2026-08-20T09:00:00Z' } }),
    task('latest', 'RELEASED', { latestCompletion: { completedAt: '2026-08-25T09:00:00Z' } }),
    task('open', 'RUNNING', { updatedAt: '2026-08-26T09:00:00Z' })
  ];

  assert.equal(latestCompletedClientTask(tasks)?.id, 'latest');
});

test('customer board ships as an isolated, capacity-safe surface with an owner entry point', async () => {
  const [html, css, client, canvasHtml, canvasCss, canvasClient, index, app] = await Promise.all([
    readFile(new URL('../public/client.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/client.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/client.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/canvas.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/canvas.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/canvas.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="taskDrawer"/);
  assert.match(html, /id="requestDialog"/);
  assert.match(html, /id="moveTaskDialog"/);
  assert.match(html, /id="moveTaskPhase"/);
  assert.match(html, /id="moveTaskStatus"/);
  assert.doesNotMatch(html, /id="scheduleConfirmDialog"/);
  assert.match(html, /type="module" src="\/client\.js"/);
  assert.match(css, /--lane-height:\s*252px/);
  assert.match(css, /--lane-collapsed-height:\s*54px/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /grid-template-columns:\s*132px repeat\(4, minmax\(218px, 1fr\)\)/);
  assert.match(css, /\.lane-cell\.has-overflow/);
  assert.match(css, /\.lane-cell\.is-collapsed/);
  assert.doesNotMatch(css, /\.task-drawer\.expanded|\.drawer-expand|\.drawer-footer|\.shared-view-label/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(client, /const hasOverflow = cell\.total > cell\.preview\.length/);
  assert.match(client, /查看全部 \$\{cell\.total\} 项/);
  assert.match(client, /\/client-board/);
  assert.match(client, /await moveClientTask\(task, target\)/);
  assert.match(client, /activeClientDropTarget\(\)/);
  assert.match(client, /updateClientDragAutoScroll\(event\)/);
  assert.match(client, /data-client-move-task/);
  assert.match(client, /event\.detail > 0 && Date\.now\(\) < state\.suppressMoveClickUntil/);
  assert.match(client, /beginPointerTaskDrag/);
  assert.match(client, /openMoveTaskDialog/);
  assert.match(client, /elements\.moveTaskForm\.addEventListener\('submit', submitMoveTask\)/);
  assert.match(css, /\.task-move-handle[\s\S]*?touch-action:\s*none/);
  assert.match(css, /\.client-touch-drag-ghost/);
  assert.match(client, /captureClientViewState\(\)/);
  assert.match(client, /restoreClientViewState\(viewState\)/);
  assert.match(client, /boardScrollLeft: viewport\?\.scrollLeft/);
  assert.match(client, /boardScrollTop: viewport\?\.scrollTop/);
  assert.match(client, /loadSelectedProject\(\{ quiet: true, viewState \}\)/);
  assert.match(client, /data-toggle-lane/);
  assert.match(client, /data-toggle-all-lanes/);
  assert.match(client, /lifeline:client-board:collapsed:/);
  assert.match(client, /data-confirm-task/);
  assert.match(client, /data-request-changes/);
  assert.match(client, /data-client-draggable/);
  assert.match(client, /canClientMoveTask/);
  assert.match(client, /data-view-archive/);
  assert.doesNotMatch(client, /<div class="cell-empty">暂无任务<\/div>/);
  assert.doesNotMatch(client, /renderCollaborationRail|待您处理/);
  assert.doesNotMatch(css, /\.collaboration-rail|\.cell-empty/);
  assert.doesNotMatch(client, /data-expand-drawer|expanded:\s*false/);
  assert.doesNotMatch(html, /data-nav-section/);
  assert.match(html, /class="active" id="projectProgressNavLink" href="\/client\.html" aria-current="page">项目进度<\/a>/);
  assert.doesNotMatch(client, /setActiveNavSection|syncClientNavigation/);
  assert.doesNotMatch(html, />文件<\/button>/);
  assert.match(html, /id="canvasNavLink"/);
  assert.match(client, /\/canvas\.html/);
  assert.match(client, /\['overview', 'tasks', 'timeline'\]\.includes\(section\) \? section : null/);
  assert.match(canvasHtml, /id="projectProgressNavLink" href="\/client\.html">项目进度/);
  assert.match(canvasHtml, /class="active" id="canvasNavLink" href="\/canvas\.html" aria-current="page">协作画布/);
  assert.match(canvasHtml, /id="canvasFrame"/);
  assert.match(canvasHtml, /referrerpolicy="no-referrer"/);
  assert.match(canvasCss, /body\.canvas-shell[\s\S]*?overflow: hidden/);
  assert.match(canvasCss, /\.canvas-stage[\s\S]*?flex: 1 1 auto/);
  assert.match(canvasClient, /\/canvas-session/);
  assert.match(canvasClient, /querySelector\('#canvas'\)/);
  assert.match(canvasClient, /elements\.projectProgressNavLink\.href/);
  assert.doesNotMatch(canvasClient, /data-client-section/);
  assert.doesNotMatch(`${canvasHtml}\n${canvasClient}`, /模型|评分|推荐|算力/);
  assert.match(client, /class="progress-briefing"/);
  assert.match(client, /currentClientPhase\(state\.schedule\)/);
  assert.match(client, /latestCompletedClientTask\(state\.board\.allTasks\)/);
  assert.match(client, /data-locate-phase/);
  assert.match(client, /data-current-milestone/);
  assert.match(client, /已延期/);
  assert.match(client, /alignCurrentMilestone/);
  assert.match(client, /locateBoardPhase/);
  assert.match(css, /\.lane-cell\.is-phase-located/);
  assert.match(index, /id="clientViewLink"/);
  assert.match(app, /client\.html\?project=/);
  assert.doesNotMatch(`${html}\n${client}`, /模型|评分|推荐|算力/);
  assert.doesNotMatch(
    `${html}\n${client}\n${canvasHtml}\n${canvasClient}`,
    /共享项目视图|多人实时共享|提交到当前项目|加载完成后即可直接共同绘图|日期待定|日期待确认|尚未补充验收标准|当前没有可展示的验收记录|等待补充说明|范围已确认|范围待确认|未进入验收/
  );
});

function serviceTaskInput(projectId, phaseId, title, taskOrder) {
  return {
    projectId,
    phaseId,
    title,
    objective: `Move ${title} through the shared client board with persisted state.`,
    acceptanceCriteria: [`${title} remains visible after a schedule refresh`],
    testCommands: ['node --test test/client-board.test.js'],
    riskTier: 'low',
    resourceProfile: { cpu: 1, memoryGb: 1, apiBudgetUsd: 0, humanReviewMinutes: 1 },
    planning: {
      phaseId,
      phase: 'Client board',
      phaseOrder: 1,
      taskOrder,
      kind: 'feature',
      priority: 'P1',
      commitment: 'COMMITTED'
    }
  };
}

async function createService(file) {
  const service = new LifelineService({
    store: new JsonStore(file),
    localUserId: 'local-owner'
  });
  await service.start();
  return service;
}
