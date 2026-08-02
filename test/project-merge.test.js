import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLifelineProjects } from '../scripts/merge-lifeline-projects.mjs';

test('merges unique legacy Lifeline tasks and archives the duplicate project', () => {
  const state = fixture();
  const result = mergeLifelineProjects(state);

  assert.equal(result.changed, true);
  assert.equal(result.targetProjectId, 'target');
  assert.deepEqual(result.movedTaskIds, ['legacy-unique']);
  assert.deepEqual(result.skippedTaskIds, ['legacy-duplicate']);
  assert.deepEqual(result.cleanedTaskIds, ['seed-duplicate']);
  assert.deepEqual(result.archivedDemoProjectIds, ['release-demo']);
  assert.equal(state.projects.find((project) => project.id === 'source').status, 'ARCHIVED');
  assert.equal(state.projects.find((project) => project.id === 'release-demo').status, 'ARCHIVED');
  assert.equal(state.workItems.find((task) => task.id === 'seed-duplicate').status, 'CANCELLED');
  assert.equal(state.workItems.find((task) => task.id === 'legacy-unique').projectId, 'target');
  assert.equal(state.workItems.find((task) => task.id === 'legacy-unique').phaseId, 'phase-2');
  assert.equal(state.runs[0].workItemId, 'legacy-unique');
  assert.equal(state.projects.find((project) => project.id === 'target').scheduleVersion, 1);
  assert.equal(state.events.at(-1).type, 'project.merged');

  const repeated = mergeLifelineProjects(state);
  assert.equal(repeated.changed, false);
});

function fixture() {
  return {
    projects: [
      { id: 'source', name: 'Lifeline', status: 'ACTIVE', scheduleVersion: 12 },
      { id: 'target', name: 'Lifeline', status: 'ACTIVE', scheduleVersion: 0, templateKey: 'portfolio-v2-real-projects' },
      { id: 'echo', name: 'EchoMe', status: 'ACTIVE' },
      { id: 'release-demo', name: 'Release Radar · 示例', status: 'ACTIVE' }
    ],
    phases: [
      { id: 'phase-1', projectId: 'target', title: 'S1', phaseOrder: 1, status: 'COMPLETED' },
      { id: 'phase-2', projectId: 'target', title: 'S2', phaseOrder: 2, status: 'ACTIVE' },
      { id: 'phase-3', projectId: 'target', title: 'S3', phaseOrder: 3, status: 'ACTIVE' },
      { id: 'phase-5', projectId: 'target', title: 'S5', phaseOrder: 5, status: 'ACTIVE' }
    ],
    workItems: [
      task('target-duplicate', 'target', 'phase-2', '实现 Project × Phase × Task 组合大板', 2, 1),
      task('seed-duplicate', 'target', 'phase-seed', '实现纵向项目、横向阶段的推进总览', 2, 2),
      task('legacy-duplicate', 'source', 'legacy-phase', '实现纵向项目、横向阶段的推进总览', 2, 1),
      task('legacy-unique', 'source', 'legacy-phase', '确定 Project × Phase × Task 两级模型', 1, 2)
    ],
    runs: [{ id: 'run-1', workItemId: 'legacy-unique' }],
    migrationConflicts: [],
    events: []
  };
}

function task(id, projectId, phaseId, title, phaseOrder, taskOrder) {
  return {
    id,
    projectId,
    phaseId,
    title,
    status: 'PLANNED',
    planning: { phaseId, phase: 'Legacy', phaseOrder, taskOrder }
  };
}
