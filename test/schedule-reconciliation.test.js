import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileLifelineSchedule } from '../scripts/reconcile-lifeline-schedule.mjs';

test('reconciles historical completion times, run records, verified work, and the production phase idempotently', () => {
  const state = fixture();
  const at = '2026-08-02T17:00:00.000Z';
  const first = reconcileLifelineSchedule(state, at);

  assert.equal(first.changed, true);
  assert.equal(state.projects[0].scheduleVersion, 4);
  assert.equal(state.completionRecords[0].completedAt, '2026-08-01T14:44:07.000Z');
  assert.equal(state.completionRecords.some((record) => record.runId === 'run-latest'), true);
  assert.equal(state.workItems.find((task) => task.title === '让项目价值更清晰，创建入口更简单').status, 'VERIFIED');
  const currentTask = state.workItems.find((task) => task.title === '固定项目栏、稳定筛选、当前节点居中');
  assert.equal(currentTask.status, 'VERIFIED');
  assert.equal(state.projects[0].currentTaskId, currentTask.id);
  assert.equal(state.workItems.find((task) => task.title === '补齐扫描提案与指纹去重 MCP').status, 'PLANNED');
  assert.equal(state.workItems.find((task) => task.title === '修复旧数据载入与前后端版本不一致报错').status, 'CANCELLED');
  assert.equal(state.workItems.find((task) => task.title === '接入 Streamable HTTP、OAuth 与多用户隔离').status, 'DEFERRED');
  assert.equal(state.workItems.find((task) => task.title === '周期扫描仓库并去重生成 Bug 候选').status, 'RECURRING');
  assert.equal(state.phases.some((phase) => phase.title === 'S6 生产化与可靠发布'), true);
  assert.equal(state.workItems.filter((task) => Number(task.planning.phaseOrder) === 6).length, 4);
  assert.equal(state.workItems.filter((task) => Number(task.planning.phaseOrder) === 6).every((task) => task.status === 'DEFERRED'), true);
  assert.equal(state.workItems.some((task) => task.status === 'REVIEW'), false);
  assert.equal(state.events.at(-1).type, 'schedule.reconciled');

  const snapshot = JSON.stringify(state);
  const second = reconcileLifelineSchedule(state, at);
  assert.equal(second.changed, false);
  assert.equal(JSON.stringify(state), snapshot);
});

function fixture() {
  return {
    projects: [{
      id: 'project-lifeline',
      name: 'Lifeline',
      status: 'ACTIVE',
      templateKey: 'portfolio-v2-real-projects',
      templateVersion: '2026-08-01.1',
      scheduleVersion: 3
    }],
    phases: [1, 2, 3, 4, 5].map((order) => ({
      id: `phase-${order}`,
      projectId: 'project-lifeline',
      title: `S${order}`,
      phaseOrder: order,
      rank: order * 1024,
      status: 'ACTIVE'
    })),
    workItems: [
      task('history', '明确控制平面优先的产品边界与 ADR', 1, 1, 'VERIFIED'),
      task('run-task', '周期扫描仓库 Bug 并回填待处理任务', 5, 3, 'VERIFIED'),
      task('copy', '产品化项目文案并合并创建入口', 2, 4, 'PLANNED'),
      task('stable-ui', '固定项目栏、稳定筛选、当前节点居中', 3, 1, 'PLANNED'),
      task('scan-mcp', '提供扫描提案、完成证据与审计 MCP', 4, 2, 'PLANNED')
    ],
    runs: [{
      id: 'run-latest',
      workItemId: 'run-task',
      executor: 'mock',
      status: 'SUCCEEDED',
      startedAt: '2026-08-02T12:21:22.783Z',
      finishedAt: '2026-08-02T12:21:23.807Z'
    }],
    evidence: [
      { id: 'test-evidence', runId: 'run-latest', workItemId: 'run-task', type: 'TEST', score: 0.6 },
      { id: 'review-evidence', runId: 'run-latest', workItemId: 'run-task', type: 'REVIEW', score: 0.8 }
    ],
    completionRecords: [{
      id: 'history-completion',
      taskId: 'history',
      workItemId: 'history',
      completionMethod: 'IMPORTED_HISTORY',
      commitSha: '5fb358b',
      startedAt: '2026-08-02T16:07:15.714Z',
      completedAt: '2026-08-02T16:07:15.714Z'
    }],
    events: []
  };
}

function task(id, title, phaseOrder, taskOrder, status) {
  return {
    id,
    projectId: 'project-lifeline',
    phaseId: `phase-${phaseOrder}`,
    title,
    objective: `${title} objective`,
    status,
    planning: {
      phase: `S${phaseOrder}`,
      phaseId: `phase-${phaseOrder}`,
      phaseOrder,
      taskOrder,
      kind: 'feature',
      priority: 'P1',
      commitment: 'TENTATIVE'
    }
  };
}
